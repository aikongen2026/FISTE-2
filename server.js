const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
let PNG = null;
function pngParser(){ if(!PNG) ({PNG}=require('pngjs')); return PNG; }
const PACKAGE = require('./package.json');
const APP_REVISION = 'STABLE 1.2';

const PORT = Number(process.env.PORT || 3000);
const NVE_API_KEY = String(process.env.NVE_API_KEY || '').trim();
const MET_USER_AGENT = process.env.MET_USER_AGENT || 'vestfjella-fiske/1.2 (Fiste freshwater core)';
const PUBLIC_DIR = path.join(__dirname, 'public');
const OPEN_LURE_PHOTOS = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'lures','open','catalog.json'),'utf8')).photos;
const OPEN_LURE_PHOTO_BY_ID = Object.freeze(Object.fromEntries(OPEN_LURE_PHOTOS.map(photo=>[photo.id,photo])));
const USER_LURE_DATA = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'data','user-lures.json'),'utf8'));
const VESTFJELLA_WATERS = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'data','vestfjella-waters.json'),'utf8'));
const VESTFJELLA_BOUNDS = Object.freeze({west:11.5700,south:59.2370,east:11.6065,north:59.2915});
const SOURCE_BACKED_LURE_DATA = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'data','source-backed-lures.json'),'utf8'));
const SOURCE_BACKED_LURES = Object.freeze(SOURCE_BACKED_LURE_DATA.lures);
const OFFICIAL_NO_FISHING_ZONES = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'data','fishing-restrictions-2024.json'),'utf8')).zones;
const MAX_ZONE_COUNT = 12;
const MAX_ZONE_CANDIDATES = 180;
const FISH_TYPES = Object.freeze({
  sjoorret:'Sjøørret', makrell:'Makrell', sei:'Sei',
  orret:'Ørret (ferskvann)', abbor:'Abbor', gjedde:'Gjedde'
});
const FRESHWATER_FISH_TYPES = new Set(['orret','abbor','gjedde']);
const VESTFJELLA_FLY_ONLY = new Set(['saetertjern','setertjern','midtre ormtjern','stubbetjern','skogtjern 2']);
function normalizeWaterName(value=''){ return String(value||'').toLowerCase().replace(/æ/g,'ae').replace(/ø/g,'o').replace(/å/g,'a').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
function isVestfjellaFlyOnly(name=''){ return VESTFJELLA_FLY_ONLY.has(normalizeWaterName(name)); }

function normalizeWaterLookupName(value='') {
  return normalizeWaterName(value)
    .replace(/tjernene\b/g,'tjern')
    .replace(/tjernet\b/g,'tjern')
    .replace(/vannet\b/g,'vann')
    .replace(/vanna\b/g,'vann')
    .replace(/vatnet\b/g,'vann')
    .replace(/\b(ovre|nedre|midtre|vestre|ostre|nordre|sondre)\b/g,match=>match)
    .replace(/\s+/g,' ').trim();
}
function waterNameSimilarity(a='',b='') {
  const x=normalizeWaterLookupName(a),y=normalizeWaterLookupName(b);
  if(!x||!y) return 0;
  if(x===y) return 100;
  if(x.includes(y)||y.includes(x)) return 80-Math.min(20,Math.abs(x.length-y.length));
  const xa=new Set(x.split(' ')),ya=new Set(y.split(' '));
  const overlap=[...xa].filter(t=>ya.has(t)).length;
  return overlap ? Math.round(50*overlap/Math.max(xa.size,ya.size)) : 0;
}
function freshwaterAreaBounds(area) {
  const ring=area?.ring||[];
  if(!ring.length) return null;
  const lats=ring.map(p=>Number(p.lat)).filter(Number.isFinite),lons=ring.map(p=>Number(p.lon)).filter(Number.isFinite);
  if(!lats.length||!lons.length) return null;
  return {south:Math.min(...lats),north:Math.max(...lats),west:Math.min(...lons),east:Math.max(...lons)};
}
function freshwaterAreaFocus(area) {
  const bounds=freshwaterAreaBounds(area);
  if(!bounds) return null;
  let lat=(bounds.south+bounds.north)/2,lon=(bounds.west+bounds.east)/2;
  if(!pointIsInFreshwaterArea(lat,lon,area)) {
    const candidates=freshwaterCandidateGrid([area],bounds);
    if(candidates.length){lat=candidates[0].lat;lon=candidates[0].lon;}
    else if(area.ring?.[0]){lat=area.ring[0].lat;lon=area.ring[0].lon;}
  }
  return {lat,lon,bounds};
}
function freshwaterAreaApproxM2(area) {
  const ring=area?.ring||[];
  if(ring.length<3) return null;
  const lat0=ring.reduce((sum,p)=>sum+Number(p.lat||0),0)/ring.length*Math.PI/180;
  const lon0=ring.reduce((sum,p)=>sum+Number(p.lon||0),0)/ring.length;
  const latRef=ring.reduce((sum,p)=>sum+Number(p.lat||0),0)/ring.length;
  const pts=ring.map(p=>({x:(Number(p.lon)-lon0)*111320*Math.cos(lat0),y:(Number(p.lat)-latRef)*110540}));
  let sum=0;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++) sum+=pts[j].x*pts[i].y-pts[i].x*pts[j].y;
  const polygonArea=Math.abs(sum)/2;
  return Number.isFinite(polygonArea)&&polygonArea>0?Math.round(polygonArea):null;
}
function directoryWaterMatch(name='') {
  let best=null,bestScore=0;
  for(const item of VESTFJELLA_WATERS.waters||[]) {
    const candidates=[item.name,...(Array.isArray(item.mapAliases)?item.mapAliases:[])];
    for(const candidate of candidates){
      const score=waterNameSimilarity(name,candidate);
      if(score>bestScore){best=item;bestScore=score;}
    }
  }
  return bestScore>=50?{item:best,score:bestScore}:null;
}
function sourceKnowledgeAdjustment(waterName,fishType,goal='numbers') {
  const match=directoryWaterMatch(waterName);
  if(!match) return {delta:0,profile:null,mismatch:false};
  const item=match.item;
  const species=Array.isArray(item.species)?item.species:[];
  const hasEvidence=species.length>0;
  const mismatch=hasEvidence&&!species.includes(fishType);
  let delta=0;
  if(hasEvidence){ delta += mismatch?-28:4; }
  if(!mismatch&&goal==='big') {
    if(item.trophyPotential==='very_high') delta+=8;
    else if(item.trophyPotential==='high') delta+=5;
    else if(item.trophyPotential==='medium_high') delta+=3;
  }
  if(!mismatch&&goal==='numbers'&&item.abundance==='high') delta+=4;
  if(!mismatch&&item.hiddenGem&&goal==='big') delta+=2;
  return {delta,profile:item,mismatch};
}
function matchFreshwaterAreaByName(name,areas=[]) {
  let best=null,bestScore=0;
  for(const area of areas){
    if(!area?.name||area.name==='Navnløst vann') continue;
    const score=waterNameSimilarity(name,area.name);
    if(score>bestScore){best=area;bestScore=score;}
  }
  return bestScore>=50?{area:best,score:bestScore}:null;
}
async function searchNominatimWaterByName(name) {
  const params=new URLSearchParams({format:'jsonv2',q:`${name}, Aremark, Norway`,limit:'8',addressdetails:'0',extratags:'1',bounded:'1',viewbox:`${VESTFJELLA_BOUNDS.west},${VESTFJELLA_BOUNDS.north},${VESTFJELLA_BOUNDS.east},${VESTFJELLA_BOUNDS.south}`});
  const data=await getJsonHttps(`https://nominatim.openstreetmap.org/search?${params}`,10000);
  if(!Array.isArray(data)) return null;
  let best=null,bestScore=0;
  for(const item of data){
    const candidateName=item.name||String(item.display_name||'').split(',')[0];
    const score=waterNameSimilarity(name,candidateName);
    if(score>bestScore){best=item;bestScore=score;}
  }
  if(!best||bestScore<45) return null;
  const bbox=Array.isArray(best.boundingbox)?best.boundingbox.map(Number):null;
  const lat=Number(best.lat),lon=Number(best.lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return null;
  const bounds=bbox&&bbox.length===4&&bbox.every(Number.isFinite)?{south:bbox[0],north:bbox[1],west:bbox[2],east:bbox[3]}:{south:lat-.001,north:lat+.001,west:lon-.001,east:lon+.001};
  return {name:best.name||String(best.display_name||'').split(',')[0]||name,lat,lon,bounds,source:'OpenStreetMap Nominatim'};
}
async function locateVestfjellaWater(name) {
  const directoryMatch=directoryWaterMatch(name);
  const profile=directoryMatch?.item||null;
  const candidates=[name,...(profile?.mapAliases||[])].filter(Boolean);
  const key=`vestfjella-water-locate:${candidates.map(normalizeWaterLookupName).join('|')}`;
  return cached(key,6*60*60*1000,async()=>{
    try{
      const areas=await fetchFreshwaterAreas(VESTFJELLA_BOUNDS);
      let best=null;
      for(const candidate of candidates){
        const match=matchFreshwaterAreaByName(candidate,areas);
        if(match&&(!best||match.score>best.score)) best={...match,candidate};
      }
      if(best){
        const focus=freshwaterAreaFocus(best.area);
        const areaM2=freshwaterAreaApproxM2(best.area);
        if(focus) return {requestedName:name,name:best.area.name,lat:focus.lat,lon:focus.lon,bounds:focus.bounds,source:'OpenStreetMap vannpolygon',matchScore:best.score,matchedAlias:best.candidate!==name?best.candidate:null,areaM2Approx:areaM2,areaDaaApprox:Number.isFinite(areaM2)?Number((areaM2/1000).toFixed(1)):null};
      }
    }catch{}
    for(const candidate of candidates){
      const found=await searchNominatimWaterByName(candidate);
      if(found) return {...found,requestedName:name,matchedAlias:candidate!==name?candidate:null};
    }
    return null;
  });
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function angularDistance(a, b) { return Math.abs((((a - b) % 360) + 540) % 360 - 180); }
function normalizeFishType(value = 'sjoorret') {
  const fishType = String(value || 'sjoorret').trim().toLowerCase();
  if (!Object.hasOwn(FISH_TYPES, fishType)) throw new Error('Ugyldig fisketype. Velg en art fra listen.');
  return fishType;
}
function normalizeFishSelection(value='sjoorret'){
  const selection=String(value||'sjoorret').trim().toLowerCase();
  if(selection==='all') return 'all';
  return normalizeFishType(selection);
}
function isFreshwaterFish(value) { return FRESHWATER_FISH_TYPES.has(normalizeFishType(value)); }
function searchBoundsForBase(lat,lon,radiusM,zoom=14){
  const radius=clamp(Number(radiusM)||0,100,10000);
  const padding=Math.max(radius*1.12,350);
  const latPad=padding/110540;
  const lonPad=padding/(111320*Math.max(.2,Math.cos(lat*Math.PI/180)));
  return {west:lon-lonPad,south:lat-latPad,east:lon+lonPad,north:lat+latPad,zoom:radius<=250?16:radius<=500?15:radius<=1000?14:13};
}
function distanceMeters(aLat,aLon,bLat,bLon){ const R=6371000,toRad=Math.PI/180,dLat=(bLat-aLat)*toRad,dLon=(bLon-aLon)*toRad,sa=Math.sin(dLat/2),so=Math.sin(dLon/2),h=sa*sa+Math.cos(aLat*toRad)*Math.cos(bLat*toRad)*so*so; return 2*R*Math.asin(Math.min(1,Math.sqrt(h))); }
function normalizeGoal(value='numbers'){ return String(value||'numbers').toLowerCase()==='big'?'big':'numbers'; }

function localDistanceToSegmentM(lat,lon,a,b) {
  const meanLat=(lat+a.lat+b.lat)/3*Math.PI/180;
  const sx=111320*Math.cos(meanLat), sy=110540;
  const px=lon*sx,py=lat*sy,ax=a.lon*sx,ay=a.lat*sy,bx=b.lon*sx,by=b.lat*sy;
  const dx=bx-ax,dy=by-ay,denom=dx*dx+dy*dy;
  const t=denom?clamp(((px-ax)*dx+(py-ay)*dy)/denom,0,1):0;
  return Math.hypot(px-(ax+t*dx),py-(ay+t*dy));
}

function isNearOfficialNoFishingZone(lat,lon) {
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return false;
  return OFFICIAL_NO_FISHING_ZONES.some(zone=>{
    if(!zone.renderBoundary||zone.outerBoundary.length<2) return false;
    const buffer=Math.max(160,Math.min(900,zone.lengthM*.55));
    return localDistanceToSegmentM(lat,lon,zone.outerBoundary[0],zone.outerBoundary.at(-1))<=buffer;
  });
}

function createBoundedCache({ maxEntries = 220, now = Date.now } = {}) {
  const entries = new Map();
  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) { entries.delete(key); return undefined; }
    entries.delete(key); entries.set(key, entry);
    return entry.value;
  }
  function set(key, value, ttlMs) {
    entries.delete(key);
    entries.set(key, { value, expiresAt: now() + Math.max(1, ttlMs) });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return value;
  }
  return { get, set, delete: key => entries.delete(key), clear: () => entries.clear(), size: () => entries.size };
}

const cache = createBoundedCache();
async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await producer();
  cache.set(key, value, ttlMs);
  return value;
}

function windExposure(windFromDirection, coastNormalDirection) {
  if (!Number.isFinite(windFromDirection) || !Number.isFinite(coastNormalDirection)) return 0.5;
  const distance = angularDistance(windFromDirection, coastNormalDirection);
  return clamp((1 + Math.cos(distance * Math.PI / 180)) / 2, 0, 1);
}

function moonInfo(date = new Date()) {
  const instant = date instanceof Date ? date : new Date(date);
  const synodicDays = 29.53058867;
  const knownNewMoon = Date.UTC(2000,0,6,18,14,0);
  const ageDays = (((instant.getTime() - knownNewMoon) / 86400000) % synodicDays + synodicDays) % synodicDays;
  const phase = ageDays / synodicDays;
  const illumination = (1 - Math.cos(phase * Math.PI * 2)) / 2;
  const labels = [
    [0.03,'Nymåne'],[0.22,'Voksende sigd'],[0.28,'Første kvarter'],[0.47,'Voksende måne'],
    [0.53,'Fullmåne'],[0.72,'Avtagende måne'],[0.78,'Siste kvarter'],[0.97,'Avtagende sigd'],[1.01,'Nymåne']
  ];
  const label = labels.find(([limit]) => phase < limit)?.[1] || 'Månefase';
  return { ageDays:Number(ageDays.toFixed(1)), phase:Number(phase.toFixed(3)), illumination:Number(illumination.toFixed(2)), illuminationPct:Math.round(illumination*100), label, weight:'svak tilleggsfaktor' };
}

function environmentalScoreAdjustments(fishType, input = {}) {
  const result = {};
  const pressureTrend = Number(input.pressureTrend);
  if (Number.isFinite(pressureTrend)) result.lufttrykk = pressureTrend <= -1.5 ? 2 : pressureTrend <= 1.5 ? 1 : pressureTrend >= 4 ? -2 : 0;
  const moon = Number(input.moonIllumination);
  if (Number.isFinite(moon)) result.maane = moon >= 0.18 && moon <= 0.82 ? 1 : 0;
  if (FRESHWATER_FISH_TYPES.has(fishType)) return result;

  const seaTemp = Number(input.seaTemp);
  if (Number.isFinite(seaTemp)) {
    if (fishType === 'makrell') result.sjoetemperatur = seaTemp >= 12 && seaTemp <= 22 ? 4 : seaTemp >= 9 && seaTemp <= 24 ? 1 : -3;
    else if (fishType === 'sei') result.sjoetemperatur = seaTemp >= 6 && seaTemp <= 16 ? 3 : seaTemp >= 3 && seaTemp <= 19 ? 1 : -2;
    else result.sjoetemperatur = seaTemp >= 5 && seaTemp <= 16 ? 4 : seaTemp >= 2 && seaTemp <= 18 ? 1 : -3;
  }
  const wave = Number(input.waveHeight);
  if (Number.isFinite(wave)) {
    if (fishType === 'makrell') result.boelger = wave >= 0.1 && wave <= 0.9 ? 2 : wave > 1.6 ? -3 : 0;
    else if (fishType === 'sei') result.boelger = wave >= 0.15 && wave <= 1.2 ? 2 : wave > 2 ? -3 : 0;
    else result.boelger = wave >= 0.15 && wave <= 0.9 ? 3 : wave > 1.5 ? -3 : wave < 0.05 ? -1 : 0;
  }
  const currentVelocity = Number(input.currentVelocity);
  if (Number.isFinite(currentVelocity)) result.havstroem = currentVelocity >= 0.15 && currentVelocity <= 2.5 ? (fishType === 'sei' ? 3 : 2) : currentVelocity > 4 ? -2 : 0;
  const tideTrend = Number(input.tideTrend3h);
  if (Number.isFinite(tideTrend)) result.tidevann = tideTrend >= 0.04 ? (fishType === 'sjoorret' ? 3 : 2) : tideTrend <= -0.04 ? 1 : 0;
  return result;
}

function computeScore(input = {}) {
  const fishType = normalizeFishType(input.fishType);
  const environment = environmentalScoreAdjustments(fishType,input);
  const wind = Number.isFinite(input.wind) ? input.wind : 4;
  const cloud = Number.isFinite(input.cloud) ? input.cloud : 50;
  const coastQuality = clamp(Number.isFinite(input.coastQuality) ? input.coastQuality : 0.5, 0, 1);
  const exposure = clamp(Number.isFinite(input.exposure) ? input.exposure : 0.5, 0, 1);
  const trend = Number.isFinite(input.tempTrend) ? input.tempTrend : 0;
  const hour = Number.isFinite(input.hour) ? input.hour : 12;
  const windPoints = wind >= 2 && wind <= 8 ? 20 : wind < 2 ? 9 : wind <= 11 ? 8 : 2;
  const cloudPoints = Math.round(clamp(cloud / 100, 0, 1) * 15);
  const coastPoints = Math.round(coastQuality * 20);
  const exposurePoints = Math.round(exposure * 15);
  const temperaturePoints = trend <= -0.3 ? 10 : trend <= 0.5 ? 7 : 3;
  const timePoints = (hour <= 9 || hour >= 18) ? 10 : 5;
  if (fishType === 'orret') {
    const airTemp = Number.isFinite(input.temp) ? input.temp : 10;
    const breakdown = {
      vind: wind >= 1.5 && wind <= 6.5 ? 16 : wind < 1.5 ? 10 : 5,
      skydekke: cloud >= 40 ? 14 : 8,
      vannkant: Math.round(coastQuality * 20),
      eksponering: Math.round((1 - Math.abs(exposure - 0.55)) * 14),
      lufttemperatur: airTemp >= 5 && airTemp <= 17 ? 13 : 6,
      tidspunkt: hour <= 9 || hour >= 18 ? 15 : 8,
      ...environment
    };
    return { score: clamp(8 + Object.values(breakdown).reduce((sum, value) => sum + value, 0), 0, 100), breakdown };
  }
  if (fishType === 'abbor') {
    const airTemp = Number.isFinite(input.temp) ? input.temp : 12;
    const breakdown = {
      vind: wind >= 0.5 && wind <= 5 ? 15 : 7,
      skydekke: cloud >= 25 && cloud <= 85 ? 11 : 7,
      vannkant: Math.round(coastQuality * 22),
      eksponering: Math.round((1 - exposure * 0.55) * 14),
      lufttemperatur: airTemp >= 11 ? 15 : airTemp >= 6 ? 10 : 5,
      tidspunkt: hour >= 6 && hour <= 20 ? 14 : 7,
      ...environment
    };
    return { score: clamp(8 + Object.values(breakdown).reduce((sum, value) => sum + value, 0), 0, 100), breakdown };
  }
  if (fishType === 'gjedde') {
    const airTemp = Number.isFinite(input.temp) ? input.temp : 10;
    const breakdown = {
      vind: wind >= 0.5 && wind <= 6 ? 15 : 7,
      skydekke: cloud >= 45 ? 15 : 8,
      vannkant: Math.round(coastQuality * 24),
      eksponering: Math.round((1 - exposure * 0.5) * 13),
      lufttemperatur: airTemp >= 7 && airTemp <= 20 ? 12 : 6,
      tidspunkt: hour <= 10 || hour >= 17 ? 13 : 8,
      ...environment
    };
    return { score: clamp(7 + Object.values(breakdown).reduce((sum, value) => sum + value, 0), 0, 100), breakdown };
  }
  if (fishType === 'makrell') {
    const depth = Number.isFinite(input.depthMeters) ? input.depthMeters : null;
    const breakdown = {
      vind: wind >= 2 && wind <= 9 ? 18 : wind < 2 ? 10 : 6,
      skydekke: cloud <= 75 ? 10 : 7,
      kyst: Math.round(coastQuality * 14),
      eksponering: Math.round((0.35 + exposure * 0.65) * 18),
      temperatur: trend >= -0.8 ? 7 : 4,
      tidspunkt: hour >= 6 && hour <= 20 ? 13 : 7,
      dybde: depth === null ? 7 : depth >= 5 && depth <= 35 ? 12 : 6,
      ...environment
    };
    return { score: clamp(10 + Object.values(breakdown).reduce((sum, value) => sum + value, 0), 0, 100), breakdown };
  }
  if (fishType === 'sei') {
    const depth = Number.isFinite(input.depthMeters) ? input.depthMeters : null;
    const breakdown = {
      vind: wind >= 1.5 && wind <= 9 ? 16 : 7,
      skydekke: cloud >= 35 ? 11 : 7,
      kyst: Math.round(coastQuality * 16),
      eksponering: Math.round((0.3 + exposure * 0.7) * 18),
      temperatur: trend <= 0.8 ? 8 : 5,
      tidspunkt: hour <= 9 || hour >= 17 ? 12 : 8,
      dybde: depth === null ? 4 : depth >= 8 ? 20 : depth >= 4 ? 8 : 0,
      ...environment
    };
    return { score: clamp(10 + Object.values(breakdown).reduce((sum, value) => sum + value, 0), 0, 100), breakdown };
  }
  const breakdown = { vind: windPoints, skydekke: cloudPoints, kyst: coastPoints, eksponering: exposurePoints, temperatur: temperaturePoints, tidspunkt: timePoints, ...environment };
  return { score: clamp(10 + Object.values(breakdown).reduce((sum, value) => sum + value, 0), 0, 100), breakdown };
}

function norwegianHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', hourCycle: 'h23' }).format(date));
}

function solarLightProfile({hour,lat,lon,now=new Date(),cloud=50}) {
  const fallbackLow=hour<=8||hour>=19;
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return {lowLight:fallbackLow,bright:!fallbackLow&&cloud<35,elevation:null,basis:'klokkeslett'};
  const base=now instanceof Date?new Date(now):new Date(now);
  if(!Number.isFinite(base.getTime())) return {lowLight:fallbackLow,bright:!fallbackLow&&cloud<35,elevation:null,basis:'klokkeslett'};
  const localHour=norwegianHour(base);
  let delta=hour-localHour;
  if(delta>12) delta-=24;
  if(delta<-12) delta+=24;
  const date=new Date(base.getTime()+delta*3600000);
  const year=date.getUTCFullYear();
  const day=Math.floor((Date.UTC(year,date.getUTCMonth(),date.getUTCDate())-Date.UTC(year,0,0))/86400000);
  const utcMinutes=date.getUTCHours()*60+date.getUTCMinutes()+date.getUTCSeconds()/60;
  const gamma=2*Math.PI/365*(day-1+(utcMinutes/60-12)/24);
  const eqTime=229.18*(0.000075+0.001868*Math.cos(gamma)-0.032077*Math.sin(gamma)-0.014615*Math.cos(2*gamma)-0.040849*Math.sin(2*gamma));
  const decl=0.006918-0.399912*Math.cos(gamma)+0.070257*Math.sin(gamma)-0.006758*Math.cos(2*gamma)+0.000907*Math.sin(2*gamma)-0.002697*Math.cos(3*gamma)+0.00148*Math.sin(3*gamma);
  let solarMinutes=(utcMinutes+eqTime+4*lon)%1440;
  if(solarMinutes<0) solarMinutes+=1440;
  const hourAngle=(solarMinutes/4-180)*Math.PI/180;
  const latitude=lat*Math.PI/180;
  const cosZenith=Math.sin(latitude)*Math.sin(decl)+Math.cos(latitude)*Math.cos(decl)*Math.cos(hourAngle);
  const elevation=90-Math.acos(Math.max(-1,Math.min(1,cosZenith)))*180/Math.PI;
  return {lowLight:elevation<8,bright:elevation>=20&&cloud<35,elevation:Math.round(elevation*10)/10,basis:'beregnet solhøyde'};
}

function buildDataQuality({ weather = null, depth = null, waterType = 'saltwater' } = {}) {
  const weatherFields = ['wind','windDirection','cloud','temp'];
  const weatherAvailable = weatherFields.filter(key => Number.isFinite(weather?.[key]));
  const completeWeather = weatherAvailable.length === weatherFields.length;
  const freshwater = waterType === 'freshwater';
  const depthAvailable = !freshwater && Number.isFinite(depth?.meters);
  let level = 'Begrenset';
  if (completeWeather && depthAvailable) level = 'Godt';
  else if (weatherAvailable.length >= 3) level = 'Middels';
  const missing = [];
  if (!completeWeather) missing.push('værdata');
  if (!depthAvailable) missing.push(freshwater ? 'innlandsdybde' : 'dybde');
  const summary = missing.length ? `${missing.join(' og ')} mangler` : 'værmodell, vannkantanalyse og estimert dybde er tilgjengelig';
  return {
    level,
    summary,
    missing,
    weather: {
      available: weatherAvailable.length > 0,
      complete: completeWeather,
      kind: 'Værmodell',
      source: weather?.source || 'MET Norway',
      updatedAt: weather?.observedAt || null
    },
    coast: {
      available: true,
      kind: 'Beregnet analyse',
      source: freshwater ? 'OSM-vannmaske og innsjø-/elvebredde' : 'OSM-vannmaske og kystgeometri'
    },
    depth: {
      available: depthAvailable,
      kind: depthAvailable ? 'Estimert modell' : 'Mangler',
      source: freshwater ? 'Innlandsdybde er ikke tilgjengelig i denne versjonen' : (depth?.source || 'EMODnet Bathymetry mean DTM'),
      resolutionM: freshwater ? null : (depth?.resolutionM || 125),
      estimated: depthAvailable
    }
  };
}

const lureCatalog = Object.freeze(USER_LURE_DATA.lures.map(item=>Object.freeze(item)));

function flyOnlyLureAdvice({hour=12,cloud=50,wind=2,lat,lon}={}) {
  const lowLight=hour<=9||hour>=18;
  const options=[
    {id:'vf26',name:'Hvit baitfish-flue',type:'Liten streamer',weight:'Lett flue',color:'Hvit/sølv',image:'/lures/vestfjella/fly_hvit_baitfish.jpg',presentation:{band:'Øvre vannlag',retrieve:'Korte rolige trekk med pauser'},inventoryNote:'Enkeltutklipp fra ditt eget foto'},
    {id:'vf27',name:'Lys zonker/streamer',type:'Zonker / streamer',weight:'Lett flue',color:'Hvit/natur',image:'/lures/vestfjella/fly_hvit_zonker.jpg',presentation:{band:'Øvre til midtre vannlag',retrieve:'Trekk i korte serier og la flua henge'},inventoryNote:'Enkeltutklipp fra ditt eget foto'},
    {id:'vf28',name:'Mørk nymfe/våtflue',type:'Nymfe / våtflue',weight:'Lett flue',color:'Kobber/mørk',image:'/lures/vestfjella/fly_kobber_streamer.jpg',presentation:{band:'Midtre vannlag',retrieve:'Rolig drift eller korte trekk med lange stopp'},inventoryNote:'Enkeltutklipp fra ditt eget foto'},
    {id:'vf29',name:'Rosa bugger/triggerflue',type:'Bugger / triggerflue',weight:'Lett flue',color:'Rosa/kobber',image:'/lures/vestfjella/fly_rosa_bugger.jpg',presentation:{band:'Midtre vannlag',retrieve:'Rolig jevn føring med små stopp'},inventoryNote:'Enkeltutklipp fra ditt eget foto'}
  ];
  const preferred=lowLight?options:[options[2],options[0],options[1],options[3]];
  const primary=preferred[stableLureNumber(`${lat||0}:${lon||0}:${Math.round(cloud)}:${Math.round(wind)}`)%preferred.length];
  const alternatives=preferred.filter(item=>item.id!==primary.id).slice(0,3);
  return {...primary,why:'Dette vannet er registrert som kun fluefiske. Velg en av dine egne fluer og fisk lett langs vaksoner, odder og innløp.',alternatives,waterEnvironment:{id:'freshwater',label:'Ferskvann'},source:'Eget foto'};
}

function stableLureNumber(text) {
  let value = 2166136261;
  for (const char of text) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}

function selectPhotographedLures({ fishType='sjoorret', hour, cloud, wind, temp, exposure, coastQuality, depthMeters, conservativeShallow, exposed, sheltered, lowLight: lowLightOverride, lat, lon }) {
  const lowLight = typeof lowLightOverride==='boolean' ? lowLightOverride : (hour <= 8 || hour >= 19);
  const bright = !lowLight && cloud < 35;
  const overcastOrCold = !lowLight && (cloud >= 70 || temp < 8);
  const requiredWaterType=isFreshwaterFish(fishType)?'freshwater':'saltwater';
  const eligible=lureCatalog.filter(item=>item.species.includes(fishType)&&item.waterTypes.includes(requiredWaterType));
  if(!eligible.length) throw new Error(`Ingen fotograferte sluker er klassifisert for ${fishType} i ${requiredWaterType}`);

  // The measured conditions decide the ranking.  A tiny deterministic site-specific
  // tie-breaker is only used between near-equivalent choices, so neighbouring zones
  // do not falsely present the exact same lure as uniquely best everywhere.
  const siteKey = Number.isFinite(lat) && Number.isFinite(lon)
    ? `${lat.toFixed(4)}:${lon.toFixed(4)}`
    : `${Math.round(exposure*20)}:${Math.round(coastQuality*20)}:${depthMeters===null?'x':Math.round(depthMeters)}`;

  const scored = eligible.map(item => {
    const has = tag => item.tags.includes(tag);
    let score = 20;

    if (lowLight) score += (has('warm') ? 8 : 0) + (has('contrast') ? 6 : 0) + (has('pink') ? 4 : 0) - (has('bright') ? 2 : 0);
    else if (overcastOrCold) score += (has('warm') ? 6 : 0) + (has('natural') ? 4 : 0) + (has('contrast') ? 3 : 0) + (has('pink') ? 2 : 0);
    else if (bright) score += (has('silver') ? 8 : 0) + (has('blue') ? 6 : 0) + (has('natural') ? 4 : 0) - (has('warm') ? 2 : 0);
    else score += (has('silver') ? 4 : 0) + (has('blue') ? 3 : 0) + (has('pink') ? 3 : 0) + (has('natural') ? 3 : 0);

    if (conservativeShallow) score += (has('shallow') ? 8 : 0) + (has('slim') ? 4 : 0) + (has('minnow') ? 4 : 0) + (has('spoon') ? 3 : 0) - (has('deep') ? 6 : 0) - (has('broad') ? 2 : 0);
    else if (exposed) score += (has('casting') ? 8 : 0) + (has('compact') ? 5 : 0) + (has('sea-metal') ? 4 : 0) - (has('low-wind') ? 9 : 0);
    else if (sheltered) score += (has('shallow') ? 5 : 0) + (has('spoon') ? 3 : 0) + (has('minnow') ? 4 : 0) + (has('natural') ? 3 : 0) + (has('low-wind') ? 5 : 0);

    if (depthMeters !== null && depthMeters > 12) score += (has('deep') ? 7 : 0) + (has('sea-metal') ? 4 : 0) + (has('casting') ? 3 : 0);
    if (depthMeters !== null && depthMeters <= 4) score += (has('shallow') ? 6 : 0) + (has('wobbler') ? 3 : 0) - (has('deep') ? 5 : 0);
    if (coastQuality >= .75) score += (has('structure') ? 3 : 0) + (has('shallow') ? 2 : 0);

    if (isFreshwaterFish(fishType)&&has('freshwater-specialist')) score += 7;
    if (!isFreshwaterFish(fishType)&&has('saltwater-specialist')) score += 7;

    // Species preferences intentionally avoid one hard-coded winner.
    if (fishType === 'sjoorret') {
      score += (has('spoon') ? 8 : 0) + (has('sea-metal') ? 5 : 0) + (has('minnow') ? 6 : 0) + (has('wobbler') ? 4 : 0);
      if (sheltered) score += (has('bombarda') ? 5 : 0) + (has('fly') ? 3 : 0);
      if (lowLight || cloud >= 55) score += (has('warm') ? 4 : 0) + (has('pink') ? 4 : 0);
      if (bright) score += (has('silver') ? 4 : 0) + (has('natural') ? 3 : 0);
    }
    if (fishType === 'makrell') {
      score += (has('sea-metal') ? 10 : 0) + (has('silver') ? 8 : 0) + (has('casting') ? 6 : 0) + (has('blue') ? 4 : 0);
      if (conservativeShallow || sheltered) score += (has('minnow') ? 7 : 0) + (has('wobbler') ? 4 : 0);
      if (exposed || (depthMeters!==null && depthMeters>10)) score += (has('deep') ? 6 : 0) + (has('compact') ? 3 : 0);
      if (!exposed && !conservativeShallow) score += (has('mixed') ? 4 : 0) + (has('spoon') ? 2 : 0);
    }
    if (fishType === 'sei') score += (has('sea-metal') ? 9 : 0) + (has('shad') ? 8 : 0) + (has('silver') ? 6 : 0) + (has('contrast') ? 5 : 0) + (has('deep') ? 6 : 0);
    if (fishType === 'orret') score += (has('spinner') ? 8 : 0) + (has('spoon') ? 7 : 0) + (has('wobbler') ? 6 : 0) + (has('natural') ? 5 : 0) + (has('micro') ? 3 : 0);
    if (fishType === 'abbor') score += (has('shad') ? 9 : 0) + (has('spinner') ? 8 : 0) + (has('crankbait') ? 8 : 0) + (has('compact') ? 7 : 0) + (has('micro') ? 6 : 0) + (has('contrast') ? 5 : 0);
    if (fishType === 'gjedde') score += (has('spinnerbait') ? 12 : 0) + (has('shad') ? 11 : 0) + (has('wobbler') ? 8 : 0) + (has('broad') ? 7 : 0) + (has('contrast') ? 6 : 0) + (has('warm') ? 4 : 0);

    const tie = (stableLureNumber(`${fishType}|${siteKey}|${item.id}`) % 1000) / 1000;
    return { item, score, tie };
  }).sort((a,b) => b.score-a.score || b.tie-a.tie || a.item.id.localeCompare(b.item.id));

  const bestScore=scored[0].score;
  const suitabilityWindow = fishType==='sjoorret' ? 18 : fishType==='makrell' ? 22 : fishType==='sei' ? 18 : 12;
  const maxChoices = fishType==='sjoorret' ? 8 : fishType==='makrell' ? 7 : fishType==='sei' ? 7 : 6;
  const ranked=scored
    .filter(row=>row.score>=bestScore-suitabilityWindow)
    .map(row=>({ ...row, siteBias:(stableLureNumber(`${fishType}|${siteKey}|${row.item.id}|bias`) % 401)/100 }))
    .sort((a,b)=>(b.score+b.siteBias)-(a.score+a.siteBias)||b.tie-a.tie);
  // Site-specific variation is allowed only among genuinely strong choices. This prevents one lure
  // from winning every nearby zone while still keeping the primary within a small score band of best.
  const topBand=ranked.filter(row=>row.score>=bestScore-7).slice(0,7);
  const primary=topBand.length?topBand[stableLureNumber(`${fishType}|${siteKey}|primary`)%topBand.length]:ranked[0];
  const ordered=[primary,...ranked.filter(row=>row.item.id!==primary.item.id)];
  const picked=[primary];
  const usedIds=new Set([primary.item.id]);
  const usedGroups=new Set([primary.item.groupId||primary.item.id]);
  // Show genuine variety: first take the best suitable candidate from other photo groups/families.
  for(const row of ordered){
    const group=row.item.groupId||row.item.id;
    if(usedGroups.has(group)) continue;
    picked.push(row); usedIds.add(row.item.id); usedGroups.add(group);
    if(picked.length>=maxChoices) break;
  }
  // If there are fewer distinct groups, fill the remaining slots with other individual variants.
  if(picked.length<maxChoices) for(const row of ordered){
    if(usedIds.has(row.item.id)) continue;
    picked.push(row); usedIds.add(row.item.id);
    if(picked.length>=maxChoices) break;
  }
  const top=primary?.score ?? bestScore;
  return picked.map((row,index)=>({
    ...row.item,
    matchScore:clamp(Math.round(100-Math.max(0,top-row.score)*2-index),65,100),
    conditionScore:row.score
  }));
}
function genericLureCombinations({fishType,lowLight,cloud,exposed}) {
  const bright=cloud<35&&!lowLight;
  const choices={
    sjoorret:[
      {type:'Inline-spinner med smalt blad',weight:'8–15 g',color:lowLight?'Kobber/sort med rødt punkt':'Sølv/blå eller sølv/grønn',photoId:'inline-spinner',rigging:'Enkeltagn på fortom',use:'Jevn innsveiving med korte spinnstopp'},
      {type:'Myk shad på lett jigghode',weight:'7–10 cm · 5–12 g hode',color:bright?'Perlemor/oliven':'Kobber/brun med mørk rygg',photoId:'soft-shad',rigging:'Rettmontert shad med én krok',use:'Rolige løft over bunn, tang og renner'}
    ],
    makrell:[
      {type:'Slank metallsluk / casting-jig-type',weight:exposed?'30–45 g':'20–35 g',color:lowLight?'Sølv/rosa med kontrast':'Sølv/blå eller holografisk sølv',photoId:'spoon',rigging:'Enkeltagn eller enkel assistkrok',use:'Tell ned og sveiv raskt gjennom stimen'},
      {type:'Sildelignende skjesluk',weight:'18–35 g',color:bright?'Blank sølv/blå':'Sølv/grønn eller sølv/rosa',photoId:'spoon',rigging:'Enkeltagn på slitesterk fortom',use:'Varier mellom rask innsveiving og korte synkepauser'}
    ],
    sei:[
      {type:'Myk shad på jigghode',weight:'10–15 cm · 20–50 g hode',color:lowLight?'Sort/lilla over sølv':'Blå/sølv eller seifarget rygg',photoId:'soft-shad',rigging:'Rettmontert shad med kraftig enkeltkrok',use:'Fisk trinnvis ned mot kanter og dypere vann'},
      {type:'Kompakt metallsluk / casting-jig-type',weight:exposed?'40–70 g':'30–55 g',color:bright?'Sølv/blå':'Sølv med mørk eller selvlysende kontrast',photoId:'spoon',rigging:'Enkel assistkrok for mindre hekting',use:'Kontrollerte løft og fall i midtre/nedre vannlag'}
    ],
    orret:[
      {type:'Liten inline-spinner',weight:'4–8 g',color:lowLight?'Kobber/sort':'Sølv/blå eller sølv/grønn',photoId:'inline-spinner',rigging:'Enkeltagn på tynn fortom',use:'Jevn fart langs land, innløp og odder'},
      {type:'Mikrojigg eller liten shad',weight:'4–7 cm · 3–7 g hode',color:bright?'Naturfarget oliven/perlemor':'Brun, kobber eller mørk rygg',photoId:'micro-jig',rigging:'Lett jigghode med én krok',use:'Korte løft og pauser langs bunnkanter'}
    ],
    abbor:[
      {type:'Liten shad på jigghode',weight:'5–9 cm · 4–10 g hode',color:cloud>=60?'Chartreuse/brun kontrast':'Naturfarget grønn/perlemor',photoId:'soft-shad',rigging:'Rettmontert shad med én krok',use:'Små hopp langs bunn, brygger og sivkanter'},
      {type:'Liten spinner eller blade bait',weight:'5–12 g',color:lowLight?'Kobber/oransje':'Sølv/grønn eller abborfarget',photoId:'inline-spinner',rigging:'Enkeltagn på fluorokarbonfortom',use:'Søk raskt i midtre vannlag, senk farten ved kontakt'}
    ],
    gjedde:[
      {type:'Stor myk shad',weight:'12–20 cm · 20–50 g samlet',color:cloud>=50?'Mørk rygg med chartreuse/oransje':'Mort- eller abborfarget',photoId:'soft-shad',rigging:'Én egnet krok-rigg og bitefast fortom',use:'Rolig over vegetasjon og langs dypkanter'},
      {type:'Spinnerbait med én krok',weight:'15–30 g',color:lowLight?'Sort/oransje eller kobber':'Hvit/sølv eller grønn/gul',photoId:'spinnerbait',rigging:'Bitefast fortom; hold over vegetasjonen',use:'Jevn innsveiving gjennom sivbukter og grunne kanter'}
    ]
  };
  return (choices[fishType]||choices.sjoorret).map(({photoId,...choice})=>{
    const photo=OPEN_LURE_PHOTO_BY_ID[photoId];
    return {...choice,image:photo.localPath,photo:{sourcePage:photo.sourcePage,creator:photo.creator,license:photo.license,usageNote:photo.usageNote}};
  });
}

function sourceBackedLureChoice({fishType,hour,cloud,wind,temp,tempTrend,precipitation,exposed,depthMeters,lowLight: lowLightOverride}) {
  const lowLight=typeof lowLightOverride==='boolean'?lowLightOverride:(hour<=8||hour>=19);
  const bright=!lowLight&&cloud<35;
  const heavyRain=Number.isFinite(precipitation)&&precipitation>=4;
  const falling=Number.isFinite(tempTrend)&&tempTrend<=-.5;
  const shallow=Number.isFinite(depthMeters)&&depthMeters<=4;
  const deep=Number.isFinite(depthMeters)&&depthMeters>=12;
  const eligible=SOURCE_BACKED_LURES.filter(item=>item.species.includes(fishType));
  const signature=[fishType,hour,Math.round(cloud),Math.round(wind*10),Math.round(temp),Math.round((tempTrend||0)*10),Math.round((precipitation||0)*10),exposed?'x':'l',depthMeters===null?'u':Math.round(depthMeters)].join(':');
  const ranked=eligible.map(item=>{
    const has=tag=>item.tags.includes(tag);
    let score=20;
    if(lowLight) score+=(has('warm')?5:0)+(has('contrast')?4:0);
    if(bright) score+=(has('natural')?4:0)+(has('silver')?3:0);
    if(exposed) score+=(has('casting')?8:0)+(has('heavy')?5:0);
    if(deep) score+=(has('sinking')?6:0)+(has('depth-control')?5:0)+(has('heavy')?4:0);
    if(shallow) score+=(has('shallow')?9:0)+(has('vegetation')?8:0)-(has('deep')?5:0);
    if(heavyRain) score+=(has('contrast')?5:0)+(has('warm')?3:0);
    if(heavyRain||falling) score+=has('pause')?4:0;
    if(falling) score+=(has('slow')?4:0)+(has('sinking')?2:0);
    if(['makrell','sei'].includes(fishType)&&item.id==='solvkroken-stingsilda'&&(exposed||deep)) score+=12;
    if(fishType==='sjoorret'&&item.id==='solvkroken-stingsilda'&&exposed) score+=7;
    if(fishType==='sjoorret'&&item.id==='solvkroken-bris'&&lowLight&&exposed) score+=12;
    if(fishType==='sjoorret'&&item.id==='solvkroken-morild-inline'&&bright&&(exposed||deep)) score+=12;
    if(fishType==='orret'&&item.id==='solvkroken-spesial-classic-uv'&&(falling||heavyRain)) score+=12;
    if(['abbor','gjedde'].includes(fishType)&&item.id==='solvkroken-uro'&&shallow) score+=18;
    const tie=(stableLureNumber(`${signature}|${item.id}`)%1000)/1000;
    return {item,score,tie};
  }).sort((a,b)=>b.score-a.score||b.tie-a.tie||a.item.id.localeCompare(b.item.id));
  const selected=ranked[0]?.item;
  if(!selected) return null;
  let variant=selected.documentedRange, color=lowLight?'Mørk eller varm kontrast':'Naturlig sølv, blå eller grønn', presentation='Start med jevn innsveiving og varier fart og korte pauser.';
  if(selected.id==='abu-toby') {
    variant=fishType==='orret'?'7–10 g':exposed?'20–28 g':'10–20 g';
    color=lowLight?'Kobber/gull med mørk eller rød detalj':'Sølv/blå eller sølv/grønn';
    presentation=shallow?'Jevn fart med stangtuppen høyt over grunnen.':'Jevn innsveiving med korte spinnstopp.';
  } else if(selected.id==='abu-droppen') {
    variant=fishType==='gjedde'?'12 g':'4–8 g'; color=lowLight?'Kobber/sort':'Sølv/blå eller sølv/grønn'; presentation='Jevn fart langs land, innløp og struktur.';
  } else if(selected.id==='abu-atom') {
    variant=deep||exposed?'35–55 g':'20–35 g'; color=lowLight||heavyRain?'Kobber, sort eller tydelig varm kontrast':'Sølv/grønn eller naturlig byttefisk'; presentation='Fisk rolig og jevnt langs vegetasjons- og dypkanter.';
  } else if(selected.id==='rapala-countdown') {
    variant='Liten/mellomstor variant · tell ned ca. 30 cm per sekund'; color=lowLight?'Gull/kobber med mørk rygg':'Naturlig sølv/grønn'; presentation='Tell ned likt på hvert kast og søk høyere over vegetasjon eller dypere langs struktur.';
  } else if(selected.id==='savage-cannibal-shad') {
    variant=fishType==='gjedde'?'4–5 tommer':'2,5–3 tommer'; color=lowLight||heavyRain?'Mørk rygg eller tydelig kontrast':'Naturfarget oliven/perlemor'; presentation='Fisk med kontrollerte løft og pauser; hold agnet over vegetasjon eller bunn.';
  } else if(selected.id==='savage-sandeel') {
    variant=fishType==='sei'?'5–7 tommer':'5 tommer'; color=lowLight?'Mørk rygg over sølv/perlemor':'Tobisfarget blå/oliven over sølv'; presentation='Jigg trinnvis gjennom vannlagene; unngå ukontrollert bunnkontakt.';
  } else if(selected.id==='solvkroken-bris') {
    variant=exposed?'25 g':'15 g'; color=lowLight||heavyRain?'Tydelig kontrast eller varm detalj':'Naturlig sølv/småfisk'; presentation='Varier tempoet, legg inn korte spinnstopp og start grunt før du øker kastelengden.';
  } else if(selected.id==='solvkroken-morild-inline') {
    variant=exposed||deep?'22 g':'15 g'; color=lowLight?'Mørk rygg med sølv/kontrast':'Tobisnær blå eller oliven over sølv'; presentation='Bruk korte spinnstopp og la den vibrerende synkefasen arbeide kontrollert i valgt vannlag.';
  } else if(selected.id==='solvkroken-spesial-classic-uv') {
    variant=exposed?'10–18 g':'4–10 g'; color=lowLight||heavyRain?'Tydelig kontrast eller varm detalj':'Naturtro sølv/grønn'; presentation='Varier mellom rolig og raskere innsveiving og legg inn korte pauser.';
  } else if(selected.id==='solvkroken-uro') {
    variant=fishType==='gjedde'?'6 cm / 10 g · lite gjeddeagn':'4,6 cm / 6 g eller 6 cm / 10 g'; color=lowLight||heavyRain?'Tydelig kontrast':'Naturtro byttefisk'; presentation='Tell ned til ønsket vannlag og varier jevn innsveiving, stopp og korte løft.';
  } else if(selected.id==='solvkroken-stingsilda') {
    variant=fishType==='sjoorret'?'18 g':fishType==='makrell'?(exposed?'28–40 g':'18–28 g'):(deep?'40–60 g':'28–40 g');
    color=lowLight?'Sølv med mørk eller varm kontrast':'Sølv/blå eller holografisk småfisk';
    presentation=fishType==='sei'?'Tell kontrollert ned og fisk gjennom midtre/nedre vannlag med løft og fall.':'Varier rask innsveiving med korte kontrollerte synkepauser.';
  }
  const conditions=[lowLight?'lavt lys':bright?'klart dagslys':'dempet dagslys',`${wind.toFixed(1)} m/s vind`,Number.isFinite(depthMeters)?`${depthMeters.toLocaleString('no-NO',{maximumFractionDigits:1})} m estimert dybde`:'ukjent dybde'];
  if(Number.isFinite(precipitation)) conditions.push(precipitation>=4?`kraftig nedbør ${precipitation.toFixed(1)} mm/t`:precipitation>=.2?`nedbør ${precipitation.toFixed(1)} mm/t`:'lite eller ingen nedbør');
  if(Number.isFinite(tempTrend)) conditions.push(tempTrend<=-.5?'fallende temperatur':tempTrend>=.5?'stigende temperatur':'stabil temperatur');
  const photo=OPEN_LURE_PHOTO_BY_ID[selected.photoId];
  const guidance=SOURCE_BACKED_LURE_DATA.guidanceSources?.[fishType]||null;
  return {name:selected.name,maker:selected.maker,family:selected.family,variant,color,presentation,whyNow:`Valgt som startpunkt ved ${conditions.join(', ')}.`,documented:selected.documented,sourceLabel:selected.sourceLabel,sourceUrl:selected.sourceUrl,norwayAvailability:selected.norwayAvailability||null,norwayRetailLabel:selected.norwayRetailLabel||null,norwayRetailUrl:selected.norwayRetailUrl||null,guidanceLabel:guidance?.label||null,guidanceUrl:guidance?.url||null,guidanceKind:guidance?.kind||null,image:photo.localPath,photo:{sourcePage:photo.sourcePage,creator:photo.creator,license:photo.license,usageNote:photo.usageNote},evidenceLevel:'Produsentdata for modell og størrelse; norsk produktside bekrefter sortiment ved kontrolltidspunktet; vær-/stedsmatch er en veiledende tommelfingerregel.'};
}

function lurePresentationAdvice({fishType,depthMeters,lowLight,wind,exposed}) {
  const known=Number.isFinite(depthMeters);
  let band,reference='under overflaten',method;
  if(fishType==='sei') {
    band=known&&depthMeters>=12?'Start 2–5 m over bunnen':'Start i midtre vannlag og søk trinnvis nedover';
    reference=known&&depthMeters>=12?'over bunnen':'i vannsøylen';
    method='Tell sluken ned i faste intervaller; løft den over bunnkontakt for å redusere hekting.';
  } else if(fishType==='makrell') {
    band=known&&depthMeters>=10?'Start 2–5 m under overflaten':'Start 0,5–2 m under overflaten';
    method='Begynn høyt og tell 3–5 sekunder dypere per kast til du finner stimen.';
  } else if(fishType==='sjoorret') {
    band=known&&depthMeters<=4?'0,2–0,8 m under overflaten':lowLight?'0,3–1,2 m under overflaten':'Start 1–3 m under overflaten';
    method=known&&depthMeters<=4?'Hold stangtuppen høyt og bruk jevn, rolig fart over grunnen.':'Varier innsveivingsfart og korte stopp; unngå å slepe i bunnen.';
  } else if(fishType==='orret') {
    band=lowLight?'0,3–1,0 m under overflaten':'Start 0,8–2 m under overflaten';
    method='Fisk høyt morgen/kveld; tell gradvis ned i klart dagslys eller kaldt vann.';
  } else if(fishType==='abbor') {
    band='Start 0,5–1,5 m over bunnen'; reference='over bunnen';
    method='Bruk korte løft og pauser; søk midtvanns hvis du ser jagende fisk.';
  } else {
    band='Start 0,5–1,5 m over vegetasjon eller bunn'; reference='over vegetasjon/bunn';
    method='Hold agnet over vegetasjonen og senk det langs kanten mot dypere vann.';
  }
  if(!known&&['sjoorret','makrell','sei'].includes(fishType)) {
    band=fishType==='sei'?'Start i midtre vannlag og søk trinnvis nedover':fishType==='makrell'?'Start øverst og søk trinnvis nedover':'Start 0,5–1,5 m under overflaten og søk trinnvis';
  }
  return {band,reference,method,basis:known?'Tommelfingerregel basert på estimert dybde og forhold – ikke en målt fiskedybde.':'Søketrinn fordi lokal dybde/fiskedybde ikke er bekreftet.'};
}

function dropperFlyAdvice({fishType,lowLight,cloud,wind,exposed}) {
  const rulesNote='Kontroller fiskekort og lokale regler: opphengerfluen kan telle som ekstra krok/agn.';
  const baitfishColor=lowLight?'Sort/lilla med litt oransje':'Hvit/sølv med blå eller oliven rygg';
  if(fishType==='sjoorret') return {recommended:wind<=7, distance:'45–60 cm foran sluken', pattern:'Liten reke-, kutling- eller børstemarkflue', color:lowLight?'Sort/lilla eller kobber/oransje':'Oliven/hvit eller sølv/perlemor', image:wind<=7?`/lures/generated/fly-shrimp-${lowLight?'dark':'light'}.svg`:null, reason:wind<=7?'Aktuelt som ekstra, lett bytte ved rolig til moderat fiske.':'Ikke førstevalg i hard vind; riggen kan tvinne og hekte.', rulesNote};
  if(fishType==='makrell') return {recommended:wind<=8,distance:'50–80 cm foran sluken',pattern:'Liten silde-/tobisstreamer',color:baitfishColor,image:wind<=8?`/lures/generated/fly-baitfish-${lowLight?'dark':'light'}.svg`:null,reason:wind<=8?'Kan gi en liten byttefisk foran metallagnet når makrellen jager.':'Dropp opphengeren i hard vind for enklere og sikrere kast.',rulesNote};
  if(fishType==='sei') return {recommended:wind<=8&&!exposed,distance:'50–80 cm foran sluken',pattern:'Slank tobis- eller småfiskstreamer',color:baitfishColor,image:wind<=8&&!exposed?`/lures/generated/fly-baitfish-${lowLight?'dark':'light'}.svg`:null,reason:wind<=8&&!exposed?'Aktuelt i håndterbare forhold når seien tar små byttefisk.':'Bruk ett agn i vind/eksponert sjø for mindre floke og bedre kontroll.',rulesNote};
  if(fishType==='orret') return {recommended:lowLight&&wind<=4,distance:'40–60 cm foran sluken',pattern:'Liten våtflue eller nymfe',color:lowLight?'Sort/brun eller kobber':'Oliven/brun',image:lowLight&&wind<=4?'/lures/generated/fly-wet-dark.svg':null,reason:lowLight&&wind<=4?'Kan vurderes i rolig vann der lokale regler tillater ekstra krok.':'Ikke standardvalg; bruk én sluk når forhold eller regler er uklare.',rulesNote};
  if(fishType==='abbor') return {recommended:false,distance:'Ikke anbefalt som standard',pattern:'Ingen opphengerflue',color:'Ikke aktuelt',image:null,reason:'Jigg, spinner eller blade bait alene gir bedre kontroll rundt struktur.',rulesNote};
  return {recommended:false,distance:'Ikke anbefalt',pattern:'Ingen opphengerflue',color:'Ikke aktuelt',image:null,reason:'Ved gjeddefiske prioriteres bitefast fortom og ett kontrollert agn.',rulesNote};
}

function recommendLure(input = {}) {
  const fishType = normalizeFishType(input.fishType);
  const goal = normalizeGoal(input.goal);
  const freshwater = isFreshwaterFish(fishType);
  const hour = Number.isFinite(input.hour) ? input.hour : norwegianHour();
  const cloud = Number.isFinite(input.cloud) ? input.cloud : 50;
  const wind = Number.isFinite(input.wind) ? input.wind : 4;
  const temp = Number.isFinite(input.temp) ? input.temp : 10;
  const tempTrend = Number.isFinite(input.tempTrend) ? input.tempTrend : null;
  const precipitation = Number.isFinite(input.precipitation) ? input.precipitation : null;
  const exposure = clamp(Number.isFinite(input.exposure) ? input.exposure : 0.5, 0, 1);
  const coastQuality = clamp(Number.isFinite(input.coastQuality) ? input.coastQuality : 0.5, 0, 1);
  const depthMeters = Number.isFinite(input.depthMeters) ? clamp(input.depthMeters, 0, 12000) : null;
  const lightProfile=solarLightProfile({hour,lat:input.lat,lon:input.lon,now:input.now||new Date(),cloud});
  const lowLight=lightProfile.lowLight;
  const exposed = exposure >= 0.72 || wind >= 6;
  const sheltered = exposure <= 0.35 && wind < 4;
  const conservativeShallow = !freshwater && (depthMeters !== null && depthMeters <= 5 || input.shallowRisk === true || depthMeters === null && coastQuality >= 0.75);
  const noDepth = depthMeters === null ? null : depthMeters.toLocaleString('no-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  let type = 'Smal kystsluk';
  let weight = '18–22 g';
  if (conservativeShallow) { type = 'Lett, gruntgående skjesluk'; weight = '7–12 g'; }
  else if (exposed) { type = 'Langtkastende, kompakt kystsluk'; weight = '22–28 g'; }
  else if (sheltered) { type = 'Saktegående skjesluk eller liten wobbler'; weight = '12–18 g'; }

  if (fishType === 'makrell') {
    type = exposed || (depthMeters !== null && depthMeters > 12) ? 'Langtkastende, kompakt metallagn' : 'Kompakt kastsluk eller metallagn';
    weight = conservativeShallow ? '12–20 g' : exposed ? '25–40 g' : '18–30 g';
  } else if (fishType === 'sei') {
    type = depthMeters !== null && depthMeters > 12 ? 'Pilk eller kompakt metallagn' : 'Kompakt metallagn for variert innsveiving';
    weight = conservativeShallow ? '18–28 g' : depthMeters !== null && depthMeters > 12 ? '30–50 g' : '20–35 g';
  } else if (fishType === 'orret') {
    type = exposed ? 'Liten, langtkastende skjesluk' : 'Liten skjesluk eller spinner';
    weight = '4–12 g';
  } else if (fishType === 'abbor') {
    type = 'Liten spinner, skjesluk eller jigg';
    weight = '3–10 g';
  } else if (fishType === 'gjedde') {
    type = goal==='big' ? 'Stor shad, jerkbait, spinnerbait eller stor wobbler' : 'Gjeddesluk, spinnerbait eller wobbler';
    weight = goal==='big' ? '25–70 g' : '15–35 g';
  }

  const choices = selectPhotographedLures({ fishType, hour, cloud, wind, temp, exposure, coastQuality, depthMeters, conservativeShallow, exposed, sheltered, lowLight, lat:input.lat, lon:input.lon });
  const primary = choices[0];
  type=`${type} · ${primary.family}`;
  const solarNote=Number.isFinite(lightProfile.elevation)?` (beregnet solhøyde ${lightProfile.elevation.toFixed(1)}°)`:'';
  const timeReason = lowLight ? `lavt lys${solarNote}` : cloud < 25 ? `klart dagslys${solarNote}` : `dempet dagslys${solarNote}`;
  const placeReason = exposed ? 'åpen og vindutsatt plass' : sheltered ? 'lun plass' : freshwater ? 'middels eksponert vannkant' : 'middels eksponert kyst';
  const depthReason = noDepth ? `estimert dybde ${noDepth} m` : freshwater ? 'innlandsdybde utilgjengelig' : 'dybdedata utilgjengelig';
  const tackleReason = conservativeShallow && fishType === 'sjoorret' ? `${depthReason}; svært grunt eller svært kystnært, velger lett og gruntgående konservativt` : `${depthReason}; ${placeReason}`;

  let wobbler;
  if (fishType === 'makrell') {
    wobbler = { type: 'Slank, synkende minnowvobbler', size: '8–12 cm', color: lowLight ? 'Sølv med rosa eller mørk kontrast' : 'Sølv/blå med mørk rygg', image: lowLight ? '/lures/gold-orange-lowlight.jpg' : '/lures/blue-silver-shallow.jpg' };
  } else if (fishType === 'sei') {
    wobbler = { type: depthMeters !== null && depthMeters > 12 ? 'Synkende minnowvobbler' : 'Stabil minnowvobbler', size: '9–13 cm', color: lowLight ? 'Sort rygg over sølvside' : 'Blå/sort rygg og sølvside', image: '/lures/black-silver-diving.jpg' };
  } else if (fishType === 'orret') {
    wobbler = { type: lowLight ? 'Sakte synkende ørretwobbler' : 'Flytende, gruntgående ørretwobbler', size: '5–8 cm', color: lowLight ? 'Kobber/gull med mørk rygg' : 'Naturlig sølv/grønn', image: lowLight ? '/lures/gold-orange-lowlight.jpg' : '/lures/trout-natural.jpg' };
  } else if (fishType === 'abbor') {
    wobbler = { type: 'Liten crankbait eller minnowvobbler', size: '4–7 cm', color: cloud >= 60 ? 'Gull/oransje eller tydelig kontrast' : 'Sølv/grønn med mørk rygg', image: cloud >= 60 ? '/lures/gold-orange-lowlight.jpg' : '/lures/trout-natural.jpg' };
  } else if (fishType === 'gjedde') {
    wobbler = { type: goal==='big'?'Stor gjeddewobbler / jerkbait':'Større gjeddewobbler', size: goal==='big'?'14–20 cm':'10–16 cm', color: cloud >= 50 ? 'Mørk rygg med varm kontrast' : 'Naturlig sølv/grønn', image: cloud >= 50 ? '/lures/black-silver-diving.jpg' : '/lures/trout-natural.jpg' };
  } else if (conservativeShallow) {
    wobbler = { type: 'Flytende, gruntgående minnowvobbler', size: '6–9 cm', color: lowLight ? 'Gull/oransje med rød buk' : 'Sølv/blå med mørk rygg', image: lowLight ? '/lures/gold-orange-lowlight.jpg' : '/lures/blue-silver-shallow.jpg' };
  } else if (lowLight) {
    wobbler = { type: sheltered ? 'Flytende, gruntgående minnowvobbler' : 'Sakte synkende minnowvobbler', size: '9–11 cm', color: 'Gull/oransje med rød buk', image: '/lures/gold-orange-lowlight.jpg' };
  } else if (exposed) {
    wobbler = { type: 'Dykkende, stabil minnowvobbler', size: '10–13 cm', color: 'Blå/sort rygg og sølvside', image: '/lures/black-silver-diving.jpg' };
  } else if (temp < 8 || cloud >= 70) {
    wobbler = { type: 'Suspending ørretimitasjon', size: '8–11 cm', color: 'Naturlig grønn/sølv med rosa stripe', image: '/lures/trout-natural.jpg' };
  } else {
    wobbler = { type: 'Gruntgående minnowvobbler', size: '8–11 cm', color: 'Sølv/blå med mørk rygg', image: '/lures/blue-silver-shallow.jpg' };
  }
  const depth = { meters: depthMeters, label: noDepth ? `${noDepth} m estimert${conservativeShallow && fishType === 'sjoorret' ? ' · gruntvannsvalg' : ''}` : freshwater ? 'Innlandsdybde ikke tilgjengelig' : `Ukjent${conservativeShallow && fishType === 'sjoorret' ? ' · konservativt gruntvannsvalg' : ''}`, source: depthMeters === null ? null : 'EMODnet DTM (~125 m oppløsning)', estimated: depthMeters !== null, conservativeShallow };
  const environmentId=freshwater?'freshwater':'saltwater';
  const environmentLabel=freshwater?'Ferskvann':'Saltvann';
  const waterEnvironment={
    id:environmentId,
    label:environmentLabel,
    classification:primary.waterTypes.length===1?'Miljøspesifikk bildegruppe':'Allroundprofil for begge vannmiljøer',
    basis:'Eget bilde er klassifisert etter synlig agntype, form og farge. Ukjent modell, vekt og krokfinish behandles ikke som produsentdokumentasjon.',
    caveat:freshwater?'Kontroller lokale regler, fiskekort og tillatt krokoppsett.':'Saltvannsegnet krok og rustbeskyttelse kan ikke bekreftes fra bildet; skyll agnet i ferskvann og kontroller krok og splittring etter bruk.'
  };
  const alternatives=choices.slice(1,6).map(choice=>({name:choice.name,type:choice.family,color:choice.color,image:choice.image,inventoryNote:choice.inventoryNote,ownedPhoto:true,matchScore:choice.matchScore,weight}));
  const genericCombinations=[];
  const researchedChoice=null;
  const presentation=lurePresentationAdvice({fishType,depthMeters,lowLight,wind,exposed});
  const dropperFly=dropperFlyAdvice({fishType,lowLight,cloud,wind,exposed});
  const speciesReason = fishType === 'makrell' ? 'Makrell: søk i frie vannmasser og rundt strøm, odder eller stimer av småfisk' : fishType === 'sei' ? 'Sei: prioriter strøm, bratte kanter og vann med litt dybde' : fishType === 'orret' ? 'Ferskvannsørret: fisk langs vannkanter, odder, innløp og vindpåvirkede bredder' : fishType === 'abbor' ? 'Abbor: søk langs struktur, sivkanter, odder og lune bukter' : fishType === 'gjedde' ? 'Gjedde: prioriter grunne bukter, vegetasjon og kanter mot dypere vann' : null;
  const trophyNote=goal==='big'&&fishType==='gjedde'?' Stor-fisk-modus: fisk større agn sakte med tydelige pauser langs vegetasjon, odder og overgangen mot dypere vann.':'';
  return { name:primary.name, type, weight, color:primary.color, image:primary.image, inventoryNote:primary.inventoryNote, ownedPhoto:true, matchScore:primary.matchScore, waterEnvironment, reason: `${speciesReason ? `${speciesReason}; ` : ''}${timeReason}; ${tackleReason}.${trophyNote}`, depth, wobbler:null, alternatives, genericCombinations, researchedChoice, presentation, dropperFly };
}

function formatReason({ breakdown = {}, weather = {}, coastQuality = 0.5, exposure = 0.5, waterType = 'saltwater' } = {}) {
  const parts = [];
  if (Number.isFinite(weather.wind)) parts.push(`Vind ${weather.wind.toFixed(1)} m/s${Number.isFinite(weather.windDirection) ? ` fra ${Math.round(weather.windDirection)}°` : ''}`);
  const edge = waterType === 'freshwater' ? 'vannkanten' : 'kysten';
  parts.push(exposure >= 0.67 ? `vinden treffer ${edge} gunstig` : exposure <= 0.33 ? 'området ligger delvis i le' : 'moderat vindeksponering');
  parts.push(coastQuality >= 0.7 ? `tydelig ${waterType === 'freshwater' ? 'vannkant' : 'kystkant'} med flere landtreff` : `brukbar nærhet til ${edge}`);
  if (Number.isFinite(weather.cloud)) parts.push(`${Math.round(weather.cloud)} % skydekke`);
  if (Number.isFinite(weather.tempTrend)) parts.push(weather.tempTrend < -0.3 ? 'fallende temperatur' : weather.tempTrend > 0.5 ? 'stigende temperatur' : 'stabil temperatur');
  if (Number.isFinite(weather.pressureTrend)) parts.push(`lufttrykk ${weather.pressureTrend > 0 ? '+' : ''}${weather.pressureTrend.toFixed(1)} hPa / 3 t`);
  if (waterType === 'saltwater' && Number.isFinite(weather.seaTemp)) parts.push(`sjø ${weather.seaTemp.toFixed(1)} °C`);
  if (waterType === 'saltwater' && weather.tideState) parts.push(`${weather.tideState} vann`);
  const strongest = Object.entries(breakdown).sort((a,b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0,2).map(([name]) => name).join(' og ');
  return `${parts.join(', ')}.${strongest ? ` Sterkest bidrag: ${strongest}.` : ''}`;
}

function validateZoneRequest(bboxText, zoomText) {
  const bbox = String(bboxText || '').split(',').map(Number);
  const zoom = Number(zoomText);
  if (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v))) throw new Error('Mangler gyldig bbox med vest,sør,øst,nord');
  const [west, south, east, north] = bbox;
  if (west >= east || south >= north) throw new Error('Ugyldig rekkefølge: vest må være mindre enn øst og sør mindre enn nord');
  if (west < 3 || east > 32 || south < 57 || north > 72) throw new Error('Kartutsnittet må ligge i Norge');
  if (east - west > 2.5 || north - south > 2.5) throw new Error('Kartutsnittet er for stort; zoom nærmere kysten');
  if (!Number.isFinite(zoom) || zoom < 7 || zoom > 18) throw new Error('Zoom må være mellom 7 og 18');
  return { west, south, east, north, zoom };
}

function sameCoordinate(a,b) { return a && b && Math.abs(a.lat-b.lat)<1e-7 && Math.abs(a.lon-b.lon)<1e-7; }
function pointInPolygon(lat,lon,ring) {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const xi=ring[i].lon, yi=ring[i].lat, xj=ring[j].lon, yj=ring[j].lat;
    if (((yi>lat)!==(yj>lat)) && lon < (xj-xi)*(lat-yi)/((yj-yi)||Number.EPSILON)+xi) inside=!inside;
  }
  return inside;
}
function stitchWaterRings(rawSegments=[]) {
  const segments=rawSegments.filter(segment=>Array.isArray(segment)&&segment.length>=2).map(segment=>segment.map(point=>({lat:Number(point.lat),lon:Number(point.lon)})));
  const rings=[];
  while(segments.length) {
    let ring=segments.shift();
    let changed=true;
    while(changed && !sameCoordinate(ring[0],ring[ring.length-1])) {
      changed=false;
      for(let i=0;i<segments.length;i++) {
        const segment=segments[i], start=ring[0], end=ring[ring.length-1], segStart=segment[0], segEnd=segment[segment.length-1];
        if(sameCoordinate(end,segStart)) ring=ring.concat(segment.slice(1));
        else if(sameCoordinate(end,segEnd)) ring=ring.concat([...segment].reverse().slice(1));
        else if(sameCoordinate(start,segEnd)) ring=segment.slice(0,-1).concat(ring);
        else if(sameCoordinate(start,segStart)) ring=[...segment].reverse().slice(0,-1).concat(ring);
        else continue;
        segments.splice(i,1); changed=true; break;
      }
    }
    if(ring.length>=4 && sameCoordinate(ring[0],ring[ring.length-1])) rings.push(ring);
  }
  return rings;
}
function parseFreshwaterAreas(json={}) {
  const areas=[];
  const add=(ring,tags={},id='',holes=[])=>{
    if(!Array.isArray(ring)||ring.length<4||!sameCoordinate(ring[0],ring[ring.length-1])) return;
    const restricted=String(tags.fishing||'').toLowerCase()==='no'||['no','private'].includes(String(tags.access||'').toLowerCase());
    areas.push({ring,holes:holes.filter(hole=>Array.isArray(hole)&&hole.length>=4&&sameCoordinate(hole[0],hole[hole.length-1])),name:tags.name||'Navnløst vann',restricted,tags,id});
  };
  for(const element of json.elements||[]) {
    const tags=element.tags||{};
    if(element.type==='way') add((element.geometry||[]).map(point=>({lat:Number(point.lat),lon:Number(point.lon)})),tags,`way/${element.id}`);
    if(element.type==='relation') {
      const outerRings=stitchWaterRings((element.members||[]).filter(member=>(member.role||'outer')==='outer').map(member=>member.geometry||[]));
      const innerRings=stitchWaterRings((element.members||[]).filter(member=>member.role==='inner').map(member=>member.geometry||[]));
      for(const ring of outerRings) add(ring,tags,`relation/${element.id}`,innerRings.filter(hole=>pointInPolygon(hole[0].lat,hole[0].lon,ring)));
    }
  }
  return areas;
}
function pointIsInFreshwaterArea(lat,lon,area) {
  return Boolean(area?.ring&&pointInPolygon(lat,lon,area.ring)&&!(area.holes||[]).some(hole=>pointInPolygon(lat,lon,hole)));
}
function freshwaterAtPoint(lat,lon,areas=[]) {
  for(const area of areas) if(pointIsInFreshwaterArea(lat,lon,area)) return area;
  return null;
}

function freshwaterCoastInfo(lat,lon,area) {
  const ring=area?.ring;
  if(!Array.isArray(ring)||ring.length<4) return null;
  let best=null;
  for(let i=0;i<ring.length-1;i++) {
    const a=ring[i], b=ring[i+1];
    const midLat=(a.lat+b.lat)/2;
    const lonScale=Math.cos(midLat*Math.PI/180);
    const ax=a.lon*lonScale, ay=a.lat, bx=b.lon*lonScale, by=b.lat;
    const px=lon*lonScale, py=lat;
    const dx=bx-ax, dy=by-ay, length2=dx*dx+dy*dy;
    if(length2===0) continue;
    const t=clamp(((px-ax)*dx+(py-ay)*dy)/length2,0,1);
    const nx=ax+dx*t, ny=ay+dy*t;
    const distance2=(px-nx)*(px-nx)+(py-ny)*(py-ny);
    if(!best||distance2<best.distance2) best={dx,dy,distance2};
  }
  if(!best) return null;
  const tangent=Math.atan2(best.dy,best.dx);
  const coastNormal=((tangent-Math.PI/2)*180/Math.PI+360)%360;
  return {tangent,coastNormal,landCount:1,quality:0.72};
}

function polygonMostlyInFreshwater(poly,area) {
  if(!area?.ring||!Array.isArray(poly)||!poly.length) return false;
  return poly.every(([lat,lon])=>pointIsInFreshwaterArea(lat,lon,area));
}
function postFormText(url,form,timeoutMs=14000) {
  return new Promise((resolve,reject)=>{
    const body=new URLSearchParams(form).toString();
    const request=https.request(url,{method:'POST',headers:{'User-Agent':MET_USER_AGENT,'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Content-Length':Buffer.byteLength(body)}},response=>{
      const chunks=[]; let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>12*1024*1024)request.destroy(new Error('OSM-responsen var for stor'));else chunks.push(chunk);});
      response.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        if(response.statusCode<200||response.statusCode>=300) reject(new Error(`OSM ferskvannskontroll svarte ${response.statusCode}`));
        else resolve(text);
      });
    });
    request.setTimeout(timeoutMs,()=>request.destroy(new Error('OSM ferskvannskontroll fikk tidsavbrudd')));
    request.on('error',reject); request.end(body);
  });
}
function getJsonHttps(url,timeoutMs=9000) {
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{headers:{'User-Agent':MET_USER_AGENT,'Accept':'application/json'}},response=>{
      const chunks=[]; let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)request.destroy(new Error('OSM-responsen var for stor'));else chunks.push(chunk);});
      response.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');
        if(response.statusCode<200||response.statusCode>=300) reject(new Error(`OSM punktoppslag svarte ${response.statusCode}`));
        else { try { resolve(JSON.parse(text)); } catch(error) { reject(error); } }
      });
    });
    request.setTimeout(timeoutMs,()=>request.destroy(new Error('OSM punktoppslag fikk tidsavbrudd')));
    request.on('error',reject);
  });
}
function parseNominatimWater(data) {
  if(!data||!Array.isArray(data.boundingbox)||data.boundingbox.length!==4) return null;
  const tags=data.extratags||{};
  const waterTypes=new Set(['water','lake','reservoir','river','stream','canal','pond','basin']);
  if(data.category!=='water'&&tags.natural!=='water'&&!tags.waterway&&!waterTypes.has(data.type)) return null;
  const [south,north,west,east]=data.boundingbox.map(Number);
  if(![south,north,west,east].every(Number.isFinite)||south>=north||west>=east) return null;
  return {
    id:`${data.osm_type||'osm'}:${data.osm_id||data.place_id||'water'}`,
    name:data.name||String(data.display_name||'').split(',')[0]||'Navnløst vann',
    tags,
    restricted:tags.fishing==='no'||tags.access==='no'||tags.access==='private',
    ring:[{lat:south,lon:west},{lat:south,lon:east},{lat:north,lon:east},{lat:north,lon:west},{lat:south,lon:west}],
    lookup:'nominatim'
  };
}
async function fetchNominatimWater({west,south,east,north}) {
  const lat=(south+north)/2,lon=(west+east)/2;
  const key=`freshwater-point:${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cached(key,30*60*1000,async()=>{
    const params=new URLSearchParams({format:'jsonv2',lat:String(lat),lon:String(lon),zoom:'14',layer:'natural',addressdetails:'0',extratags:'1'});
    return parseNominatimWater(await getJsonHttps(`https://nominatim.openstreetmap.org/reverse?${params}`,9000));
  });
}
async function fetchFreshwaterAreas({west,south,east,north}) {
  const key=`freshwater:${west.toFixed(3)},${south.toFixed(3)},${east.toFixed(3)},${north.toFixed(3)}`;
  return cached(key,30*60*1000,async()=>{
    const query=`[out:json][timeout:18];(way["natural"="water"](${south},${west},${north},${east});relation["natural"="water"](${south},${west},${north},${east});way["waterway"="riverbank"](${south},${west},${north},${east});relation["waterway"="riverbank"](${south},${west},${north},${east}););out geom;`;
    const endpoints=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
    let lastError=null;
    for(const endpoint of endpoints) {
      try {
        const text=await postFormText(endpoint,{data:query},14000);
        return parseFreshwaterAreas(JSON.parse(text));
      } catch(error) { lastError=error; }
    }
    throw lastError||new Error('OSM ferskvannskontroll svarte ikke');
  });
}

async function fetchText(url, headers = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0,120)}`);
    return text;
  } finally { clearTimeout(timeout); }
}
async function fetchJson(url, headers, timeoutMs) { return JSON.parse(await fetchText(url, headers, timeoutMs)); }
function parseDepthFeatureInfo(json) {
  const value = Number(json?.features?.[0]?.properties?.Depth);
  if (!Number.isFinite(value) || value < 0 || value > 12000) return null;
  const meters = Number(value.toFixed(1));
  const category = meters <= 2.5 ? 'very-shallow' : meters <= 5 ? 'shallow' : meters <= 12 ? 'medium' : 'deep';
  return { meters, category, source: 'EMODnet Bathymetry mean DTM', resolutionM: 125, estimated: true };
}
async function depthAtPoint(lat, lon) {
  const key = `depth:${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cached(key, 6 * 60 * 60 * 1000, async () => {
    const delta = 0.01;
    const params = new URLSearchParams({ SERVICE:'WMS', VERSION:'1.3.0', REQUEST:'GetFeatureInfo', LAYERS:'emodnet:mean', QUERY_LAYERS:'emodnet:mean', STYLES:'', CRS:'EPSG:4326', BBOX:`${lat-delta},${lon-delta},${lat+delta},${lon+delta}`, WIDTH:'101', HEIGHT:'101', I:'50', J:'50', INFO_FORMAT:'application/json', FEATURE_COUNT:'1', FORMAT:'image/png' });
    return parseDepthFeatureInfo(await fetchJson(`https://ows.emodnet-bathymetry.eu/ows?${params}`, { 'User-Agent': MET_USER_AGENT }, 6500));
  });
}
async function fetchBuffer(url, headers = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return Buffer.from(await response.arrayBuffer());
  } finally { clearTimeout(timeout); }
}

function osloDateKey(value) {
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
function fishingHourScore(item,fishType) {
  const fish=normalizeFishType(fishType);
  const hour=norwegianHour(new Date(item.time));
  const lowLight=hour<=9||hour>=18;
  let score=38;
  let lightText='normale lysforhold';
  if(['sjoorret','orret'].includes(fish)) {
    if(lowLight){score+=28;lightText='gunstig morgen-/kveldslys';}
    else {score+=10;lightText='lysere dagperiode';}
  } else if(fish==='sei') {
    if(hour<=8||hour>=19){score+=25;lightText='lavt lys som ofte er aktuelt for sei';}
    else {score+=12;lightText='daglys';}
  } else if(fish==='makrell') {
    if((hour>=6&&hour<=11)||(hour>=16&&hour<=21)){score+=23;lightText='morgen-/ettermiddagsperiode for makrell';}
    else {score+=10;lightText='øvrig dagperiode';}
  } else if(fish==='abbor') {
    if((hour>=6&&hour<=11)||(hour>=16&&hour<=21)){score+=22;lightText='aktiv morgen-/kveldsperiode for abbor';}
    else {score+=9;lightText='roligere lysperiode';}
  } else if(fish==='gjedde') {
    if(lowLight){score+=20;lightText='morgen-/kveldslys for gjedde';}
    else {score+=12;lightText='dagperiode';}
  }
  const wind=Number(item.wind);
  let windText='vinddata mangler';
  const freshwater=isFreshwaterFish(fish);
  if(Number.isFinite(wind)) {
    if(wind>13){score-=14;windText='kraftig vind trekker ned';}
    else if(wind>10){score+=3;windText='frisk vind';}
    else if(wind>=(freshwater?1:2)&&wind<=(freshwater?7:9)){score+=20;windText='moderat vind';}
    else {score+=10;windText='svak vind';}
  }
  const cloud=Number(item.cloud);
  let cloudText='skydata mangler';
  if(Number.isFinite(cloud)) {
    if(cloud>=35&&cloud<=90){score+=16;cloudText='gunstig skydekke';}
    else if(cloud>90){score+=11;cloudText='tett skydekke';}
    else {score+=4;cloudText='klart vær';}
  }
  const precipitation=Number(item.precipitation);
  if(Number.isFinite(precipitation)&&precipitation>4) score-=8;
  return {score:clamp(Math.round(score),0,100),reason:`${lightText}, ${windText} og ${cloudText}`};
}
function bestFishingTimes(hourly=[],fishType='sjoorret',now=new Date()) {
  const source='MET Norway timeprognose + artstilpasset tommelfingerregel';
  const disclaimer='Veiledende forholdsscore – ikke fangstsannsynlighet eller garanti for fangst.';
  const today=osloDateKey(now);
  const usable=(Array.isArray(hourly)?hourly:[]).filter(item=>{
    const time=new Date(item?.time);
    return item&&today&&osloDateKey(time)===today&&!Number.isNaN(time.getTime())&&time.getTime()>=now.getTime()-15*60*1000;
  }).sort((a,b)=>new Date(a.time)-new Date(b.time));
  if(!usable.length) return {available:false,windows:[],source,disclaimer,message:'Ingen gjenværende timeprognose er tilgjengelig for i dag.'};
  const candidates=[];
  for(let i=0;i<usable.length;i++) {
    const group=[usable[i]];
    for(let j=i+1;j<usable.length&&group.length<3;j++) {
      const previous=new Date(group[group.length-1].time).getTime();
      const next=new Date(usable[j].time).getTime();
      if(next-previous>75*60*1000) break;
      group.push(usable[j]);
    }
    const scored=group.map(item=>fishingHourScore(item,fishType));
    const score=Math.round(scored.reduce((sum,item)=>sum+item.score,0)/scored.length);
    const start=group[0].time;
    const end=new Date(new Date(group[group.length-1].time).getTime()+60*60*1000).toISOString();
    const best=scored.slice().sort((a,b)=>b.score-a.score)[0];
    candidates.push({start,end,score,label:score>=82?'Svært gode forhold':score>=68?'Gode forhold':score>=52?'Brukbare forhold':'Svake forhold',reason:best.reason});
  }
  candidates.sort((a,b)=>b.score-a.score||new Date(a.start)-new Date(b.start));
  const windows=[];
  for(const candidate of candidates) {
    const overlaps=windows.some(existing=>new Date(candidate.start)<new Date(existing.end)&&new Date(candidate.end)>new Date(existing.start));
    if(!overlaps) windows.push(candidate);
    if(windows.length===3) break;
  }
  return {available:true,windows,source,disclaimer,generatedAt:new Date(now).toISOString()};
}

async function weather(lat, lon) {
  const key = `weather:${lat.toFixed(2)},${lon.toFixed(2)}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
    const json = await fetchJson(url, { 'User-Agent': MET_USER_AGENT });
    const series = json.properties.timeseries;
    const first = series[0];
    const details = first.data.instant.details;
    const next = first.data.next_1_hours || first.data.next_6_hours || {};
    const future = series[Math.min(3, series.length - 1)].data.instant.details;
    const temp = details.air_temperature ?? null;
    const futureTemp = future.air_temperature ?? temp;
    const pressure = details.air_pressure_at_sea_level ?? null;
    const futurePressure = future.air_pressure_at_sea_level ?? pressure;
    const hourly=series.slice(0,36).map(item=>{const instant=item.data?.instant?.details||{},nextHour=item.data?.next_1_hours||{};return {time:item.time,wind:instant.wind_speed??null,windDirection:instant.wind_from_direction??null,cloud:instant.cloud_area_fraction??null,temp:instant.air_temperature??null,pressure:instant.air_pressure_at_sea_level??null,precipitation:nextHour.details?.precipitation_amount??null,symbol:nextHour.summary?.symbol_code||null};});
    return {
      wind:details.wind_speed??null, windDirection:details.wind_from_direction??null, cloud:details.cloud_area_fraction??null,
      temp, precipitation:next.details?.precipitation_amount??null,
      tempTrend:Number.isFinite(temp)&&Number.isFinite(futureTemp)?Number((futureTemp-temp).toFixed(1)):null,
      pressure, pressureTrend:Number.isFinite(pressure)&&Number.isFinite(futurePressure)?Number((futurePressure-pressure).toFixed(1)):null,
      symbol:next.summary?.symbol_code||null, observedAt:first.time, source:'MET Norway', hourly
    };
  });
}

function deriveMarineSummary(json={}) {
  const current=json.current||{};
  const hourly=json.hourly||{};
  const times=Array.isArray(hourly.time)?hourly.time:[];
  const levels=Array.isArray(hourly.sea_level_height_msl)?hourly.sea_level_height_msl:[];
  let index=0;
  if(current.time&&times.length){const target=new Date(current.time).getTime();let best=Infinity;times.forEach((time,i)=>{const distance=Math.abs(new Date(time).getTime()-target);if(distance<best){best=distance;index=i;}});}
  const currentLevel=Number.isFinite(current.sea_level_height_msl)?current.sea_level_height_msl:Number(levels[index]);
  const futureLevel=Number(levels[Math.min(index+3,Math.max(0,levels.length-1))]);
  const tideTrend3h=Number.isFinite(currentLevel)&&Number.isFinite(futureLevel)?Number((futureLevel-currentLevel).toFixed(2)):null;
  const tideState=!Number.isFinite(tideTrend3h)?null:tideTrend3h>0.03?'stigende':tideTrend3h<-0.03?'fallende':'nesten stille';
  let nextHigh=null,nextLow=null;
  for(let i=Math.max(1,index+1);i<Math.min(levels.length-1,index+30);i++){
    const prev=Number(levels[i-1]),cur=Number(levels[i]),next=Number(levels[i+1]);
    if(![prev,cur,next].every(Number.isFinite)) continue;
    if(!nextHigh&&cur>=prev&&cur>next) nextHigh={time:times[i],level:Number(cur.toFixed(2))};
    if(!nextLow&&cur<=prev&&cur<next) nextLow={time:times[i],level:Number(cur.toFixed(2))};
    if(nextHigh&&nextLow) break;
  }
  return {
    seaTemp:Number.isFinite(current.sea_surface_temperature)?current.sea_surface_temperature:null,
    waveHeight:Number.isFinite(current.wave_height)?current.wave_height:null,
    waveDirection:Number.isFinite(current.wave_direction)?current.wave_direction:null,
    wavePeriod:Number.isFinite(current.wave_period)?current.wave_period:null,
    seaLevel:Number.isFinite(currentLevel)?Number(currentLevel.toFixed(2)):null,
    currentVelocity:Number.isFinite(current.ocean_current_velocity)?current.ocean_current_velocity:null,
    currentDirection:Number.isFinite(current.ocean_current_direction)?current.ocean_current_direction:null,
    tideTrend3h,tideState,nextHigh,nextLow,observedAt:current.time||null,source:'Open-Meteo Marine',
    caveat:'Tidevann og havstrøm er modellverdier med begrenset nøyaktighet nær kysten; ikke bruk dem til navigasjon.'
  };
}

async function marine(lat,lon) {
  const key=`marine:${lat.toFixed(2)},${lon.toFixed(2)}`;
  return cached(key,10*60*1000,async()=>{
    const params=new URLSearchParams({
      latitude:lat.toFixed(4),longitude:lon.toFixed(4),timezone:'Europe/Oslo',forecast_days:'2',
      current:'wave_height,wave_direction,wave_period,sea_surface_temperature,sea_level_height_msl,ocean_current_velocity,ocean_current_direction',
      hourly:'wave_height,wave_direction,wave_period,sea_surface_temperature,sea_level_height_msl,ocean_current_velocity,ocean_current_direction'
    });
    return deriveMarineSummary(await fetchJson(`https://marine-api.open-meteo.com/v1/marine?${params}`,{'User-Agent':MET_USER_AGENT},8000));
  });
}

function stationCoordinates(station={}) {
  const lat=Number(station.latitude??station.lat??station.location?.latitude??station.coordinate?.latitude);
  const lon=Number(station.longitude??station.lon??station.lng??station.location?.longitude??station.coordinate?.longitude);
  return Number.isFinite(lat)&&Number.isFinite(lon)?{lat,lon}:null;
}
function latestObservation(series={}) {
  const observations=series.observations||series.data||series.values||[];
  const item=Array.isArray(observations)?observations.at(-1):null;
  const value=Number(item?.value??item?.observationValue??item?.v);
  return Number.isFinite(value)?{value,time:item?.time??item?.referenceTime??item?.dateTime??null}:null;
}
async function hydrology(lat,lon) {
  if(!NVE_API_KEY) return {available:false,source:'NVE HydAPI',reason:'NVE_API_KEY er ikke konfigurert på serveren.',setup:'Legg gratis NVE HydAPI-nøkkel inn som miljøvariabel NVE_API_KEY.'};
  return cached(`hydrology:${lat.toFixed(2)},${lon.toFixed(2)}`,20*60*1000,async()=>{
    const headers={'User-Agent':MET_USER_AGENT,'X-API-Key':NVE_API_KEY,'Accept':'application/json'};
    const stationsJson=await cached('nve:stations:active',4*60*60*1000,()=>fetchJson('https://hydapi.nve.no/api/v1/Stations?Active=OnlyActive',headers,12000));
    const stations=Array.isArray(stationsJson?.data)?stationsJson.data:Array.isArray(stationsJson)?stationsJson:[];
    const nearest=stations.map(station=>{const c=stationCoordinates(station);return c?{station,c,distanceM:distanceMeters(lat,lon,c.lat,c.lon)}:null;}).filter(Boolean).sort((a,b)=>a.distanceM-b.distanceM)[0];
    if(!nearest) return {available:false,source:'NVE HydAPI',reason:'Fant ingen NVE-stasjon med koordinater.'};
    const stationId=nearest.station.stationId??nearest.station.id;
    const stationName=nearest.station.stationName??nearest.station.name??String(stationId||'NVE-stasjon');
    if(!stationId) return {available:false,source:'NVE HydAPI',reason:'Nærmeste stasjon mangler stasjons-ID.'};
    const params=new URLSearchParams({StationId:String(stationId),Parameter:'1000,1001,1003'});
    const obs=await fetchJson(`https://hydapi.nve.no/api/v1/Observations?${params}`,headers,10000);
    const series=Array.isArray(obs?.data)?obs.data:[];
    const values={};
    for(const item of series){const parameter=Number(item.parameter??item.parameterId);const last=latestObservation(item);if(!last)continue;if(parameter===1000)values.stage=last;if(parameter===1001)values.discharge=last;if(parameter===1003)values.waterTemp=last;}
    return {available:true,source:'NVE HydAPI',stationId:String(stationId),stationName,distanceM:Math.round(nearest.distanceM),...values,caveat:nearest.distanceM>20000?'Nærmeste målestasjon er over 20 km unna og bør bare brukes som regional referanse.':'Målestasjonen kan ligge i et annet vassdrag; bruk dataene som referanse, ikke som lokal fasit.'};
  });
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z; const latRad = lat * Math.PI / 180;
  const x = (lon + 180) / 360 * n;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { xi: Math.floor(x), yi: Math.floor(y), px: Math.floor((x % 1) * 256), py: Math.floor((y % 1) * 256) };
}
async function getOsmPngTile(x, y, z) {
  return cached(`tile:${z}:${x}:${y}`, 12 * 60 * 60 * 1000, async () => {
    const sub = ['a','b','c'][Math.abs(x + y) % 3];
    return pngParser().sync.read(await fetchBuffer(`https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`, { 'User-Agent': MET_USER_AGENT }));
  });
}
async function isWater(lat, lon, zoom = 14) {
  const z = clamp(Math.round(zoom), 13, 15); const tile = lonLatToTile(lon, lat, z); const png = await getOsmPngTile(tile.xi, tile.yi, z);
  let votes = 0;
  for (const [dx,dy] of [[0,0],[2,0],[-2,0],[0,2],[0,-2]]) {
    const x = clamp(tile.px + dx, 0, 255), y = clamp(tile.py + dy, 0, 255), i = (y * png.width + x) * 4;
    const [r,g,b,a] = [png.data[i],png.data[i+1],png.data[i+2],png.data[i+3]];
    if (a > 200 && b >= 170 && g >= 155 && r <= 210 && b - r >= 10) votes++;
  }
  return votes >= 3;
}

async function nearCoastInfo(lat, lon, width, height, zoom) {
  if (!(await isWater(lat, lon, zoom))) return null;
  const dLon = clamp(width * 0.018, 0.00055, 0.0022), dLat = clamp(height * 0.026, 0.00045, 0.0018);
  const dirs = [{lat,lon:lon+dLon,vx:1,vy:0},{lat,lon:lon-dLon,vx:-1,vy:0},{lat:lat+dLat,lon,vx:0,vy:1},{lat:lat-dLat,lon,vx:0,vy:-1},{lat:lat+dLat,lon:lon+dLon,vx:1,vy:1},{lat:lat+dLat,lon:lon-dLon,vx:-1,vy:1},{lat:lat-dLat,lon:lon+dLon,vx:1,vy:-1},{lat:lat-dLat,lon:lon-dLon,vx:-1,vy:-1}];
  const land = [];
  for (const direction of dirs) if (!(await isWater(direction.lat, direction.lon, zoom))) land.push(direction);
  if (!land.length) return null;
  const avg = land.reduce((a,d) => ({ vx:a.vx+d.vx, vy:a.vy+d.vy }), {vx:0,vy:0});
  const normal = Math.atan2(avg.vy, avg.vx);
  return { tangent: normal + Math.PI / 2, coastNormal: ((normal * 180 / Math.PI) + 360) % 360, landCount: land.length, quality: clamp(land.length / 4, 0.25, 1) };
}
function makeRibbon(lat, lon, angle, length, width) {
  const dx=Math.cos(angle),dy=Math.sin(angle),px=-dy,py=dx,left=[],right=[],count=10;
  for (let i=0;i<count;i++) { const t=i/(count-1)-0.5,wob=Math.sin(i*1.4)*0.12,cx=lon+dx*length*t+px*width*wob,cy=lat+dy*length*t*0.62+py*width*wob*0.42,local=width*(0.45+0.55*Math.sin(Math.PI*i/(count-1))); left.push([cy+py*local*0.6,cx+px*local]); right.unshift([cy-py*local*0.6,cx-px*local]); }
  return left.concat(right);
}
async function polygonMostlyWater(poly, zoom) {
  const center=poly.reduce((a,p)=>[a[0]+p[0]/poly.length,a[1]+p[1]/poly.length],[0,0]); const samples=[center,...poly.filter((_,i)=>i%3===0).slice(0,7)]; let ok=0;
  for (const [lat,lon] of samples) if (await isWater(lat,lon,zoom)) ok++;
  return ok >= Math.ceil(samples.length*0.7);
}
function freshwaterCandidateGrid(areas=[],{west,south,east,north}={}) {
  const points=[];
  const viewWidth=Math.max(east-west,Number.EPSILON),viewHeight=Math.max(north-south,Number.EPSILON);
  for(const area of areas) {
    if(!Array.isArray(area.ring)||area.ring.length<4) continue;
    const minLat=Math.max(south,Math.min(...area.ring.map(point=>point.lat)));
    const maxLat=Math.min(north,Math.max(...area.ring.map(point=>point.lat)));
    const minLon=Math.max(west,Math.min(...area.ring.map(point=>point.lon)));
    const maxLon=Math.min(east,Math.max(...area.ring.map(point=>point.lon)));
    if(!(minLat<maxLat&&minLon<maxLon)) continue;
    const rows=clamp(Math.ceil((maxLat-minLat)/viewHeight*28),6,28);
    const cols=clamp(Math.ceil((maxLon-minLon)/viewWidth*40),6,40);
    for(let row=0;row<rows;row++) for(let col=0;col<cols;col++) {
      const lat=minLat+(row+.5)*(maxLat-minLat)/rows;
      const lon=minLon+(col+.5)*(maxLon-minLon)/cols;
      if(!pointIsInFreshwaterArea(lat,lon,area)) continue;
      points.push({lat,lon,seed:Math.sin(lat*911+lon*613)});
    }
  }
  return points.sort((a,b)=>b.seed-a.seed).slice(0,MAX_ZONE_CANDIDATES);
}

function candidateGrid(west,south,east,north,fishType='sjoorret') {
  const points=[]; const rows=28,cols=40;
  const speciesSalt={sjoorret:0,makrell:7.31,sei:13.77}[fishType]||0;
  for(let r=1;r<rows;r++) for(let c=1;c<cols;c++) { if((r*11+c*7)%3) continue; const lon=west+(east-west)*c/cols,lat=south+(north-south)*r/rows; points.push({lat,lon,seed:Math.sin(lat*911+lon*613+speciesSalt)}); }
  return points.sort((a,b)=>b.seed-a.seed).slice(0,MAX_ZONE_CANDIDATES);
}
async function generateZones({west,south,east,north,zoom}, currentWeather, selectedFishType='sjoorret', options={}) {
  const goal=normalizeGoal(options.goal);
  const zoneLimit=clamp(Number(options.limit)||MAX_ZONE_COUNT,1,MAX_ZONE_COUNT);
  const base=Number.isFinite(options.baseLat)&&Number.isFinite(options.baseLon)?{lat:options.baseLat,lon:options.baseLon}:null;
  const radiusM=Number.isFinite(options.radiusM)&&options.radiusM>0?clamp(options.radiusM,100,10000):null;
  const fishType = normalizeFishType(selectedFishType);
  const marineConditions = options.marine || null;
  const moon = options.moon || moonInfo();
  const environment = {...(currentWeather||{}),...(marineConditions||{}),moonIllumination:moon.illumination};
  const freshwater = isFreshwaterFish(fishType);
  const waterType = freshwater ? 'freshwater' : 'saltwater';
  const width=east-west,height=north-south,zones=[]; let tested=0,rejected=0,maskError=null,depthError=null,freshwaterMaskError=null,restrictedWaters=0;
  let freshwaterAreas=[];
  let freshwaterLookup='OSM vannpolygoner';
  let freshwaterRasterFallback=false;
  let freshwaterProviderWarning=null;
  if(freshwater) {
    try {
      freshwaterAreas=await fetchFreshwaterAreas({west,south,east,north});
      if(!freshwaterAreas.length) {
        freshwaterRasterFallback=true;
        freshwaterLookup='OSM vannflate (rasterkontroll)';
        freshwaterProviderWarning='OSM-polygonoppslaget ga ingen vann; kartflisene brukes som sikker vannkontroll.';
      }
    } catch(error) {
      // Fiste-motorens robuste reserve: bruk OSM-kartflisene direkte. Et punkt
      // godtas bare dersom rastertesten bekrefter vann og finner vannkant.
      freshwaterRasterFallback=true;
      freshwaterLookup='OSM vannflate (rasterkontroll)';
      freshwaterProviderWarning='OSM-polygonoppslaget svarte ikke; kartflisene brukes som sikker vannkontroll.';
    }
  }
  const candidates=freshwater
    ? (freshwaterRasterFallback ? candidateGrid(west,south,east,north,'orret') : freshwaterCandidateGrid(freshwaterAreas,{west,south,east,north}))
    : candidateGrid(west,south,east,north,fishType);
  for (const point of candidates) {
    if (zones.length>=zoneLimit) break; tested++;
    try {
      if(base&&radiusM&&distanceMeters(base.lat,base.lon,point.lat,point.lon)>radiusM){rejected++;continue;}
      if(!freshwater&&isNearOfficialNoFishingZone(point.lat,point.lon)){restrictedWaters++;rejected++;continue;}
      const freshwaterArea=freshwater&&!freshwaterRasterFallback?freshwaterAtPoint(point.lat,point.lon,freshwaterAreas):null;
      if(freshwater&&!freshwaterRasterFallback&&!freshwaterArea){rejected++;continue;}
      if(freshwaterArea?.restricted){restrictedWaters++;rejected++;continue;}
      const coast=freshwater
        ? (freshwaterArea ? freshwaterCoastInfo(point.lat,point.lon,freshwaterArea) : await nearCoastInfo(point.lat,point.lon,width,height,zoom))
        : await nearCoastInfo(point.lat,point.lon,width,height,zoom);
      if(!coast){rejected++;continue;}
      const polygon=freshwater?[]:makeRibbon(point.lat,point.lon,coast.tangent,width*0.045,width*0.0055);
      const waterConfirmed=freshwater ? true : await polygonMostlyWater(polygon,zoom);
      if(!waterConfirmed){rejected++;continue;}
      const exposure=windExposure(currentWeather?.windDirection,coast.coastNormal); const hour=norwegianHour(); const scoring=computeScore({...environment,coastQuality:coast.quality,exposure,hour,fishType});
      zones.push({id:`zone-${zones.length+1}-${Math.round(point.lat*10000)}-${Math.round(point.lon*10000)}`,score:scoring.score,name:scoring.score>=82?'Svært høy':scoring.score>=68?'Høy':'Moderat',breakdown:scoring.breakdown,polygon,marker:{lat:point.lat,lon:point.lon},distanceM:base?Math.round(distanceMeters(base.lat,base.lon,point.lat,point.lon)):null,castBearing:Math.round(((coast.tangent*180/Math.PI)+360)%360),goal,_point:point,_coast:coast,_exposure:exposure,_hour:hour,_freshwaterName:freshwaterArea?.name||null});
    } catch(error) { maskError=error.message; rejected++; if(tested>12&&!zones.length) break; }
  }
  await Promise.all(zones.map(async zone => {
    let depth=null;
    if (!freshwater) {
      try { depth=await depthAtPoint(zone._point.lat,zone._point.lon); } catch(error) { depthError=error.message; }
    }
    const shallowRisk=freshwater ? false : depth ? depth.meters<=5 || zone._coast.quality>=0.95 : zone._coast.quality>=0.75;
    zone.depth=depth || { meters:null, category:'unknown', source:null, resolutionM:null, estimated:false };
    zone.dataQuality=buildDataQuality({weather:currentWeather,depth,waterType});
    const rescored=computeScore({...environment,coastQuality:zone._coast.quality,exposure:zone._exposure,hour:zone._hour,depthMeters:depth?.meters,fishType});
    zone.score=rescored.score; zone.breakdown=rescored.breakdown;
    if(goal==='big'){ const trophyBonus=fishType==='gjedde'?Math.round(zone._coast.quality*6 + (1-Math.abs(zone._exposure-.45))*4):Math.round(zone._coast.quality*4); zone.breakdown={...zone.breakdown,storfisk:trophyBonus}; zone.score=clamp(zone.score+trophyBonus,0,100); }
    if(freshwater&&zone._freshwaterName){
      const knowledge=sourceKnowledgeAdjustment(zone._freshwaterName,fishType,goal);
      if(knowledge.profile){
        zone.sourceKnowledge={name:knowledge.profile.name,species:knowledge.profile.species||null,confidence:knowledge.profile.sourceConfidence||'limited',populationNote:knowledge.profile.populationNote||null,hiddenGem:Boolean(knowledge.profile.hiddenGem)};
        zone.breakdown={...zone.breakdown,kildekunnskap:knowledge.delta};
        zone.score=clamp(zone.score+knowledge.delta,0,100);
        zone._speciesMismatch=knowledge.mismatch;
      }
    }
    zone.name=zone.score>=82?'Svært høy':zone.score>=68?'Høy':'Moderat';
    zone.lure=recommendLure({...currentWeather,coastQuality:zone._coast.quality,exposure:zone._exposure,hour:zone._hour,lat:zone._point.lat,lon:zone._point.lon,depthMeters:depth?.meters,shallowRisk,fishType,goal});
    if(fishType==='orret'&&isVestfjellaFlyOnly(zone._freshwaterName||'')){ zone.lure=flyOnlyLureAdvice({hour:zone._hour,cloud:currentWeather?.cloud,wind:currentWeather?.wind,lat:zone._point.lat,lon:zone._point.lon}); zone.flyOnly=true; }
    const baseReason=formatReason({ score:zone.score, breakdown:zone.breakdown, weather:environment, coastQuality:zone._coast.quality, exposure:zone._exposure, waterType });
    const waterName=zone._freshwaterName?` i ${zone._freshwaterName}`:'';
    const fishReason=fishType==='makrell'?'Makrell: sonen gir kystnært, åpnere vann der stimer kan trekke forbi.':fishType==='sei'?(Number.isFinite(depth?.meters)&&depth.meters>=8?'Sei: sonen har estimert dybde og eksponering som gjør den aktuell.':Number.isFinite(depth?.meters)?'Sei: grunt kystområde; fisk sluken mot renner eller dypere vann utenfor sonen.':'Sei: dybden er ikke bekreftet; se etter renner og bratte kanter i sjøkartet.'):fishType==='orret'?(zone.flyOnly?`Ferskvannsørret${waterName}: registrert som fluevann; bruk kun flue og fisk vaksoner, odder og innløp.`:`Ferskvannsørret: registrert ferskvann${waterName}; prøv odder, innløp og vindpåvirket bredde.`):fishType==='abbor'?`Abbor: registrert ferskvann${waterName}; fisk av vannkanten og se etter siv, stein, brygger eller annen struktur.`:fishType==='gjedde'?`Gjedde: registrert ferskvann${waterName}; avfisk grunne kanter og vegetasjon; bruk større agn enn bildet dersom fisken er grov.`:'';
    const knowledgeReason=zone.sourceKnowledge?.populationNote?` Kildekunnskap: ${zone.sourceKnowledge.populationNote}`:'';
    zone.reason=fishReason?`${fishReason} ${baseReason}${knowledgeReason}`:`${baseReason}${knowledgeReason}`;
    if(goal==='big') zone.reason=`Stor-fisk-modus prioriterer tydelig struktur og kantsoner. ${zone.reason}`;
    if(zone._freshwaterName) zone.waterName=zone._freshwaterName;
    delete zone._point; delete zone._coast; delete zone._exposure; delete zone._hour; delete zone._freshwaterName;
  }));
  // Raster-reserven er ikke en nedgradering av landmasken: også der godtas bare
  // punkter som OSM-kartflisen faktisk klassifiserer som vann.
  if(freshwater&&freshwaterRasterFallback&&!zones.length) freshwaterMaskError=maskError||'Ingen vannflater kunne bekreftes i valgt utsnitt.';
  const warning=[maskError&&!freshwaterRasterFallback?'Vannmasken svarte ikke; prøv igjen om litt.':null,freshwaterProviderWarning, freshwaterMaskError?'Ingen sikre ferskvannssoner kunne bekreftes i valgt utsnitt. Zoom litt nærmere eller prøv igjen.':null,restrictedWaters?'Vann merket med fiskeforbud eller adgangsforbud er filtrert bort.':null,depthError?'Dybdeestimat er midlertidig utilgjengelig for noen soner.':null].filter(Boolean).join(' ')||null;
  const source=freshwater?`${freshwaterLookup} + sikker vannkant + MET Norway`:`OSM vannmaske + Kartverket sjøkart + EMODnet dybdeestimat + MET Norway${marineConditions?' + Open-Meteo Marine':''}`;
  return {zones:zones.filter(z=>!z._speciesMismatch).map(z=>{delete z._speciesMismatch;return z;}).sort((a,b)=>b.score-a.score),stats:{tested,rejected,goal,base,radiusM,strictLandmask:true,waterType,waterMaskAvailable:zones.length>0||(!maskError&&!freshwaterMaskError),freshwaterAreas:freshwater?freshwaterAreas.length:null,freshwaterLookup:freshwater?freshwaterLookup:null,rasterFallback:freshwater?freshwaterRasterFallback:false,restrictedWaters,depthAvailable:zones.filter(z=>Number.isFinite(z.depth?.meters)).length,depthResolutionM:freshwater?null:125,warning,generatedAt:new Date().toISOString(),source}};
}

async function boatRamps({west,south,east,north}) {
  const key=`ramps:${west.toFixed(2)},${south.toFixed(2)},${east.toFixed(2)},${north.toFixed(2)}`;
  return cached(key,30*60*1000,async()=>{
    const query=`[out:json][timeout:12];(node[\"leisure\"=\"slipway\"](${south},${west},${north},${east});way[\"leisure\"=\"slipway\"](${south},${west},${north},${east});relation[\"leisure\"=\"slipway\"](${south},${west},${north},${east}););out center tags;`;
    const endpoints=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
    let lastError=null;
    for(const endpoint of endpoints){
      try{
        const json=JSON.parse(await postFormText(endpoint,{data:query},14000));
        const ramps=(json.elements||[]).map(item=>{const lat=Number(item.lat??item.center?.lat),lon=Number(item.lon??item.center?.lon);if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;return {id:`${item.type}/${item.id}`,lat,lon,name:item.tags?.name||'Båtrampe / slip',access:item.tags?.access||null,fee:item.tags?.fee||null,surface:item.tags?.surface||null,source:'OpenStreetMap'};}).filter(Boolean).slice(0,80);
        return {ramps,source:'OpenStreetMap',generatedAt:new Date().toISOString()};
      }catch(error){lastError=error;}
    }
    throw lastError||new Error('Båtrampedata svarte ikke');
  });
}

function send(res, code, data, type='application/json; charset=utf-8', extraHeaders={}) {
  res.writeHead(code, {'Content-Type':type,'Access-Control-Allow-Origin':'*','Cache-Control':type.startsWith('application/json')?'no-store':'public, max-age=3600', ...extraHeaders});
  const body=type.startsWith('application/json')&&!Buffer.isBuffer(data)&&typeof data!=='string'?JSON.stringify(data):data;
  res.end(body);
}
async function handleApi(req,res,url) {
  try {
    if(url.pathname==='/api/health') return send(res,200,{ok:true,app:'Vestfjella Fiske',version:'stable-1.2',revision:APP_REVISION,engine:'Fiste REV26 freshwater core',waterDirectory:VESTFJELLA_WATERS.count,nveHydApiConfigured:Boolean(NVE_API_KEY)});
    if(url.pathname==='/api/water-directory') return send(res,200,VESTFJELLA_WATERS);
    if(url.pathname==='/api/water-locate') { const name=String(url.searchParams.get('name')||'').trim(); if(!name||name.length>100) return send(res,400,{error:'Ugyldig vannnavn'}); const located=await locateVestfjellaWater(name); if(!located) return send(res,404,{error:'Fant ikke sikker kartplassering for dette vannet'}); return send(res,200,located); }
    if(url.pathname==='/api/weather') {
      const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon'));
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<57||lat>72||lon<3||lon>32) return send(res,400,{error:'Ugyldig lat/lon for Norge'});
      return send(res,200,await weather(lat,lon));
    }
    if(url.pathname==='/api/marine') {
      const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon'));
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<57||lat>72||lon<3||lon>32) return send(res,400,{error:'Ugyldig lat/lon for norskekysten'});
      return send(res,200,await marine(lat,lon));
    }
    if(url.pathname==='/api/hydrology') {
      const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon'));
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<57||lat>72||lon<3||lon>32) return send(res,400,{error:'Ugyldig lat/lon for Norge'});
      return send(res,200,await hydrology(lat,lon));
    }
    if(url.pathname==='/api/ramps') {
      let input;try{input=validateZoneRequest(url.searchParams.get('bbox'),url.searchParams.get('zoom')||'12');}catch(error){return send(res,400,{error:error.message});}
      return send(res,200,await boatRamps(input));
    }
    if(url.pathname==='/api/zones') {
      let input,fishSelection;
      try{input=validateZoneRequest(url.searchParams.get('bbox'),url.searchParams.get('zoom')||'12');fishSelection=normalizeFishSelection(url.searchParams.get('fish')||'sjoorret');}
      catch(error){return send(res,400,{error:error.message});}
      const goal=normalizeGoal(url.searchParams.get('goal'));
      const baseLatText=url.searchParams.get('baseLat'),baseLonText=url.searchParams.get('baseLon'),radiusText=url.searchParams.get('radiusM');
      const baseLat=baseLatText===null?NaN:Number(baseLatText),baseLon=baseLonText===null?NaN:Number(baseLonText),radiusM=radiusText===null?NaN:Number(radiusText);
      const hasBase=Number.isFinite(baseLat)&&Number.isFinite(baseLon)&&baseLat>=57&&baseLat<=72&&baseLon>=3&&baseLon<=32;
      const hasRadius=hasBase&&Number.isFinite(radiusM)&&radiusM>0;
      // Med aktivt avstandsfilter analyserer vi området rundt basen, ikke et gammelt/tilfeldig kartutsnitt.
      if(hasRadius) input=searchBoundsForBase(baseLat,baseLon,radiusM,input.zoom);
      const allMode=fishSelection==='all';
      if((allMode||isFreshwaterFish(fishSelection))&&(input.east-input.west>0.5||input.north-input.south>0.5)) return send(res,400,{error:'Zoom nærmere Vestfjella for ferskvannsanalyse.'});
      const lat=(input.south+input.north)/2,lon=(input.west+input.east)/2;
      let current=null,marineConditions=null,weatherWarning=null,marineWarning=null;
      const moon=moonInfo();
      const tasks=[weather(lat,lon).then(value=>{current=value;}).catch(()=>{weatherWarning='Værdata er midlertidig utilgjengelig.';})];
      if(!allMode&&!isFreshwaterFish(fishSelection)) tasks.push(marine(lat,lon).then(value=>{marineConditions=value;}).catch(()=>{marineWarning='Marine modelldata er midlertidig utilgjengelig.';}));
      await Promise.all(tasks);
      if(allMode){
        const freshTypes=['orret','abbor'];
        const results=[];
        // Samme stabile vannmaske-motor som i Fiste: analyser faktisk OSM-vanngeometri, ikke gamle estimerte punkt.
        for(const type of freshTypes) results.push(await generateZones(input,current,type,{goal:'numbers',baseLat,baseLon,radiusM,moon,limit:12}));
        const zones=results.flatMap((result,groupIndex)=>result.zones.slice(0,6).map((zone,index)=>({...zone,id:`${freshTypes[groupIndex]}-${zone.id}`,fishType:freshTypes[groupIndex],fishLabel:FISH_TYPES[freshTypes[groupIndex]],speciesRank:index+1}))).sort((a,b)=>b.score-a.score);
        const stats={tested:results.reduce((sum,r)=>sum+(r.stats.tested||0),0),rejected:results.reduce((sum,r)=>sum+(r.stats.rejected||0),0),goal:'numbers',base:hasBase?{lat:baseLat,lon:baseLon}:null,radiusM:hasRadius?radiusM:null,strictLandmask:true,waterType:'freshwater',waterMaskAvailable:results.every(r=>r.stats.waterMaskAvailable!==false),restrictedWaters:Math.max(...results.map(r=>r.stats.restrictedWaters||0)),depthAvailable:0,depthResolutionM:null,generatedAt:new Date().toISOString(),source:'Flerartsanalyse: ørret + abbor · faktisk OSM-vanngeometri + MET Norway'};
        const publicWeather=current?{...current}:null;if(publicWeather) delete publicWeather.hourly;
        const bestTimes=bestFishingTimes(current?.hourly||[],'orret');
        const resultWarnings=results.map(r=>r.stats.warning).filter(Boolean);
        return send(res,200,{zones,stats,fishType:'all',fishLabel:'Alle ferskvannsarter',weather:publicWeather,marine:null,moon,bestTimes,warnings:[weatherWarning,...resultWarnings].filter(Boolean)});
      }
      const fishType=fishSelection;
      const result=await generateZones(input,current,fishType,{goal,baseLat,baseLon,radiusM,marine:marineConditions,moon});
      result.zones=result.zones.map(zone=>({...zone,fishType,fishLabel:FISH_TYPES[fishType]}));
      const bestTimes=bestFishingTimes(current?.hourly||[],fishType);
      const publicWeather=current?{...current}:null;if(publicWeather) delete publicWeather.hourly;
      return send(res,200,{...result,fishType,fishLabel:FISH_TYPES[fishType],weather:publicWeather,marine:marineConditions,moon,bestTimes,warnings:[weatherWarning,marineWarning,result.stats.warning].filter(Boolean)});
    }
    return send(res,404,{error:'Ukjent API'});
  } catch(error) { return send(res,500,{error:error.message||String(error)}); }
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
function createServer() {
  return http.createServer((req,res)=>{ const url=new URL(req.url,`http://${req.headers.host||'localhost'}`); if(url.pathname.startsWith('/api/')) return handleApi(req,res,url); const relative=url.pathname==='/'?'index.html':url.pathname.replace(/^\/+/, ''); const full=path.resolve(PUBLIC_DIR,relative); if(!full.startsWith(PUBLIC_DIR+path.sep)&&full!==path.join(PUBLIC_DIR,'index.html')) return send(res,403,'Forbudt','text/plain; charset=utf-8'); fs.readFile(full,(error,data)=>{ if(error) return send(res,404,'Ikke funnet','text/plain; charset=utf-8'); const noStore = ['index.html','sw.js','manifest.webmanifest'].includes(relative) || /^(app|style|fishing-insights)\.(js|css)$/.test(relative); return send(res,200,data,mime[path.extname(full)]||'application/octet-stream',noStore?{'Cache-Control':'no-store, max-age=0'}:{}); }); });
}
function startServer(port=PORT) { const server=createServer(); return server.listen(port,()=>{ let ip='localhost'; for(const list of Object.values(os.networkInterfaces())) for(const item of list||[]) if(item.family==='IPv4'&&!item.internal) ip=item.address; console.log(`Vestfjella Fiske kjører på http://${ip}:${port}`); }); }
if(require.main===module) startServer();
module.exports={computeScore,environmentalScoreAdjustments,moonInfo,deriveMarineSummary,marine,hydrology,boatRamps,validateZoneRequest,createBoundedCache,windExposure,formatReason,recommendLure,lureCatalog,flyOnlyLureAdvice,isVestfjellaFlyOnly,parseDepthFeatureInfo,depthAtPoint,norwegianHour,buildDataQuality,normalizeFishType,normalizeFishSelection,searchBoundsForBase,isFreshwaterFish,isNearOfficialNoFishingZone,parseFreshwaterAreas,freshwaterAtPoint,freshwaterCandidateGrid,freshwaterCoastInfo,polygonMostlyInFreshwater,parseNominatimWater,fetchNominatimWater,fetchFreshwaterAreas,bestFishingTimes,MAX_ZONE_COUNT,MAX_ZONE_CANDIDATES,FISH_TYPES,VESTFJELLA_WATERS,VESTFJELLA_BOUNDS,normalizeWaterLookupName,waterNameSimilarity,matchFreshwaterAreaByName,createServer,startServer,weather,generateZones};
