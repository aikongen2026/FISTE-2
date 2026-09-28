const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
let PNG = null;
function pngParser(){ if(!PNG) ({PNG}=require('pngjs')); return PNG; }
const PACKAGE = require('./package.json');
const APP_REVISION = 'STABLE 1.7';

const PORT = Number(process.env.PORT || 3000);
const NVE_API_KEY = String(process.env.NVE_API_KEY || '').trim();
const MET_USER_AGENT = process.env.MET_USER_AGENT || 'vestfjella-fiske/1.7 (https://github.com/aikongen2026/FISTE-2)';
const PUBLIC_DIR = path.join(__dirname, 'public');
const OPEN_LURE_PHOTOS = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'lures','open','catalog.json'),'utf8')).photos;
const OPEN_LURE_PHOTO_BY_ID = Object.freeze(Object.fromEntries(OPEN_LURE_PHOTOS.map(photo=>[photo.id,photo])));
const USER_LURE_DATA = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'data','user-lures.json'),'utf8'));
const SOURCE_BACKED_LURE_DATA = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'data','source-backed-lures.json'),'utf8'));
const SOURCE_BACKED_LURES = Object.freeze(SOURCE_BACKED_LURE_DATA.lures);
const OFFICIAL_RESTRICTION_DATA = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'data','fishing-restrictions-2024.json'),'utf8'));
const OFFICIAL_NO_FISHING_ZONES = OFFICIAL_RESTRICTION_DATA.zones;
const MAX_ZONE_COUNT = 12;
const MAX_ZONE_CANDIDATES = 120;
const FISH_TYPES = Object.freeze({
  sjoorret:'Sjøørret', makrell:'Makrell', sei:'Sei',
  orret:'Ørret (ferskvann)', abbor:'Abbor', gjedde:'Gjedde'
});
const FRESHWATER_FISH_TYPES = new Set(['orret','abbor','gjedde']);
const VESTFJELLA_WATERS = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR,'data','vestfjella-waters.json'),'utf8'));
const VESTFJELLA_BOUNDS = Object.freeze({west:11.5700,south:59.2370,east:11.6065,north:59.2915});
const VESTFJELLA_FLY_ONLY = new Set(['saetertjern','setertjern','midtre ormtjern','stubbetjern','skogtjern 2']);



// Vestfjella-specific directory, rules and fly-only logic.
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


// REV30: compact HSI-inspired analysis. Habitat and live conditions are scored separately,
// while confidence reports how much source data was actually available.
function rangeSuitability(value, idealMin, idealMax, outerMin, outerMax) {
  if (!Number.isFinite(value)) return null;
  if (value >= idealMin && value <= idealMax) return 100;
  if (value < outerMin || value > outerMax) return 12;
  if (value < idealMin) return Math.round(40 + 60 * (value - outerMin) / Math.max(.001, idealMin - outerMin));
  return Math.round(40 + 60 * (outerMax - value) / Math.max(.001, outerMax - idealMax));
}
function weightedAverage(parts = []) {
  const valid=parts.filter(part=>Number.isFinite(part?.score)&&Number.isFinite(part?.weight)&&part.weight>0);
  if(!valid.length) return null;
  const totalWeight=valid.reduce((sum,part)=>sum+part.weight,0);
  return Math.round(valid.reduce((sum,part)=>sum+part.score*part.weight,0)/totalWeight);
}
function destinationPoint(lat,lon,bearingDeg,distanceM){
  const R=6371000,brg=bearingDeg*Math.PI/180,phi1=lat*Math.PI/180,lambda1=lon*Math.PI/180,delta=distanceM/R;
  const phi2=Math.asin(Math.sin(phi1)*Math.cos(delta)+Math.cos(phi1)*Math.sin(delta)*Math.cos(brg));
  const lambda2=lambda1+Math.atan2(Math.sin(brg)*Math.sin(delta)*Math.cos(phi1),Math.cos(delta)-Math.sin(phi1)*Math.sin(phi2));
  return {lat:phi2*180/Math.PI,lon:((lambda2*180/Math.PI+540)%360)-180};
}
function depthSuitability(fishType,meters){
  if(!Number.isFinite(meters)) return null;
  if(fishType==='sjoorret') return meters<=.7?58:meters<=5?100:meters<=10?88:meters<=18?66:38;
  if(fishType==='makrell') return meters<3?40:meters<=8?72:meters<=35?96:meters<=60?82:58;
  if(fishType==='sei') return meters<4?28:meters<=8?62:meters<=35?98:meters<=70?86:65;
  if(fishType==='orret') return meters<=1?82:meters<=6?100:meters<=15?82:62;
  if(fishType==='abbor') return meters<=1?72:meters<=8?100:meters<=15?86:68;
  if(fishType==='gjedde') return meters<=1?90:meters<=5?100:meters<=10?82:60;
  return 70;
}
function classifyQuickStructure(depth,offshoreDepth,distanceM=280){
  if(!Number.isFinite(depth)||!Number.isFinite(offshoreDepth)) return {available:false,label:'Struktur ikke beregnet',score:null,slopeMPer100:null,depthDelta:null,offshoreDepth:Number.isFinite(offshoreDepth)?offshoreDepth:null,offshoreDistanceM:distanceM};
  const delta=offshoreDepth-depth;
  const slope=Math.abs(delta)/Math.max(1,distanceM)*100;
  let label='Slak overgang',score=62;
  if(slope>=2.2){label='Bratt marbakke / kant';score=98;}
  else if(slope>=1.15){label='Tydelig dybdekant';score=90;}
  else if(slope>=.55){label='Moderat dybdeovergang';score=78;}
  else if(depth<=5&&offshoreDepth<=7){label='Grunt, relativt flatt område';score=67;}
  else {label='Jevn / svak dybdeendring';score=58;}
  return {available:true,label,score,slopeMPer100:Number(slope.toFixed(1)),depthDelta:Number(delta.toFixed(1)),offshoreDepth:Number(offshoreDepth.toFixed(1)),offshoreDistanceM:distanceM};
}
function computeLiveScore(input={}){
  const fishType=normalizeFishType(input.fishType);
  const factors=[];
  const add=(key,label,score,weight)=>{if(Number.isFinite(score))factors.push({key,label,score:clamp(Math.round(score),0,100),weight});};
  const wind=Number(input.wind),cloud=Number(input.cloud),hour=Number.isFinite(input.hour)?input.hour:12,exposure=Number(input.exposure);
  if(fishType==='sjoorret') add('vind','Vindstyrke',rangeSuitability(wind,2,8,.3,13),18);
  else if(fishType==='makrell') add('vind','Vindstyrke',rangeSuitability(wind,1.5,9,.2,14),15);
  else if(fishType==='sei') add('vind','Vindstyrke',rangeSuitability(wind,1.5,10,.2,15),15);
  else add('vind','Vindstyrke',rangeSuitability(wind,.8,6,0,11),18);
  if(Number.isFinite(exposure)){
    const expScore=fishType==='sjoorret'?clamp(45+exposure*60,0,100):fishType==='sei'||fishType==='makrell'?clamp(42+exposure*58,0,100):clamp(100-Math.abs(exposure-.55)*90,20,100);
    add('eksponering','Vind mot området',expScore,14);
  }
  if(Number.isFinite(cloud)){
    const cloudScore=fishType==='sjoorret'||fishType==='orret'?clamp(48+cloud*.52,35,100):fishType==='makrell'?clamp(96-Math.max(0,cloud-70)*.8,45,100):clamp(58+cloud*.35,45,96);
    add('skydekke','Lys / skydekke',cloudScore,10);
  }
  const lowLight=hour<=9||hour>=18;
  const timeScore=(fishType==='sjoorret'||fishType==='orret')?(lowLight?100:68):fishType==='sei'?(hour<=9||hour>=17?94:76):(hour>=6&&hour<=21?92:58);
  add('tidspunkt','Tidspunkt',timeScore,8);
  const seaTemp=Number(input.seaTemp),airTemp=Number(input.temp);
  if(!FRESHWATER_FISH_TYPES.has(fishType)){
    if(fishType==='sjoorret') add('sjoetemperatur','Sjøtemperatur',rangeSuitability(seaTemp,5,16,1,20),17);
    else if(fishType==='makrell') add('sjoetemperatur','Sjøtemperatur',rangeSuitability(seaTemp,12,22,7,25),17);
    else add('sjoetemperatur','Sjøtemperatur',rangeSuitability(seaTemp,6,16,2,21),17);
    const wave=Number(input.waveHeight);
    if(fishType==='sjoorret') add('boelger','Bølger',rangeSuitability(wave,.15,.9,0,1.8),9);
    else if(fishType==='makrell') add('boelger','Bølger',rangeSuitability(wave,.05,.9,0,1.9),8);
    else add('boelger','Bølger',rangeSuitability(wave,.1,1.2,0,2.4),8);
    const current=Number(input.currentVelocity);
    add('havstroem','Havstrøm',rangeSuitability(current,.12,fishType==='sei'?2.5:1.8,0,4.5),8);
    const tide=Number(input.tideTrend3h);
    if(Number.isFinite(tide)) add('tidevann','Tidevann',fishType==='sjoorret'?(tide>=.04?100:tide<=-.04?78:58):(Math.abs(tide)>=.03?90:64),7);
  } else {
    if(fishType==='orret') add('lufttemperatur','Lufttemperatur',rangeSuitability(airTemp,5,17,-2,24),18);
    else if(fishType==='abbor') add('lufttemperatur','Lufttemperatur',rangeSuitability(airTemp,11,24,3,30),18);
    else add('lufttemperatur','Lufttemperatur',rangeSuitability(airTemp,7,20,0,28),18);
  }
  const pressureTrend=Number(input.pressureTrend);
  if(Number.isFinite(pressureTrend)) add('lufttrykk','Trykktrend',pressureTrend<=1.5&&pressureTrend>=-3?88:pressureTrend>4?48:70,4);
  const score=weightedAverage(factors)??65;
  return {score,factors,top:factors.slice().sort((a,b)=>b.score-a.score).slice(0,3)};
}
function marineOverlayScore(fishType,habitat={}){
  if(!habitat.serviceAvailable) return null;
  let score=55;
  if(habitat.eelgrass) score+=fishType==='sjoorret'?20:fishType==='sei'?5:8;
  if(habitat.kelp) score+=fishType==='sjoorret'?17:fishType==='sei'?18:10;
  if(habitat.shellSand) score+=fishType==='sjoorret'?11:6;
  if(habitat.softBottom) score+=fishType==='sjoorret'?3:fishType==='makrell'?2:0;
  if(habitat.spawningArea) score+=fishType==='sei'?10:fishType==='makrell'?8:fishType==='sjoorret'?5:4;
  if(habitat.nurseryArea) score+=fishType==='sjoorret'?8:fishType==='sei'?7:6;
  return clamp(score,35,100);
}
function computeHabitatScore({fishType,coastQuality,depth,structure,habitat,goal='numbers'}){
  const parts=[];
  if(Number.isFinite(coastQuality)) parts.push({key:'kyststruktur',label:'Kyst / vannkant',score:clamp(45+coastQuality*55,0,100),weight:32});
  const ds=depthSuitability(fishType,depth?.meters); if(Number.isFinite(ds)) parts.push({key:'dybde',label:'Dybde',score:ds,weight:25});
  if(structure?.available) parts.push({key:'struktur',label:structure.label,score:structure.score,weight:23});
  const overlay=marineOverlayScore(fishType,habitat); if(Number.isFinite(overlay)) parts.push({key:'naturtype',label:'Marine naturtyper',score:overlay,weight:20});
  let score=weightedAverage(parts)??65;
  if(goal==='big'&&structure?.available) score=clamp(score+Math.round((structure.score-60)/20),0,100);
  return {score,factors:parts,top:parts.slice().sort((a,b)=>b.score-a.score).slice(0,3)};
}
function buildAnalysisConfidence({weather=null,marine=null,depth=null,structure=null,habitat=null,waterType='saltwater'}={}){
  const components=[];const add=(key,label,score,weight,note)=>components.push({key,label,score:clamp(Math.round(score),0,100),weight,note});
  const weatherFields=['wind','windDirection','cloud','temp'];const wc=weatherFields.filter(k=>Number.isFinite(weather?.[k])).length;
  if(waterType==='freshwater'){
    add('weather','MET-vær',wc/weatherFields.length*100,35,`${wc}/${weatherFields.length} værfelt`);
    add('coast','Vannkantgeometri',100,25,'OSM vannflate / vannkant');
    add('depth','NVE-dybde',Number.isFinite(depth?.meters)?100:0,25,Number.isFinite(depth?.meters)?`${depth.source||'NVE Dybdekart'} · interpolert fra oppmålte kurver/punkter`:'ingen oppmålt NVE-dybde i utsnittet');
    add('structure','Undervannsstruktur',structure?.available?100:0,15,structure?.available?structure.label:'ikke beregnet uten dybdedata');
  }else{
    add('weather','MET-vær',wc/weatherFields.length*100,20,`${wc}/${weatherFields.length} værfelt`);
    const marineFields=['seaTemp','waveHeight','currentVelocity','tideTrend3h'];const mc=marineFields.filter(k=>Number.isFinite(marine?.[k])).length;
    add('marine','Sjøforhold',mc/marineFields.length*100,24,`${mc}/${marineFields.length} marine felt`);
    add('depth','Dybde',Number.isFinite(depth?.meters)?100:0,20,Number.isFinite(depth?.meters)?`${depth.source||'dybdekilde'} · modellert`:'mangler');
    add('structure','Dybdestruktur',structure?.available?100:0,14,structure?.available?structure.label:'ikke beregnet');
    const coverage=Number(habitat?.serviceCoveragePercent);add('habitat','Marine naturtyper',Number.isFinite(coverage)?coverage:0,17,Number.isFinite(coverage)?`${coverage}% av habitatkildene svarte`:'kildestatus ukjent');
    add('coast','Kystgeometri',100,5,'OSM vannmaske / kystkant');
  }
  const confidence=weightedAverage(components)??0;
  return {confidence,level:confidence>=85?'Svært godt':confidence>=70?'Godt':confidence>=50?'Middels':'Begrenset',components};
}
function analysisSummary({habitatScore,liveScore,structure,habitat}){
  const reasons=[];
  if(structure?.available&&structure.score>=78) reasons.push(structure.label.toLowerCase());
  if(habitat?.eelgrass) reasons.push('ålegras');
  if(habitat?.kelp) reasons.push('tareskog');
  if(habitat?.shellSand) reasons.push('skjellsand');
  if(habitat?.nurseryArea) reasons.push('oppvekstområde');
  if(liveScore?.top?.[0]) reasons.push(liveScore.top[0].label.toLowerCase());
  if(!reasons.length) reasons.push('vannkant og aktuelle forhold');
  return reasons.slice(0,3).join(' · ');
}
function arcgisPointInsideFeature(feature,lat,lon){
  const rings=feature?.geometry?.rings;if(!Array.isArray(rings))return false;
  let hits=0;
  for(const ring of rings){
    const normalized=Array.isArray(ring)?ring.map(pair=>({lat:Number(pair?.[1]),lon:Number(pair?.[0])})).filter(p=>Number.isFinite(p.lat)&&Number.isFinite(p.lon)):[];
    if(normalized.length>=3&&pointInPolygon(lat,lon,normalized)) hits++;
  }
  return hits%2===1;
}
async function arcgisEnvelopeFeatures(url,{west,south,east,north},timeoutMs=2400){
  const params=new URLSearchParams({where:'1=1',geometry:`${west},${south},${east},${north}`,geometryType:'esriGeometryEnvelope',inSR:'4326',spatialRel:'esriSpatialRelIntersects',outFields:'*',returnGeometry:'true',outSR:'4326',f:'json',resultRecordCount:'2000'});
  const json=await fetchJson(`${url}?${params}`,{'User-Agent':MET_USER_AGENT,'Accept':'application/json'},timeoutMs);
  if(json?.error) throw new Error(json.error.message||'ArcGIS-kilde svarte med feil');
  return Array.isArray(json?.features)?json.features:[];
}
async function fetchMarineHabitatContext(bounds){
  const key=`habitat:${bounds.west.toFixed(2)},${bounds.south.toFixed(2)},${bounds.east.toFixed(2)},${bounds.north.toFixed(2)}`;
  return cached(key,20*60*1000,async()=>{
    const md='https://kart3.miljodirektoratet.no/arcgis/rest/services/naturtyper_marine_hb19/FeatureServer';
    const fd='https://gis.fiskeridir.no/server/rest/services/fiskeridirWMS/MapServer';
    const specs=[['kelp',`${md}/1/query`],['softBottom',`${md}/6/query`],['eelgrass',`${md}/7/query`],['shellSand',`${md}/8/query`],['spawningArea',`${fd}/108/query`],['nurseryArea',`${fd}/109/query`]];
    const settled=await Promise.allSettled(specs.map(([,url])=>arcgisEnvelopeFeatures(url,bounds)));
    const layers={};let answered=0;
    settled.forEach((result,index)=>{const name=specs[index][0];if(result.status==='fulfilled'){answered++;layers[name]={available:true,features:result.value};}else layers[name]={available:false,features:[],error:String(result.reason?.message||result.reason||'utilgjengelig')};});
    return {available:answered>0,answered,total:specs.length,coveragePercent:Math.round(answered/specs.length*100),layers,source:'Miljødirektoratet Marine naturtyper (HB19) + Fiskeridirektoratet kystnære fiskeridata'};
  });
}
function marineHabitatAtPoint(lat,lon,context){
  if(!context?.layers) return {serviceAvailable:false,serviceCoveragePercent:0,signals:[]};
  const result={serviceAvailable:Boolean(context.available),serviceCoveragePercent:context.coveragePercent||0,signals:[],source:context.source};
  const labels={kelp:'Tareskog',softBottom:'Bløtbunn',eelgrass:'Ålegras',shellSand:'Skjellsand',spawningArea:'Gyteområde',nurseryArea:'Oppvekst-/beiteområde'};
  for(const [key,layer] of Object.entries(context.layers)){
    const hit=Boolean(layer.available&&layer.features.some(feature=>arcgisPointInsideFeature(feature,lat,lon)));
    result[key]=hit;
    if(hit) result.signals.push(labels[key]||key);
  }
  result.noneRegistered=result.serviceAvailable&&!result.signals.length;
  return result;
}
function legalStatusForPoint(lat,lon){
  const zone=OFFICIAL_NO_FISHING_ZONES.find(item=>{
    if(!item.renderBoundary||!Array.isArray(item.outerBoundary)||item.outerBoundary.length<2) return false;
    const buffer=Math.max(160,Math.min(900,item.lengthM*.55));
    return localDistanceToSegmentM(lat,lon,item.outerBoundary[0],item.outerBoundary.at(-1))<=buffer;
  });
  const regulation=OFFICIAL_RESTRICTION_DATA.regulation||{};
  if(zone) return {blocked:true,status:'Helårsforbud i innlastet regionalt lag',name:zone.name,sourceRef:zone.sourceRef,url:regulation.url||null,regulationId:regulation.id||null,caveat:zone.legalText||'Kontroller alltid gjeldende forskrift.'};
  return {blocked:false,status:'Ingen kjent helårsforbud i innlastet regionalt lag',name:null,sourceRef:null,url:regulation.url||null,regulationId:regulation.id||null,caveat:'Hardfilteret dekker den innlastede regionale forskriften. Lokale regler utenfor dette laget må fortsatt kontrolleres.'};
}
function classifyDepthProfile(samples=[]){
  const valid=samples.filter(s=>Number.isFinite(s.meters));
  if(valid.length<2) return {available:false,label:'For få dybdedata',maxSlopeMPer100:null,rangeM:null};
  let maxSlope=0;
  for(let i=1;i<valid.length;i++){
    const dd=Math.abs(valid[i].meters-valid[i-1].meters),dist=Math.max(1,valid[i].distanceM-valid[i-1].distanceM);
    maxSlope=Math.max(maxSlope,dd/dist*100);
  }
  const depths=valid.map(s=>s.meters),range=Math.max(...depths)-Math.min(...depths);
  let label=maxSlope>=2.2?'Bratt marbakke / kant':maxSlope>=1.1?'Tydelig dybdekant':maxSlope>=.55?'Moderat overgang':'Jevn / flat profil';
  if(valid.length>=4){
    const interior=valid.slice(1,-1),min=interior.reduce((a,b)=>a.meters<b.meters?a:b),max=interior.reduce((a,b)=>a.meters>b.meters?a:b),endMean=(valid[0].meters+valid.at(-1).meters)/2;
    if(endMean-min.meters>=2) label='Grunne / undervannsrygg';
    if(max.meters-endMean>=2) label='Renne / grop';
  }
  return {available:true,label,maxSlopeMPer100:Number(maxSlope.toFixed(1)),rangeM:Number(range.toFixed(1))};
}
async function depthProfileAtPoint(lat,lon,coastNormal){
  const outward=(Number(coastNormal)+180)%360,distances=[0,75,150,300,500];
  const samples=await Promise.all(distances.map(async distanceM=>{
    const point=distanceM?destinationPoint(lat,lon,outward,distanceM):{lat,lon};
    try{const depth=await depthAtPoint(point.lat,point.lon);return {distanceM,lat:Number(point.lat.toFixed(6)),lon:Number(point.lon.toFixed(6)),meters:Number.isFinite(depth?.meters)?depth.meters:null};}
    catch{return {distanceM,lat:Number(point.lat.toFixed(6)),lon:Number(point.lon.toFixed(6)),meters:null};}
  }));
  const classification=classifyDepthProfile(samples);
  return {available:classification.available,kind:'Modellert',source:'EMODnet Bathymetry mean DTM',resolutionM:125,bearing:Math.round(outward),samples,...classification,caveat:'Profilen er modellert fra EMODnet (~125 m). Den er ikke ekkolodd, navigasjonsdata eller en målt lokal dybdeprofil.'};
}

const lureCatalog = Object.freeze(USER_LURE_DATA.lures.map(item=>Object.freeze(item)));

// REV30 keeps the hard species gate from REV29:  These are the user's photographed lures
// that were visually classified as plausible sea-trout tackle.  This intentionally
// excludes the red/white predator plug, dressed compact freshwater spoons and the
// broad red/copper freshwater spoon series even if future metadata is accidentally
// widened again.
const SJOORRET_VERIFIED_LURE_IDS = new Set([
  'own01-01','own01-02','own01-03','own01-04',
  'own05-01','own05-02','own05-03','own05-04','own05-05','own05-06','own05-07','own05-08','own05-09','own05-10',
  'own06-01','own06-02','own06-03',
  'own11-04','own11-05','own11-06',
  'own14-01','own14-02','own14-03','own14-04',
  'own02-01'
]);
function lureIsVerifiedForSpecies(item, fishType) {
  if (fishType === 'sjoorret') return SJOORRET_VERIFIED_LURE_IDS.has(item.id);
  return item.species.includes(fishType);
}

function stableLureNumber(text) {
  let value = 2166136261;
  for (const char of text) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}

function colorTagsFromText(text='') {
  const value=String(text||'').toLocaleLowerCase('no-NO');
  const tags=new Set();
  const rules=[
    ['silver',/(sølv|silver|holograf|perlemor|blank)/],['blue',/(blå|blue)/],['green',/(grønn|green|oliven)/],
    ['pink',/(rosa|pink)/],['red',/(rød|red)/],['orange',/(oransj|orange)/],['yellow',/(gul|yellow|chartreuse|lime)/],
    ['gold',/(gull|gold)/],['copper',/(kobber|copper|bronse|brass)/],['dark',/(sort|svart|mørk|black|brown|brun|lilla)/],
    ['natural',/(natur|ørret|tobis|sild|mort|abbor|småfisk)/],['contrast',/(kontrast|prikk|stripe|rød|rosa|oransj|sort|svart)/],
    ['holographic',/(holograf|glitter|flash|perlemor)/],['bright',/(blank|hvit|white|sølv|gul|lime|chartreuse)/]
  ];
  for(const [tag,rx] of rules) if(rx.test(value)) tags.add(tag);
  return [...tags];
}
function effectiveLureTags(item={}) {
  return new Set([...(item.tags||[]),...colorTagsFromText(`${item.color||''} ${item.name||''}`)]);
}
function selectPhotographedLures({ fishType='sjoorret', goal='numbers', hour, cloud, wind, temp, exposure, coastQuality, depthMeters, conservativeShallow, exposed, sheltered, lowLight: lowLightOverride, lat, lon, structureLabel='', idealProfile=null }) {
  const lowLight = typeof lowLightOverride==='boolean' ? lowLightOverride : (hour <= 8 || hour >= 19);
  const bright = !lowLight && cloud < 35;
  const overcastOrCold = !lowLight && (cloud >= 70 || temp < 8);
  const requiredWaterType=isFreshwaterFish(fishType)?'freshwater':'saltwater';
  const eligible=lureCatalog.filter(item=>lureIsVerifiedForSpecies(item,fishType)&&item.waterTypes.includes(requiredWaterType));
  if(!eligible.length) throw new Error(`Ingen fotograferte sluker er klassifisert for ${fishType} i ${requiredWaterType}`);
  const structure=String(structureLabel||'').toLocaleLowerCase('no-NO');
  const idealTags=new Set(idealProfile?.preferredTags||[]),idealColors=new Set(idealProfile?.colorTags||[]);
  const siteKey = Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(4)}:${lon.toFixed(4)}` : `${Math.round(exposure*20)}:${Math.round(coastQuality*20)}:${depthMeters===null?'x':Math.round(depthMeters)}`;

  const scored = eligible.map(item => {
    const tags=effectiveLureTags(item),has=tag=>tags.has(tag);let score=20;const reasons=[];
    // Match the independent BiteGuide profile first. This is the core link between evidence and the user's own box.
    let idealHits=0;for(const tag of idealTags) if(has(tag)) idealHits++;
    let colorHits=0;for(const tag of idealColors) if(has(tag)) colorHits++;
    if(idealHits){score+=idealHits*5;reasons.push(`${idealHits} treff på anbefalt agntype/profil`);}
    if(colorHits){score+=colorHits*4;reasons.push(`${colorHits} fargetreff for forholdene`);}

    if (lowLight) score += (has('warm')||has('copper')||has('gold') ? 7 : 0) + (has('contrast')||has('dark') ? 5 : 0) + (has('pink') ? 3 : 0);
    else if (overcastOrCold) score += (has('warm')||has('copper')||has('gold') ? 5 : 0) + (has('natural') ? 4 : 0) + (has('contrast') ? 3 : 0);
    else if (bright) score += (has('silver') ? 7 : 0) + (has('blue')||has('green') ? 5 : 0) + (has('natural') ? 4 : 0);
    else score += (has('silver') ? 3 : 0) + (has('blue')||has('green') ? 2 : 0) + (has('pink') ? 2 : 0) + (has('natural') ? 3 : 0);

    if (conservativeShallow) {score += (has('shallow') ? 8 : 0) + (has('slim') ? 4 : 0) + (has('minnow') ? 5 : 0) + (has('spoon') ? 3 : 0) - (has('deep') ? 6 : 0);reasons.push('grunt/kystnært');}
    else if (exposed) {score += (has('casting') ? 8 : 0) + (has('compact') ? 5 : 0) + (has('sea-metal') ? 5 : 0) - (has('low-wind') ? 8 : 0);reasons.push('vind/rekkevidde');}
    else if (sheltered) {score += (has('shallow') ? 5 : 0) + (has('spoon') ? 3 : 0) + (has('minnow') ? 5 : 0) + (has('natural') ? 3 : 0) + (has('low-wind') ? 4 : 0);reasons.push('rolig/lunt vann');}

    if (depthMeters !== null && depthMeters > 12) {score += (has('deep') ? 8 : 0) + (has('sea-metal') ? 4 : 0) + (has('sinking') ? 4 : 0);reasons.push('dypere vann');}
    if (depthMeters !== null && depthMeters <= 4) {score += (has('shallow') ? 7 : 0) + (has('wobbler') ? 3 : 0) - (has('deep') ? 5 : 0);reasons.push('grunn sone');}
    if (/kant|marbakke|renne|grop|dyp/.test(structure)) {score+=(has('deep')?5:0)+(has('sinking')?5:0)+(has('shad')?4:0)+(has('casting')?2:0);reasons.push('dybdekant/renne');}
    if (/grunne|rygg|odde|platå/.test(structure)) {score+=(has('shallow')?5:0)+(has('minnow')?4:0)+(has('spinner')?3:0)+(has('spoon')?2:0);reasons.push('grunne/rygg');}
    if (/vegetasjon|siv/.test(structure)) {score+=(has('spinnerbait')?7:0)+(has('shad')?4:0)+(has('shallow')?4:0);reasons.push('vegetasjon');}
    if (coastQuality >= .75) score += (has('structure') ? 3 : 0) + (has('shallow') ? 2 : 0);
    if (isFreshwaterFish(fishType)&&has('freshwater-specialist')) score += 7;
    if (!isFreshwaterFish(fishType)&&has('saltwater-specialist')) score += 7;

    if (fishType === 'sjoorret') score += (has('spoon') ? 7 : 0) + (has('sea-metal') ? 5 : 0) + (has('minnow') ? 6 : 0) + (has('wobbler') ? 4 : 0) + (sheltered&&has('bombarda')?4:0);
    if (fishType === 'makrell') score += (has('sea-metal') ? 10 : 0) + (has('silver') ? 7 : 0) + (has('casting') ? 6 : 0) + (has('blue') ? 3 : 0);
    if (fishType === 'sei') score += (has('sea-metal') ? 8 : 0) + (has('shad') ? 9 : 0) + (has('silver') ? 5 : 0) + (has('deep') ? 6 : 0);
    if (fishType === 'orret') score += (has('spinner') ? 8 : 0) + (has('spoon') ? 7 : 0) + (has('wobbler') ? 6 : 0) + (has('natural') ? 5 : 0) + (has('micro') ? 3 : 0);
    if (fishType === 'abbor') score += (has('shad') ? 9 : 0) + (has('spinner') ? 8 : 0) + (has('crankbait') ? 8 : 0) + (has('compact') ? 6 : 0) + (has('contrast') ? 4 : 0);
    if (fishType === 'gjedde') score += (has('spinnerbait') ? 12 : 0) + (has('shad') ? 11 : 0) + (has('wobbler') ? 8 : 0) + (has('broad') ? 7 : 0) + (has('contrast') ? 5 : 0) + (goal==='big'&&has('large')?5:0);

    // Site hash is only a sub-point tie breaker (<0.4 point), never a reason to override condition fit.
    const tie = (stableLureNumber(`${fishType}|${siteKey}|${item.id}`) % 400) / 1000;
    return { item, score, tie, reasons:[...new Set(reasons)].slice(0,4) };
  }).sort((a,b) => b.score-a.score || b.tie-a.tie || a.item.id.localeCompare(b.item.id));

  const bestScore=scored[0].score;
  const suitabilityWindow = 10;
  const maxChoices = Math.min(10,eligible.length);
  const ranked=scored.filter(row=>row.score>=bestScore-suitabilityWindow).sort((a,b)=>b.score-a.score||b.tie-a.tie);
  const primary=ranked[0],picked=[primary],usedIds=new Set([primary.item.id]),usedGroups=new Set([primary.item.groupId||primary.item.id]);
  for(const row of ranked){const group=row.item.groupId||row.item.id;if(usedGroups.has(group))continue;picked.push(row);usedIds.add(row.item.id);usedGroups.add(group);if(picked.length>=maxChoices)break;}
  if(picked.length<maxChoices) for(const row of ranked){if(usedIds.has(row.item.id))continue;picked.push(row);usedIds.add(row.item.id);if(picked.length>=maxChoices)break;}
  const top=primary?.score ?? bestScore;
  return picked.map((row,index)=>({
    ...row.item,
    matchScore:clamp(Math.round(100-Math.max(0,top-row.score)*2-index),65,100),
    conditionScore:Number(row.score.toFixed(2)),
    matchReasons:row.reasons
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

function deriveIdealLureProfile({fishType,goal='numbers',hour,cloud,wind,temp,precipitation,exposed,sheltered,depthMeters,lowLight,structureLabel='',referenceChoice=null}) {
  const structure=String(structureLabel||'').toLocaleLowerCase('no-NO');
  const shallow=Number.isFinite(depthMeters)&&depthMeters<=4,deep=Number.isFinite(depthMeters)&&depthMeters>=10;
  const edge=/kant|marbakke|renne|grop|dyp/.test(structure),ridge=/grunne|rygg|odde|platå/.test(structure),vegetation=/vegetasjon|siv/.test(structure);
  const dark=Boolean(lowLight)||cloud>=70,bright=!lowLight&&cloud<35;
  let type='Slank skjesluk / inlinesluk',size='15–22 g',color=dark?'Kobber/gull eller sølv med mørk/varm kontrast':'Sølv/blå, sølv/grønn eller naturtro småfisk',targetDepth='0,5–2 m',presentation='Jevn innsveiving med korte fartsendringer og spinnstopp.',preferredTags=['spoon','inline','casting','slim'],colorTags=dark?['copper','gold','warm','contrast','dark']:['silver','blue','green','natural'];
  if(fishType==='sjoorret') {
    if(shallow||ridge){type='Gruntgående kystsluk eller minnowwobbler';size='10–18 g · wobbler ca. 8–12 cm';targetDepth='0,2–1,2 m';preferredTags=['shallow','minnow','wobbler','spoon','slim'];}
    else if(exposed||wind>=7){type='Langtkastende slank kystsluk / inlinesluk';size='18–28 g';targetDepth='0,8–3 m';preferredTags=['casting','sea-metal','spoon','inline','slim'];}
    else if(edge||deep){type='Synkende inlinesluk eller slank kystsluk';size='15–25 g';targetDepth='1–4 m, søk langs kanten';preferredTags=['sinking','deep','spoon','inline','sea-metal'];}
    else if(sheltered){type='Minnowwobbler eller lett skjesluk';size='9–12 cm / 12–18 g';targetDepth='0,5–2 m';preferredTags=['minnow','wobbler','shallow','spoon','natural'];}
  } else if(fishType==='orret') {
    type=(edge||deep)?'Liten synkende wobbler, skjesluk eller jigg':'Liten spinner eller skjesluk';size=(edge||deep)?'7–12 g · wobbler 5–8 cm':'4–10 g · wobbler 4–7 cm';targetDepth=(edge||deep)?'1–3 m / langs dybdekant':'0,3–1,5 m langs land, odde eller innløp';preferredTags=(edge||deep)?['sinking','wobbler','spoon','shad','structure']:['spinner','spoon','shallow','natural'];
    color=dark?'Kobber/gull, mørk rygg eller tydelig varm detalj':'Sølv/grønn, sølv/blå eller naturtro ørret/småfisk';colorTags=dark?['copper','gold','warm','dark','contrast']:['silver','green','blue','natural'];
  } else if(fishType==='abbor') {
    if(vegetation||shallow){type='Liten spinner, crankbait eller shad';size='5–10 cm / ca. 5–12 g';targetDepth='Rett over vegetasjon eller 0,5–1,5 m';preferredTags=['spinner','crankbait','shad','shallow','compact'];}
    else {type='Shad/jigg eller synkende minnow';size=goal==='big'?'10–13 cm':'6–10 cm';targetDepth='0,5–1,5 m over bunn eller langs kant';preferredTags=['shad','sinking','deep','compact','wobbler'];}
    color=dark?'Kobber/oransje, chartreuse eller mørk kontrast':'Naturtro grønn/perlemor, sølv eller abborfarge';colorTags=dark?['copper','orange','yellow','contrast','dark']:['green','natural','silver','holographic'];
  } else if(fishType==='gjedde') {
    if(goal==='big'||deep||edge){type='Stor shad eller stor wobbler/jerkbait';size='15–25 cm · typisk 50–150 g';targetDepth='Over vegetasjon eller langs overgangen til dypere vann';preferredTags=['shad','wobbler','broad','deep','large'];}
    else {type=vegetation?'Spinnerbait eller shad':'Shad, gjeddesluk eller wobbler';size='12–20 cm · ca. 20–60 g';targetDepth='0,5–2 m over vegetasjon / langs kant';preferredTags=['spinnerbait','shad','wobbler','broad','shallow'];}
    color=dark||Number(precipitation)>=2?'Mørk rygg med chartreuse/oransje eller kobberkontrast':'Mort-/abborfarget, grønn/sølv eller hvit/sølv';colorTags=dark?['dark','yellow','orange','copper','contrast']:['natural','green','silver','bright'];
  } else if(fishType==='makrell') {
    type=(exposed||deep)?'Kompakt casting-jig / metallsluk':'Slank metallsluk';size=(exposed||deep)?'25–45 g':'18–30 g';targetDepth=deep?'Søk fra midtvann og nedover':'Start høyt og tell gradvis ned';preferredTags=['sea-metal','casting','silver','slim','deep'];color=dark?'Sølv/rosa eller sølv med mørk kontrast':'Blank/holografisk sølv/blå';colorTags=dark?['silver','pink','contrast','dark']:['silver','blue','holographic','bright'];
  } else if(fishType==='sei') {
    type=deep?'Shad/jigg eller kompakt metallagn':'Kompakt metallagn / shad';size=deep?'30–60 g eller shad 10–15 cm':'20–40 g';targetDepth=deep?'Midtre til nedre vannlag, over bunn':'Søk trinnvis gjennom vannsøylen';preferredTags=['shad','sea-metal','sinking','deep','casting'];color=dark?'Sølv med mørk/lilla eller varm kontrast':'Blå/sølv, tobis/oliven eller holografisk sølv';colorTags=dark?['silver','dark','contrast']:['silver','blue','green','natural','holographic'];
  }
  const conditionBits=[lowLight?'lavt lys':bright?'klart lys':'dempet lys',`${Number(wind||0).toFixed(1)} m/s vind`];
  if(Number.isFinite(depthMeters))conditionBits.push(`${depthMeters.toFixed(1).replace('.',',')} m ved punktet`);if(structureLabel)conditionBits.push(structureLabel);
  const sources=[];const guidance=SOURCE_BACKED_LURE_DATA.guidanceSources?.[fishType];if(guidance)sources.push({label:guidance.label,url:guidance.url,kind:guidance.kind});if(referenceChoice?.sourceLabel)sources.push({label:referenceChoice.sourceLabel,url:referenceChoice.sourceUrl,kind:'Produsentdata / dokumentert modellreferanse'});
  const referenceNote=referenceChoice?` Modellreferanse brukt som kontroll: ${referenceChoice.family||referenceChoice.name}.`:'';
  return {type,size,color,targetDepth,presentation,preferredTags,colorTags,whyNow:`Valgt ut fra ${conditionBits.join(', ')}.${referenceNote}`,basis:'Art + lys/vær + dybde/struktur + kildekontrollert sportsfiske- og produsentveiledning. Egne sluk velges først etter at denne profilen er beregnet.',sources,referenceModel:referenceChoice?{name:referenceChoice.name,family:referenceChoice.family,variant:referenceChoice.variant}:null};
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

  const referenceChoice=sourceBackedLureChoice({fishType,hour,cloud,wind,temp,tempTrend,precipitation,exposed,depthMeters,lowLight});
  const idealProfile=deriveIdealLureProfile({fishType,goal,hour,cloud,wind,temp,precipitation,exposed,sheltered,depthMeters,lowLight,structureLabel:input.structureLabel||'',referenceChoice});
  const choices = selectPhotographedLures({ fishType, goal, hour, cloud, wind, temp, exposure, coastQuality, depthMeters, conservativeShallow, exposed, sheltered, lowLight, lat:input.lat, lon:input.lon, structureLabel:input.structureLabel||'', idealProfile });
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
  const alternatives=choices.slice(1,7).map(choice=>({id:choice.id,name:choice.name,type:choice.family,color:choice.color,image:choice.image,inventoryNote:choice.inventoryNote,ownedPhoto:true,matchScore:choice.matchScore,conditionScore:choice.conditionScore,matchReasons:choice.matchReasons,weight}));
  const candidates=choices.slice(0,10).map(choice=>({id:choice.id,name:choice.name,type:choice.family,color:choice.color,image:choice.image,inventoryNote:choice.inventoryNote,ownedPhoto:true,matchScore:choice.matchScore,conditionScore:choice.conditionScore,matchReasons:choice.matchReasons,weight}));
  const genericCombinations=[];
  const researchedChoice=referenceChoice;
  const presentation=lurePresentationAdvice({fishType,depthMeters,lowLight,wind,exposed});
  const dropperFly=dropperFlyAdvice({fishType,lowLight,cloud,wind,exposed});
  const speciesReason = fishType === 'makrell' ? 'Makrell: søk i frie vannmasser og rundt strøm, odder eller stimer av småfisk' : fishType === 'sei' ? 'Sei: prioriter strøm, bratte kanter og vann med litt dybde' : fishType === 'orret' ? 'Ferskvannsørret: fisk langs vannkanter, odder, innløp og vindpåvirkede bredder' : fishType === 'abbor' ? 'Abbor: søk langs struktur, sivkanter, odder og lune bukter' : fishType === 'gjedde' ? 'Gjedde: prioriter grunne bukter, vegetasjon og kanter mot dypere vann' : null;
  const trophyNote=goal==='big'&&fishType==='gjedde'?' Stor-fisk-modus: fisk større agn sakte med tydelige pauser langs vegetasjon, odder og overgangen mot dypere vann.':'';
  return { id:primary.id, name:primary.name, type, weight, color:primary.color, image:primary.image, inventoryNote:primary.inventoryNote, ownedPhoto:true, matchScore:primary.matchScore, conditionScore:primary.conditionScore, matchReasons:primary.matchReasons, waterEnvironment, reason: `${speciesReason ? `${speciesReason}; ` : ''}${timeReason}; ${tackleReason}.${trophyNote}`, depth, wobbler:null, alternatives, candidates, idealProfile, genericCombinations, researchedChoice, presentation, dropperFly };
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
    const query=`[out:json][timeout:18];(way["natural"="water"](${south},${west},${north},${east});relation["natural"="water"](${south},${west},${north},${east});way["water"~"lake|reservoir|pond|river|stream|basin"](${south},${west},${north},${east});relation["water"~"lake|reservoir|pond|river|stream|basin"](${south},${west},${north},${east});way["waterway"="riverbank"](${south},${west},${north},${east});relation["waterway"="riverbank"](${south},${west},${north},${east}););out geom;`;
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
  let habitatError=null;
  const habitatContextPromise=freshwater?Promise.resolve(null):fetchMarineHabitatContext({west,south,east,north}).catch(error=>{habitatError=error.message||String(error);return {available:false,coveragePercent:0,layers:{},source:'Marine habitatdata utilgjengelig'};});
  const width=east-west,height=north-south,zones=[]; let tested=0,rejected=0,maskError=null,depthError=null,freshwaterMaskError=null,restrictedWaters=0;
  let freshwaterAreas=[];
  let freshwaterLookup='OSM geometri';
  if(freshwater) {
    // NVE's lake polygons are the stable first choice for Norwegian lakes. OSM remains the
    // fallback for rivers, very small waters and places not represented in NVE's lake database.
    try{
      freshwaterAreas=await fetchNveFreshwaterAreas({west,south,east,north});
      if(freshwaterAreas.length)freshwaterLookup='NVE Innsjødatabase';
    }catch(error){freshwaterMaskError=error.message||String(error);}
    if(!freshwaterAreas.length){
      try {
        freshwaterAreas=await fetchFreshwaterAreas({west,south,east,north});freshwaterLookup='OSM geometri';
        if(!freshwaterAreas.length){
          const fallback=await fetchNominatimWater({west,south,east,north});
          freshwaterAreas=fallback?[fallback]:[];
          if(fallback) freshwaterLookup='OSM punktkontroll + kartvann';
        }
        if(freshwaterAreas.length)freshwaterMaskError=null;
      } catch(error) {
        try {
          const fallback=await fetchNominatimWater({west,south,east,north});
          freshwaterAreas=fallback?[fallback]:[];
          if(fallback){freshwaterLookup='OSM punktkontroll + kartvann';freshwaterMaskError=null;}
        } catch(fallbackError) { freshwaterMaskError=fallbackError.message||error.message||freshwaterMaskError||String(fallbackError); }
      }
    }
  }
  let freshwaterBathy=null,freshwaterDepthError=null;
  if(freshwater){
    try{freshwaterBathy=await nveFreshwaterBathymetryGrid({west,south,east,north,zoom,quality:'mobile'});}catch(error){freshwaterDepthError=error.message||String(error);}
  }
  const candidates=freshwater?freshwaterCandidateGrid(freshwaterAreas,{west,south,east,north}):candidateGrid(west,south,east,north,fishType);
  const preselectLimit=Math.min(36,Math.max(zoneLimit*2,20));
  for (const point of freshwaterMaskError ? [] : candidates) {
    if (zones.length>=preselectLimit) break; tested++;
    try {
      if(base&&radiusM&&distanceMeters(base.lat,base.lon,point.lat,point.lon)>radiusM){rejected++;continue;}
      if(!freshwater&&isNearOfficialNoFishingZone(point.lat,point.lon)){restrictedWaters++;rejected++;continue;}
      const freshwaterArea=freshwater?freshwaterAtPoint(point.lat,point.lon,freshwaterAreas):null;
      if(freshwater&&!freshwaterArea){rejected++;continue;}
      if(freshwaterArea?.restricted){restrictedWaters++;rejected++;continue;}
      const fallbackFreshwater=Boolean(freshwaterArea?.lookup==='nominatim');
      // A Nominatim fallback is only a coarse bounding box. Never trust the box as
      // water geometry: verify the actual map pixel and derive the shoreline from
      // the rendered OSM water mask so recommendations cannot spill onto land.
      const coast=freshwater
        ? (fallbackFreshwater ? await nearCoastInfo(point.lat,point.lon,width,height,zoom) : freshwaterCoastInfo(point.lat,point.lon,freshwaterArea))
        : await nearCoastInfo(point.lat,point.lon,width,height,zoom);
      if(!coast){rejected++;continue;}
      const polygon=freshwater?[]:makeRibbon(point.lat,point.lon,coast.tangent,width*0.045,width*0.0055);
      const waterConfirmed=freshwater ? (fallbackFreshwater ? await isWater(point.lat,point.lon,zoom) : true) : await polygonMostlyWater(polygon,zoom);
      if(!waterConfirmed){rejected++;continue;}
      const exposure=windExposure(currentWeather?.windDirection,coast.coastNormal); const hour=norwegianHour(); const scoring=computeScore({...environment,coastQuality:coast.quality,exposure,hour,fishType});
      zones.push({id:`zone-${zones.length+1}-${Math.round(point.lat*10000)}-${Math.round(point.lon*10000)}`,score:scoring.score,name:scoring.score>=82?'Svært høy':scoring.score>=68?'Høy':'Moderat',breakdown:scoring.breakdown,polygon,marker:{lat:point.lat,lon:point.lon},distanceM:base?Math.round(distanceMeters(base.lat,base.lon,point.lat,point.lon)):null,castBearing:Math.round(((coast.tangent*180/Math.PI)+360)%360),goal,_point:point,_coast:coast,_exposure:exposure,_hour:hour,_freshwaterName:freshwaterArea?.name||null});
    } catch(error) { maskError=error.message; rejected++; if(!freshwater&&tested>12&&!zones.length) break; }
  }
  // Preselect on cheap geometry/weather score before doing depth and habitat lookups.
  zones.sort((a,b)=>b.score-a.score);
  if(zones.length>zoneLimit) zones.splice(zoneLimit);
  const habitatContext=await habitatContextPromise;
  await Promise.all(zones.map(async zone => {
    let depth=null,offshoreDepth=null,structure=null;
    if (freshwater) {
      const freshInfo=freshwaterBathy?freshwaterStructureFromGrid(freshwaterBathy,zone._point.lat,zone._point.lon):null;
      if(Number.isFinite(freshInfo?.depth))depth={meters:freshInfo.depth,category:freshInfo.depth<=2?'shallow':freshInfo.depth<=8?'mid':'deep',source:'NVE Dybdekart',resolutionM:freshwaterBathy.samplingApproxM||null,estimated:true,survey:freshwaterBathy.survey||null};
      structure=freshInfo?.structure||{available:false,label:'Ingen oppmålt NVE-dybde ved punktet',score:null,slopeMPer100:null,depthDelta:null,offshoreDepth:null,offshoreDistanceM:null};
    } else {
      try { depth=await depthAtPoint(zone._point.lat,zone._point.lon); } catch(error) { depthError=error.message; }
      if(Number.isFinite(depth?.meters)&&Number.isFinite(zone._coast?.coastNormal)){
        try{
          const offshorePoint=destinationPoint(zone._point.lat,zone._point.lon,(zone._coast.coastNormal+180)%360,280);
          offshoreDepth=await depthAtPoint(offshorePoint.lat,offshorePoint.lon);
        }catch(error){ depthError=depthError||error.message; }
      }
      structure=classifyQuickStructure(depth?.meters,offshoreDepth?.meters,280);
    }
    const shallowRisk=freshwater ? (Number.isFinite(depth?.meters)?depth.meters<=2.2:false) : depth ? depth.meters<=5 || zone._coast.quality>=0.95 : zone._coast.quality>=0.75;
    zone.depth=depth || { meters:null, category:'unknown', source:freshwater?'NVE Dybdekart':null, resolutionM:null, estimated:false };
    const habitat=freshwater?{serviceAvailable:false,serviceCoveragePercent:0,signals:[],noneRegistered:false,source:'Marine habitatdata brukes ikke i ferskvann'}:marineHabitatAtPoint(zone._point.lat,zone._point.lon,habitatContext);
    const liveAnalysis=computeLiveScore({...environment,coastQuality:zone._coast.quality,exposure:zone._exposure,hour:zone._hour,depthMeters:depth?.meters,fishType});
    const habitatAnalysis=computeHabitatScore({fishType,coastQuality:zone._coast.quality,depth,structure,habitat,goal});
    const totalScore=clamp(Math.round(habitatAnalysis.score*.57+liveAnalysis.score*.43),0,100);
    const confidence=buildAnalysisConfidence({weather:currentWeather,marine:marineConditions,depth,structure,habitat,waterType});
    const legal=legalStatusForPoint(zone._point.lat,zone._point.lon);
    zone.score=totalScore;
    zone.analysis={habitat:habitatAnalysis.score,now:liveAnalysis.score,total:totalScore,confidence:confidence.confidence,summary:analysisSummary({habitatScore:habitatAnalysis,liveScore:liveAnalysis,structure,habitat}),habitatFactors:habitatAnalysis.factors,liveFactors:liveAnalysis.factors,confidenceComponents:confidence.components};
    zone.structure={...structure,coastNormal:Number.isFinite(zone._coast?.coastNormal)?Number(zone._coast.coastNormal.toFixed(1)):null,profileAvailable:!freshwater&&Number.isFinite(zone._coast?.coastNormal)};
    zone.habitat=habitat;
    zone.legal=legal;
    zone.dataQuality={...buildDataQuality({weather:currentWeather,depth,waterType}),level:confidence.level,confidence:confidence.confidence,components:confidence.components,summary:`${confidence.confidence}% datadekning · ${confidence.level.toLowerCase()}`};
    zone.breakdown={habitat:Math.round((habitatAnalysis.score-50)/5),forhold:Math.round((liveAnalysis.score-50)/5)};
    zone.name=zone.score>=82?'Svært høy':zone.score>=68?'Høy':'Moderat';
    zone.lure=recommendLure({...currentWeather,coastQuality:zone._coast.quality,exposure:zone._exposure,hour:zone._hour,lat:zone._point.lat,lon:zone._point.lon,depthMeters:depth?.meters,shallowRisk,fishType,goal,structureLabel:zone.structure?.label||''});
    zone.biteGuide=buildZoneBiteGuide({zone,currentWeather,fishType});
    if(freshwater&&zone._freshwaterName){
      const knowledge=sourceKnowledgeAdjustment(zone._freshwaterName,fishType,goal);
      if(knowledge.profile){
        zone.sourceKnowledge={name:knowledge.profile.name,species:knowledge.profile.species||null,confidence:knowledge.profile.sourceConfidence||'limited',populationNote:knowledge.profile.populationNote||null,hiddenGem:Boolean(knowledge.profile.hiddenGem),access:knowledge.profile.access||null,accessScore:knowledge.profile.accessScore||null};
        zone.breakdown={...zone.breakdown,kildekunnskap:knowledge.delta};
        zone.score=clamp(zone.score+knowledge.delta,0,100);
        zone.analysis.total=zone.score;
        zone.name=zone.score>=82?'Svært høy':zone.score>=68?'Høy':'Moderat';
        zone._speciesMismatch=knowledge.mismatch;
      }
      if(fishType==='orret'&&isVestfjellaFlyOnly(zone._freshwaterName||'')){
        zone.lure=flyOnlyLureAdvice({hour:zone._hour,cloud:currentWeather?.cloud,wind:currentWeather?.wind,lat:zone._point.lat,lon:zone._point.lon});
        zone.flyOnly=true;
        zone.biteGuide.recommended={...zone.biteGuide.recommended,type:'Fluefiske – våtflue/streamer',size:'Lett ferskvannsflue',method:zone.lure?.presentation?.method||'Fisk kontrollert med korte trekk og pauser.',whyNow:'Dette vannet er registrert som fluevann i Vestfjella-registeret.'};
      }
    }
    const waterName=zone._freshwaterName?` i ${zone._freshwaterName}`:'';
    const depthPhrase=Number.isFinite(depth?.meters)?` NVE-dybde ved punktet er ca. ${depth.meters.toFixed(1).replace('.',',')} m${structure?.available?` og området har ${structure.label.toLowerCase()}`:''}.`:'';
    const fishReason=fishType==='makrell'?'Makrell: kystnært, åpnere vann der stimer kan trekke forbi.':fishType==='sei'?(Number.isFinite(depth?.meters)&&depth.meters>=8?'Sei: dybde og kyststruktur gjør sonen aktuell.':Number.isFinite(depth?.meters)?'Sei: grunt kystområde; søk mot renner og dypere vann.':'Sei: dybden er ikke bekreftet; se etter renner og bratte kanter i sjøkartet.'):fishType==='orret'?`Ferskvannsørret${waterName}: modellen prioriterer vannkant, lys/vind og – når NVE-data finnes – ørretens passende dybde og dybdekanter.${depthPhrase}`:fishType==='abbor'?`Abbor${waterName}: modellen prioriterer vannkant og – når NVE-data finnes – ca. 1–8 m og tydelig struktur.${depthPhrase}`:fishType==='gjedde'?`Gjedde${waterName}: modellen prioriterer grunne kanter og – når NVE-data finnes – ca. 0–5 m nær struktur.${depthPhrase}`:'Sjøørret: kombinerer kyststruktur, dybde og forhold akkurat nå.';
    const knowledgeReason=zone.sourceKnowledge?.populationNote?` Kildekunnskap: ${zone.sourceKnowledge.populationNote}`:'';
    zone.reason=`${fishReason} ${zone.analysis.summary}.${knowledgeReason}`;
    if(goal==='big') zone.reason=`Stor-fisk-modus prioriterer tydelig struktur og kantsoner. ${zone.reason}`;
    if(zone._freshwaterName) zone.waterName=zone._freshwaterName;
    delete zone._point; delete zone._coast; delete zone._exposure; delete zone._hour; delete zone._freshwaterName;
  }));
  for(let i=zones.length-1;i>=0;i--){if(zones[i]._speciesMismatch)zones.splice(i,1);else delete zones[i]._speciesMismatch;}
  zones.sort((a,b)=>b.score-a.score||b.analysis.confidence-a.analysis.confidence);
  const nveDepthServiceFailure=freshwaterDepthError&&!/har ikke registrert oppmålt dybdekart|Fant ikke et NVE-vann|for lite NVE-dybdedata|for lite målegeometri/i.test(freshwaterDepthError);
  const warning=[maskError?'Vannmasken svarte ikke; prøv igjen om litt.':null,freshwaterMaskError&&!freshwaterAreas.length?'Vanngeometrien kunne ikke bekreftes akkurat nå.':null,freshwater&&nveDepthServiceFailure?'NVE-dybdetjenesten svarte ikke; analysen fortsetter uten dybde.':null,restrictedWaters?`${restrictedWaters} kandidat(er) i kjent helårsforbud ble hardfiltrert bort.`:null,depthError?'Dybde/struktur er midlertidig ufullstendig for noen soner.':null,habitatError?'Marine habitatdata svarte ikke; analysen fortsetter uten dette laget.':null].filter(Boolean).join(' ')||null;
  const source=freshwater?`${freshwaterLookup} + MET Norway${freshwaterBathy?' + NVE Dybdekart (automatisk)':''}`:`OSM vannmaske + EMODnet dybde/struktur + MET Norway${marineConditions?' + Open-Meteo Marine':''}${habitatContext?.available?' + Miljødirektoratet/Fiskeridirektoratet habitat':''}`;
  return {zones,stats:{tested,rejected,goal,base,radiusM,strictLandmask:true,waterType,waterMaskAvailable:!maskError&&!freshwaterMaskError,freshwaterAreas:freshwater?freshwaterAreas.length:null,freshwaterLookup:freshwater?freshwaterLookup:null,freshwaterDepthSource:freshwaterBathy?'NVE Dybdekart':null,freshwaterLake:freshwaterBathy?.lakeName||null,freshwaterDepthNote:freshwaterDepthError||null,restrictedWaters,hardRestrictionFilter:true,habitatCoveragePercent:freshwater?null:(habitatContext?.coveragePercent||0),depthAvailable:zones.filter(z=>Number.isFinite(z.depth?.meters)).length,depthResolutionM:freshwater?(freshwaterBathy?.samplingApproxM||null):125,warning,generatedAt:new Date().toISOString(),source}};
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

async function bathymetryRaster({west,south,east,north,zoom=13}) {
  const spanLon=east-west,spanLat=north-south;
  if(spanLon<=0||spanLat<=0||spanLon>0.18||spanLat>0.18) throw new Error('Zoom nærmere for 3D-bunn (maks ca. 15–20 km utsnitt).');
  const samples=Math.max(36,Math.min(64,Math.round(42+(zoom-10)*3)));
  const resx=spanLon/samples,resy=spanLat/samples;
  const key=`bathy-tif:${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)},${samples}`;
  return cached(key,6*60*60*1000,async()=>{
    const params=new URLSearchParams({service:'wcs',version:'1.0.0',request:'getcoverage',coverage:'emodnet:mean',crs:'EPSG:4326',BBOX:`${west},${south},${east},${north}`,format:'image/tiff',interpolation:'bilinear',resx:String(resx),resy:String(resy)});
    const buffer=await fetchBuffer(`https://ows.emodnet-bathymetry.eu/wcs?${params}`,{'User-Agent':MET_USER_AGENT},14000);
    if(!buffer?.length||buffer.length<512) throw new Error('EMODnet returnerte ikke et gyldig dybderaster.');
    return {buffer,samples,source:'EMODnet Bathymetry DTM',sourceResolutionM:115,samplingApproxM:Math.round(Math.max(resx*111320*Math.cos(((south+north)/2)*Math.PI/180),resy*110540))};
  });
}


// REV36: Primary 3D seabed source with a reduced mobile grid for faster phone rendering. Kartverket's open height/depth API returns signed
// terrain/depth samples and avoids the fragile browser-side GeoTIFF/WCS pipeline used in REV34.
function lonLatToUtm33(lon,lat) {
  const a=6378137,f=1/298.257222101,k0=.9996,e2=f*(2-f),ep2=e2/(1-e2);
  const phi=lat*Math.PI/180,lambda=lon*Math.PI/180,lambda0=15*Math.PI/180;
  const sin=Math.sin(phi),cos=Math.cos(phi),tan=Math.tan(phi),N=a/Math.sqrt(1-e2*sin*sin);
  const T=tan*tan,C=ep2*cos*cos,A=cos*(lambda-lambda0);
  const M=a*((1-e2/4-3*e2**2/64-5*e2**3/256)*phi-(3*e2/8+3*e2**2/32+45*e2**3/1024)*Math.sin(2*phi)+(15*e2**2/256+45*e2**3/1024)*Math.sin(4*phi)-(35*e2**3/3072)*Math.sin(6*phi));
  const easting=500000+k0*N*(A+(1-T+C)*A**3/6+(5-18*T+T*T+72*C-58*ep2)*A**5/120);
  const northing=k0*(M+N*tan*(A*A/2+(5-T+9*C+4*C*C)*A**4/24+(61-58*T+T*T+600*C-330*ep2)*A**6/720));
  return [easting,northing];
}
function bathymetryGridPlan({west,south,east,north,zoom=13,quality='standard'}) {
  const spanLon=east-west,spanLat=north-south;
  if(spanLon<=0||spanLat<=0||spanLon>0.18||spanLat>0.18) throw new Error('Zoom nærmere for 3D-bunn (maks ca. 15–20 km utsnitt).');
  const midLat=(south+north)/2,widthM=Math.max(1,spanLon*111320*Math.cos(midLat*Math.PI/180)),heightM=Math.max(1,spanLat*110540);
  const mobile=quality==='mobile',longest=Math.max(widthM,heightM),zoomBoost=clamp((Number(zoom)||13)-11,0,5);
  // REV39: denser mobile grid for smoother FjordSpot-like 3D without making phones wait forever.
  const minLongest=mobile?36:40,maxLongest=mobile?48:54;
  let longestCells=Math.round(clamp(minLongest+zoomBoost*(mobile?1.7:2.2),minLongest,maxLongest));
  let width=Math.max(mobile?20:24,Math.round(longestCells*widthM/longest));
  let height=Math.max(mobile?20:24,Math.round(longestCells*heightM/longest));
  const maxPoints=mobile?1500:2400;
  if(width*height>maxPoints){const scale=Math.sqrt(maxPoints/(width*height));width=Math.max(16,Math.floor(width*scale));height=Math.max(16,Math.floor(height*scale));}
  const spacingM=Math.round(Math.max(widthM/Math.max(1,width-1),heightM/Math.max(1,height-1)));
  return {width,height,widthM,heightM,spacingM,totalPoints:width*height,quality:mobile?'mobile':'standard'};
}
function classifyKartverketHeight(point) {
  const rawValue=point?.z;
  if(rawValue===null||rawValue===undefined||rawValue==='') return {elevation:null,depth:null,isSea:false,isLand:false};
  const raw=Number(rawValue);
  if(!Number.isFinite(raw)||Math.abs(raw)>12000) return {elevation:null,depth:null,isSea:false,isLand:false};
  const terrain=String(point?.terreng||point?.terrengtype||'').toLowerCase();
  const seaHint=/hav|sjø|sjo|saltvann|sea/.test(terrain);
  if(raw<-.02||seaHint&&raw<=.05) return {elevation:raw<0?raw:-Math.abs(raw),depth:Math.max(0,-raw),isSea:true,isLand:false};
  return {elevation:Math.max(0,raw),depth:null,isSea:false,isLand:true};
}
async function kartverketPointBatch(points) {
  const projected=points.map(({lon,lat})=>{const [e,n]=lonLatToUtm33(lon,lat);return [Number(e.toFixed(2)),Number(n.toFixed(2))];});
  const params=new URLSearchParams({koordsys:'25833',punkter:JSON.stringify(projected),geojson:'false'});
  let lastError=null;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const json=await fetchJson(`https://ws.geonorge.no/hoydedata/v1/punkt?${params}`,{'User-Agent':MET_USER_AGENT,'Accept':'application/json'},12000+attempt*3000);
      const result=Array.isArray(json?.punkter)?json.punkter:[];
      if(result.length!==points.length) throw new Error(`Kartverket returnerte ${result.length} av ${points.length} punkter`);
      return result;
    }catch(error){lastError=error;if(attempt<2) await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));}
  }
  throw lastError||new Error('Kartverket høydedata svarte ikke');
}

function geoJsonPolygonRings(geometry) {
  if(!geometry) return [];
  if(geometry.type==='Polygon') return [geometry.coordinates||[]];
  if(geometry.type==='MultiPolygon') return geometry.coordinates||[];
  return [];
}
function geoJsonContainsPoint(geometry,lon,lat) {
  for(const polygon of geoJsonPolygonRings(geometry)) {
    const outer=(polygon[0]||[]).map(([x,y])=>({lon:Number(x),lat:Number(y)})).filter(p=>Number.isFinite(p.lon)&&Number.isFinite(p.lat));
    if(outer.length<3||!pointInPolygon(lat,lon,outer)) continue;
    let inHole=false;
    for(const holeCoords of polygon.slice(1)) {
      const hole=(holeCoords||[]).map(([x,y])=>({lon:Number(x),lat:Number(y)})).filter(p=>Number.isFinite(p.lon)&&Number.isFinite(p.lat));
      if(hole.length>=3&&pointInPolygon(lat,lon,hole)){inHole=true;break;}
    }
    if(!inHole) return true;
  }
  return false;
}
function geoJsonGeometryCenter(geometry) {
  const coords=[];
  for(const polygon of geoJsonPolygonRings(geometry)) for(const ring of polygon||[]) for(const pair of ring||[]) {
    const lon=Number(pair?.[0]),lat=Number(pair?.[1]);if(Number.isFinite(lon)&&Number.isFinite(lat)) coords.push([lon,lat]);
  }
  if(!coords.length) return null;
  const sum=coords.reduce((acc,[lon,lat])=>[acc[0]+lon,acc[1]+lat],[0,0]);
  return {lon:sum[0]/coords.length,lat:sum[1]/coords.length};
}
async function nveLakeQuery(layer,{west,south,east,north,where='1=1',outFields='*',returnGeometry=true,resultRecordCount=2000,resultOffset=0}={}) {
  const params=new URLSearchParams({
    where,
    geometry:`${west},${south},${east},${north}`,
    geometryType:'esriGeometryEnvelope',
    inSR:'4326',
    spatialRel:'esriSpatialRelIntersects',
    outFields,
    returnGeometry:returnGeometry?'true':'false',
    outSR:'4326',
    resultOffset:String(Math.max(0,resultOffset||0)),
    resultRecordCount:String(resultRecordCount),
    f:'geojson'
  });
  return fetchJson(`https://kart.nve.no/enterprise/rest/services/Innsjodatabase2/MapServer/${layer}/query?${params}`,{'User-Agent':MET_USER_AGENT,'Accept':'application/geo+json,application/json'},16000);
}
async function nveLakeQueryAll(layer,options={},maxFeatures=10000) {
  const pageSize=Math.min(2000,Math.max(100,Number(options.resultRecordCount)||2000));
  const features=[];let offset=0,pages=0;
  while(features.length<maxFeatures&&pages<Math.ceil(maxFeatures/pageSize)+1){
    const page=await nveLakeQuery(layer,{...options,resultRecordCount:pageSize,resultOffset:offset});
    const rows=Array.isArray(page?.features)?page.features:[];features.push(...rows.slice(0,Math.max(0,maxFeatures-features.length)));pages++;
    if(rows.length<pageSize)break;offset+=rows.length;
  }
  return {type:'FeatureCollection',features,pages,truncated:features.length>=maxFeatures};
}
function nveFeatureProperties(feature={}) { return feature.properties||feature.attributes||{}; }
function nveLakeId(props={}) { return Number(props.vatnlnr??props.vatnLnr??props.vatn_lnr??props.VATN_LNR); }
function nveLakeName(props={}) { return String(props.innsjonavn??props.navn??props.name??'Ukjent vann').trim()||'Ukjent vann'; }
function nveSurveyQuality(props={}) {
  const product=String(props.digitaltprodukt??props.digitaltProdukt??'').trim();
  const method=String(props.oppmaltmetode??props.oppmaalingsmetode??props.malemetode??'').trim();
  const year=Number(props.oppmaltaar??props.oppmaaltaar);
  let grade='B',label='Digitalisert dybdekart';
  if(/oppmålte punkter|oppmalte punkter/i.test(product)){grade='A';label='Vektor fra oppmålte punkter';}
  else if(/vektor/i.test(product)){grade='B';label='Vektorisert dybdekart';}
  else if(/skannet|papir/i.test(product)){grade='C';label='Skannet eldre dybdekart';}
  else if(!product&&method){grade='B';label=method;}
  else if(!product&&!method){grade='C';label='NVE-dybdekart – metode ikke oppgitt';}
  return {grade,label,product:product||null,method:method||null,year:Number.isFinite(year)?year:null,equidistanceM:Number.isFinite(Number(props.ekvidistanse_m))?Number(props.ekvidistanse_m):null};
}
function pickNveLake(features=[],centerLon,centerLat) {
  const containing=features.filter(f=>geoJsonContainsPoint(f.geometry,centerLon,centerLat));
  if(containing.length) return containing.sort((a,b)=>{
    const aa=Number(nveFeatureProperties(a).areal_km2||Infinity),bb=Number(nveFeatureProperties(b).areal_km2||Infinity);return aa-bb;
  })[0];
  let best=null,bestDistance=Infinity;
  for(const feature of features){const c=geoJsonGeometryCenter(feature.geometry);if(!c)continue;const d=distanceMeters(centerLat,centerLon,c.lat,c.lon);if(d<bestDistance){bestDistance=d;best=feature;}}
  return bestDistance<=2500?best:null;
}

async function resolveNveDepthContext({west,south,east,north,centerLon=(west+east)/2,centerLat=(south+north)/2}={}) {
  const all=await nveLakeQuery(5,{west,south,east,north,outFields:'vatnlnr,navn,areal_km2,dybdekart',resultRecordCount:500});
  const lake=pickNveLake(all?.features||[],centerLon,centerLat);
  if(!lake) return {lake:null,lakeId:null,lakeName:null,where:null,meta:{type:'FeatureCollection',features:[]},hasDepthMap:false};
  const props=nveFeatureProperties(lake),lakeId=nveLakeId(props),lakeName=nveLakeName(props);
  if(!Number.isFinite(lakeId)) return {lake,lakeId:null,lakeName,where:null,meta:{type:'FeatureCollection',features:[]},hasDepthMap:false};
  const where=`vatnlnr=${Math.trunc(lakeId)}`;
  const meta=await nveLakeQuery(4,{west,south,east,north,where,outFields:'vatnlnr,innsjonavn,middeldyp_m,maksdyp_m,oppmaltav,oppmaltaar,oppmaltmetode,malemetode,digitaltprodukt,ekvidistanse_m',returnGeometry:false,resultRecordCount:20});
  return {lake,lakeId,lakeName,where,meta,hasDepthMap:Boolean(meta?.features?.length)};
}
function nveFeaturesToFreshwaterAreas(features=[]) {
  const areas=[];
  for(const feature of features){
    const props=nveFeatureProperties(feature),polygons=geoJsonPolygonRings(feature.geometry),name=nveLakeName(props),id=nveLakeId(props);
    for(const polygon of polygons){
      const outer=(polygon?.[0]||[]).map(([lon,lat])=>({lat:Number(lat),lon:Number(lon)})).filter(pt=>Number.isFinite(pt.lat)&&Number.isFinite(pt.lon));
      if(outer.length<4)continue;if(!sameCoordinate(outer[0],outer[outer.length-1]))outer.push({...outer[0]});
      const holes=[];
      for(const ring of (polygon||[]).slice(1)){
        const hole=(ring||[]).map(([lon,lat])=>({lat:Number(lat),lon:Number(lon)})).filter(pt=>Number.isFinite(pt.lat)&&Number.isFinite(pt.lon));
        if(hole.length>=4){if(!sameCoordinate(hole[0],hole[hole.length-1]))hole.push({...hole[0]});holes.push(hole);}
      }
      areas.push({ring:outer,holes,name,restricted:false,tags:{source:'NVE Innsjødatabase2',dybdekart:props.dybdekart||null},id:`nve/${Number.isFinite(id)?id:'lake'}`,lookup:'nve'});
    }
  }
  return areas;
}
async function fetchNveFreshwaterAreas({west,south,east,north}) {
  const key=`freshwater-nve:${west.toFixed(3)},${south.toFixed(3)},${east.toFixed(3)},${north.toFixed(3)}`;
  return cached(key,6*60*60*1000,async()=>{
    const result=await nveLakeQuery(5,{west,south,east,north,outFields:'vatnlnr,navn,areal_km2,dybdekart',resultRecordCount:1000});
    return nveFeaturesToFreshwaterAreas(result?.features||[]);
  });
}
function densifyGeoJsonLines(features=[],maxSamples=1800) {
  const raw=[];
  for(const feature of features) {
    const depth=Number(nveFeatureProperties(feature).dybde_m);if(!Number.isFinite(depth)||depth<0)continue;
    const g=feature.geometry||{};const lines=g.type==='LineString'?[g.coordinates]:g.type==='MultiLineString'?g.coordinates:[];
    for(const line of lines||[]) for(const pair of line||[]) {const lon=Number(pair?.[0]),lat=Number(pair?.[1]);if(Number.isFinite(lon)&&Number.isFinite(lat))raw.push({lon,lat,depth});}
  }
  if(raw.length<=maxSamples)return raw;
  const step=raw.length/maxSamples,out=[];for(let i=0;i<maxSamples;i++)out.push(raw[Math.floor(i*step)]);return out;
}
function nvePointSamples(features=[],maxSamples=700) {
  const raw=[];
  for(const feature of features){const depth=Number(nveFeatureProperties(feature).dybde_m),c=feature.geometry?.coordinates;if(!Number.isFinite(depth)||depth<0||!Array.isArray(c))continue;const lon=Number(c[0]),lat=Number(c[1]);if(Number.isFinite(lon)&&Number.isFinite(lat))raw.push({lon,lat,depth});}
  if(raw.length<=maxSamples)return raw;
  const step=raw.length/maxSamples,out=[];for(let i=0;i<maxSamples;i++)out.push(raw[Math.floor(i*step)]);return out;
}
function nveShorelineSamples(geometry,maxSamples=650){
  const raw=[];
  for(const polygon of geoJsonPolygonRings(geometry)){
    const outer=polygon?.[0]||[];for(const pair of outer){const lon=Number(pair?.[0]),lat=Number(pair?.[1]);if(Number.isFinite(lon)&&Number.isFinite(lat))raw.push({lon,lat,depth:0});}
  }
  if(raw.length<=maxSamples)return raw;
  const step=raw.length/maxSamples,out=[];for(let i=0;i<maxSamples;i++)out.push(raw[Math.floor(i*step)]);return out;
}
function inverseDistanceDepth(samples,lon,lat,centerLat,maxDepth){
  const sx=111320*Math.cos(centerLat*Math.PI/180),sy=110540;const nearest=[];
  for(const s of samples){const dx=(s.lon-lon)*sx,dy=(s.lat-lat)*sy,d2=dx*dx+dy*dy;if(d2<1)return clamp(s.depth,0,maxDepth);if(nearest.length<8){nearest.push({d2,depth:s.depth});nearest.sort((a,b)=>a.d2-b.d2);}else if(d2<nearest[7].d2){nearest[7]={d2,depth:s.depth};nearest.sort((a,b)=>a.d2-b.d2);}}
  if(!nearest.length)return null;let sum=0,weight=0;for(const n of nearest){const w=1/Math.max(16,n.d2);sum+=n.depth*w;weight+=w;}return weight?clamp(sum/weight,0,maxDepth):null;
}
async function nveFreshwaterBathymetryGrid({west,south,east,north,zoom=13,quality='standard',focusLat=null,focusLon=null}) {
  const plan=bathymetryGridPlan({west,south,east,north,zoom,quality});
  const centerLon=Number.isFinite(focusLon)?focusLon:(west+east)/2,centerLat=Number.isFinite(focusLat)?focusLat:(south+north)/2;
  const key=`bathy-grid-nve:${plan.quality}:${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)},${plan.width}x${plan.height}`;
  return cached(key,12*60*60*1000,async()=>{
    // Resolve the lake from NVE's complete lake database first, then verify that the SAME lake
    // has a Dybdekart record. This prevents accidentally borrowing depths from a nearby lake.
    const context=await resolveNveDepthContext({west,south,east,north,centerLon,centerLat});
    if(!context.lake)throw new Error('Fant ikke et NVE-vann i kartutsnittet.');
    if(!context.hasDepthMap)throw new Error(`NVE har ikke registrert oppmålt dybdekart for ${context.lakeName}.`);
    const lake=context.lake,props=nveFeatureProperties(lake),lakeId=context.lakeId,where=context.where,meta=context.meta;
    const [curves,points]=await Promise.all([
      nveLakeQueryAll(2,{west,south,east,north,where,outFields:'vatnlnr,innsjonavn,dybde_m',resultRecordCount:2000},12000),
      nveLakeQueryAll(1,{west,south,east,north,where,outFields:'vatnlnr,innsjonavn,dybde_m',resultRecordCount:2000},8000)
    ]);
    const contourSamples=densifyGeoJsonLines(curves?.features||[],3000),depthPointSamples=nvePointSamples(points?.features||[],1300),shoreSamples=nveShorelineSamples(lake.geometry,1000);
    const samples=[...contourSamples,...depthPointSamples,...shoreSamples];
    if(contourSamples.length<6&&depthPointSamples.length<4)throw new Error(`NVE har dybdekart for ${context.lakeName}, men dette utsnittet inneholder for lite målegeometri. Zoom nærmere dybdekotene.`);
    const metaProps=nveFeatureProperties(meta?.features?.[0]||{}),surveyQuality=nveSurveyQuality(metaProps),documentedMax=Number(metaProps.maksdyp_m??metaProps.maksdyp);
    const observedMax=Math.max(0,...samples.map(s=>Number(s.depth)||0));const maxDepth=Math.max(1,Number.isFinite(documentedMax)?documentedMax:observedMax,observedMax);
    const elevations=Array.from({length:plan.height},()=>Array(plan.width).fill(null)),depths=Array.from({length:plan.height},()=>Array(plan.width).fill(null));let validSea=0;
    for(let row=0;row<plan.height;row++){
      const lat=north-(north-south)*row/Math.max(1,plan.height-1);
      for(let col=0;col<plan.width;col++){
        const lon=west+(east-west)*col/Math.max(1,plan.width-1);if(!geoJsonContainsPoint(lake.geometry,lon,lat))continue;
        const depth=inverseDistanceDepth(samples,lon,lat,centerLat,maxDepth);if(!Number.isFinite(depth))continue;depths[row][col]=depth;elevations[row][col]=-depth;validSea++;
      }
    }
    if(validSea<Math.max(40,plan.totalPoints*.08))throw new Error(`For lite NVE-dybdedata i kartutsnittet for ${context.lakeName}. Zoom nærmere vannet.`);
    return {west,south,east,north,width:plan.width,height:plan.height,quality:plan.quality,elevations,depths,maxDepth,maxLand:0,validSea,validLand:0,source:'NVE Innsjødatabase2',dataSource:surveyQuality.label,sourceResolution:null,samplingApproxM:plan.spacingM,generatedAt:new Date().toISOString(),waterType:'freshwater',lakeId,lakeName:context.lakeName,survey:{maxDepth:Number.isFinite(documentedMax)?documentedMax:null,meanDepth:Number.isFinite(Number(metaProps.middeldyp_m))?Number(metaProps.middeldyp_m):null,quality:surveyQuality,curveCount:curves.features.length,pointCount:points.features.length,pages:{curves:curves.pages,points:points.pages}},navigationWarning:'NVE-dybder og interpolert flate er kun for fiskeplanlegging, ikke navigasjon.'};
  });
}

function sampleBathymetryGridDepth(grid,lat,lon){
  if(!grid||!Array.isArray(grid.depths)||lon<grid.west||lon>grid.east||lat<grid.south||lat>grid.north)return null;
  const x=(lon-grid.west)/Math.max(Number.EPSILON,grid.east-grid.west)*Math.max(1,grid.width-1);
  const y=(grid.north-lat)/Math.max(Number.EPSILON,grid.north-grid.south)*Math.max(1,grid.height-1);
  const c0=Math.floor(x),c1=Math.min(grid.width-1,c0+1),r0=Math.floor(y),r1=Math.min(grid.height-1,r0+1),tx=x-c0,ty=y-r0;
  const vals=[[r0,c0,(1-tx)*(1-ty)],[r0,c1,tx*(1-ty)],[r1,c0,(1-tx)*ty],[r1,c1,tx*ty]];
  let sum=0,weight=0;for(const [r,c,w] of vals){const d=grid.depths?.[r]?.[c];if(Number.isFinite(d)){sum+=d*w;weight+=w;}}
  if(weight>0)return Number((sum/weight).toFixed(2));
  const rr=Math.max(0,Math.min(grid.height-1,Math.round(y))),cc=Math.max(0,Math.min(grid.width-1,Math.round(x))),d=grid.depths?.[rr]?.[cc];return Number.isFinite(d)?Number(d.toFixed(2)):null;
}
function freshwaterStructureFromGrid(grid,lat,lon){
  const center=sampleBathymetryGridDepth(grid,lat,lon);if(!Number.isFinite(center))return {depth:null,structure:{available:false,label:'NVE-dybde finnes ikke ved punktet',score:null,slopeMPer100:null,depthDelta:null,offshoreDepth:null,offshoreDistanceM:null}};
  let best=null;
  for(const distanceM of [60,120,180])for(let bearing=0;bearing<360;bearing+=45){const p=destinationPoint(lat,lon,bearing,distanceM),d=sampleBathymetryGridDepth(grid,p.lat,p.lon);if(!Number.isFinite(d))continue;const delta=Math.abs(d-center);if(!best||delta>best.delta)best={depth:d,delta,distanceM,bearing};}
  const structure=best?classifyQuickStructure(center,best.depth,best.distanceM):{available:false,label:'Dybde registrert, men struktur kunne ikke beregnes',score:null,slopeMPer100:null,depthDelta:null,offshoreDepth:null,offshoreDistanceM:null};
  if(structure.available)structure.direction=best.bearing;
  return {depth:center,structure};
}
async function freshwaterDepthOverlay({west,south,east,north,zoom=13,focusLat=null,focusLon=null}){
  const centerLon=Number.isFinite(focusLon)?focusLon:(west+east)/2,centerLat=Number.isFinite(focusLat)?focusLat:(south+north)/2;
  const key=`nve-overlay:${west.toFixed(3)},${south.toFixed(3)},${east.toFixed(3)},${north.toFixed(3)}@${Math.round(zoom)}`;
  return cached(key,2*60*60*1000,async()=>{
    const context=await resolveNveDepthContext({west,south,east,north,centerLon,centerLat});
    const base=context.lake,baseProps=nveFeatureProperties(base||{});
    if(!base)return {available:false,measured:false,lakeName:null,lakeId:null,curveCount:0,pointCount:0,maxDepth:null,surveyMethod:null,surveyQuality:null,curves:{type:'FeatureCollection',features:[]},points:{type:'FeatureCollection',features:[]},lake:{type:'FeatureCollection',features:[]},source:'NVE Innsjødatabase2',message:'Fant ikke et NVE-vann i utsnittet.'};
    if(!context.hasDepthMap)return {available:false,measured:false,lakeName:context.lakeName,lakeId:context.lakeId,curveCount:0,pointCount:0,maxDepth:null,surveyMethod:null,surveyQuality:null,curves:{type:'FeatureCollection',features:[]},points:{type:'FeatureCollection',features:[]},lake:{type:'FeatureCollection',features:[base]},source:'NVE Innsjødatabase2',message:`NVE har ikke registrert oppmålt dybdekart for ${context.lakeName}.`};
    const where=context.where,lakeId=context.lakeId,lakeName=context.lakeName,meta=context.meta;
    const [curves,points]=await Promise.all([
      nveLakeQueryAll(2,{west,south,east,north,where,outFields:'vatnlnr,innsjonavn,dybde_m',resultRecordCount:2000},12000),
      nveLakeQueryAll(1,{west,south,east,north,where,outFields:'vatnlnr,innsjonavn,dybde_m',resultRecordCount:2000},8000)
    ]);
    const cf=(curves?.features||[]).map(f=>({...f,properties:{...nveFeatureProperties(f),fisteKind:'curve'}}));
    const pf=(points?.features||[]).map(f=>({...f,properties:{...nveFeatureProperties(f),fisteKind:'point'}}));
    const mp=nveFeatureProperties(meta?.features?.[0]||{}),maxDepth=Number(mp.maksdyp_m??mp.maksdyp),surveyQuality=nveSurveyQuality(mp);
    return {available:cf.length>0||pf.length>0,measured:true,lakeName,lakeId,curveCount:cf.length,pointCount:pf.length,maxDepth:Number.isFinite(maxDepth)?maxDepth:null,meanDepth:Number.isFinite(Number(mp.middeldyp_m))?Number(mp.middeldyp_m):null,surveyMethod:surveyQuality.label,surveyQuality,curves:{type:'FeatureCollection',features:cf},points:{type:'FeatureCollection',features:pf},lake:{type:'FeatureCollection',features:[base]},source:'NVE Innsjødatabase2 · Dybdekart + DybdeKurve/DybdePunkt',pages:{curves:curves.pages,points:points.pages},generatedAt:new Date().toISOString()};
  });
}

function buildZoneBiteGuide({zone,currentWeather,fishType}){
  const habitat=clamp(Number(zone?.analysis?.habitat)||50,0,100),hourly=Array.isArray(currentWeather?.hourly)?currentWeather.hourly:[];
  const timeline=hourly.slice(0,12).map(item=>{const live=fishingHourScore(item,fishType);const score=clamp(Math.round(habitat*.58+live.score*.42),0,100);return {time:item.time,score,label:score>=82?'Svært bra':score>=68?'Bra':score>=52?'Brukbart':'Svakt'};});
  const current=timeline[0]?.score??clamp(Math.round(Number(zone?.score)||0),0,100),best=timeline.slice().sort((a,b)=>b.score-a.score)[0]||null;
  const profile=zone?.lure?.idealProfile||{};
  return {score:current,label:current>=82?'Svært gode huggforhold':current>=68?'Gode huggforhold':current>=52?'Brukbare huggforhold':'Svake huggforhold',timeline,bestTime:best?.time||null,recommended:{type:profile.type||'Sluk/wobbler tilpasset forholdene',color:profile.color||'Tilpass lys og vannfarge',size:profile.size||'Middels størrelse',targetDepth:profile.targetDepth||'',method:profile.presentation||'Varier fart og korte pauser.',whyNow:profile.whyNow||'',basis:profile.basis||'',sources:profile.sources||[],referenceModel:profile.referenceModel||null},disclaimer:'BiteScore er en veiledende forholdsscore, ikke sannsynlighet eller garanti for fangst. BiteGuide-profilen beregnes uavhengig av slukene i din egen boks.'};
}
async function kartverketBathymetryGrid({west,south,east,north,zoom=13,quality='standard'}) {
  const plan=bathymetryGridPlan({west,south,east,north,zoom,quality});
  const key=`bathy-grid-kv:${plan.quality}:${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)},${plan.width}x${plan.height}`;
  return cached(key,6*60*60*1000,async()=>{
    const cells=[];
    for(let row=0;row<plan.height;row++){
      const lat=north-(north-south)*row/Math.max(1,plan.height-1);
      for(let col=0;col<plan.width;col++){
        const lon=west+(east-west)*col/Math.max(1,plan.width-1);
        cells.push({row,col,lat,lon});
      }
    }
    const batches=[];for(let i=0;i<cells.length;i+=50)batches.push(cells.slice(i,i+50));
    const responses=new Array(batches.length);let next=0;
    const workers=Array.from({length:Math.min(5,batches.length)},async()=>{
      while(true){const index=next++;if(index>=batches.length)return;responses[index]=await kartverketPointBatch(batches[index]);}
    });
    await Promise.all(workers);
    const elevations=Array.from({length:plan.height},()=>Array(plan.width).fill(null));
    const depths=Array.from({length:plan.height},()=>Array(plan.width).fill(null));
    const sources=new Map();let maxDepth=0,maxLand=0,validSea=0,validLand=0,valid=0;
    batches.forEach((batch,batchIndex)=>batch.forEach((cell,i)=>{
      const point=responses[batchIndex]?.[i]||null,classified=classifyKartverketHeight(point);
      elevations[cell.row][cell.col]=classified.elevation;depths[cell.row][cell.col]=classified.depth;
      if(classified.elevation!==null)valid++;
      if(classified.isSea){validSea++;maxDepth=Math.max(maxDepth,classified.depth||0);}
      if(classified.isLand){validLand++;maxLand=Math.max(maxLand,classified.elevation||0);}
      const source=String(point?.datakilde||point?.dataKilde||'').trim();if(source)sources.set(source,(sources.get(source)||0)+1);
    }));
    if(valid<Math.max(80,plan.totalPoints*.55)) throw new Error('For lite Kartverket-data i dette utsnittet. Zoom nærmere og prøv igjen.');
    if(validSea<Math.max(12,plan.totalPoints*.015)) throw new Error('Utsnittet inneholder for lite registrert sjødybde. Flytt kartet mot sjøen eller zoom nærmere.');
    const dominantSource=[...sources.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'Kartverket høydedata';
    return {west,south,east,north,width:plan.width,height:plan.height,quality:plan.quality,elevations,depths,maxDepth,maxLand,validSea,validLand,source:'Kartverket Høyde- og dybdedata',dataSource:dominantSource,sourceResolution:null,samplingApproxM:plan.spacingM,generatedAt:new Date().toISOString(),navigationWarning:'Dybdene er kun for planlegging og må ikke brukes til navigasjon.'};
  });
}

function send(res, code, data, type='application/json; charset=utf-8', extraHeaders={}) {
  res.writeHead(code, {'Content-Type':type,'Access-Control-Allow-Origin':'*','Cache-Control':type.startsWith('application/json')?'no-store':'public, max-age=3600', ...extraHeaders});
  const body=type.startsWith('application/json')&&!Buffer.isBuffer(data)&&typeof data!=='string'?JSON.stringify(data):data;
  res.end(body);
}
async function handleApi(req,res,url) {
  try {
    if(url.pathname==='/api/health') return send(res,200,{ok:true,app:'Vestfjella Fiske / Fiste 2',version:'stable-1.7',revision:APP_REVISION,repo:'aikongen2026/FISTE-2',hsiSplit:true,terrain3d:true,bathymetry3d:true,bathymetrySource:'nve-dybdekart',freshwaterBathymetry3d:true,freshwaterDepthOverlay:true,freshwaterSpeciesDepthRanking:true,biteGuide:true,biteGuideIndependent:true,smartOwnedLureMatching:true,nveDepthMetadataCheck:true,nveLakeGeometryFallback:true,nvePagination:true,waterDirectory:VESTFJELLA_WATERS.count,nveHydApiConfigured:Boolean(NVE_API_KEY)});
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
    if(url.pathname==='/api/freshwater-depth-overlay') {
      let input;try{input=validateZoneRequest(url.searchParams.get('bbox'),url.searchParams.get('zoom')||'13');}catch(error){return send(res,400,{error:error.message});}
      const focusLat=Number(url.searchParams.get('focusLat')),focusLon=Number(url.searchParams.get('focusLon'));
      if(Number.isFinite(focusLat)&&Number.isFinite(focusLon))input={...input,focusLat,focusLon};
      try{return send(res,200,await freshwaterDepthOverlay(input),'application/json; charset=utf-8',{'Cache-Control':'public, max-age=7200'});}catch(error){return send(res,502,{error:error.message});}
    }
    if(url.pathname==='/api/bathymetry-grid') {
      let input;try{input=validateZoneRequest(url.searchParams.get('bbox'),url.searchParams.get('zoom')||'13');}catch(error){return send(res,400,{error:error.message});}
      const quality=url.searchParams.get('quality')==='mobile'?'mobile':'standard';
      const water=url.searchParams.get('water')==='freshwater'?'freshwater':'saltwater';
      const focusLat=Number(url.searchParams.get('focusLat')),focusLon=Number(url.searchParams.get('focusLon'));
      const focus=Number.isFinite(focusLat)&&Number.isFinite(focusLon)?{focusLat,focusLon}:{};
      try{const data=water==='freshwater'?await nveFreshwaterBathymetryGrid({...input,quality,...focus}):await kartverketBathymetryGrid({...input,quality});return send(res,200,data,'application/json; charset=utf-8',{'Cache-Control':'public, max-age=21600'});}catch(error){return send(res,502,{error:error.message});}
    }
    if(url.pathname==='/api/bathymetry-raster') {
      let input;try{input=validateZoneRequest(url.searchParams.get('bbox'),url.searchParams.get('zoom')||'13');}catch(error){return send(res,400,{error:error.message});}
      try{const result=await bathymetryRaster(input);return send(res,200,result.buffer,'image/tiff',{'X-Fiste-Bathymetry-Source':result.source,'X-Fiste-Source-Resolution-M':String(result.sourceResolutionM),'X-Fiste-Sampling-M':String(result.samplingApproxM),'Cache-Control':'public, max-age=21600'});}catch(error){return send(res,502,{error:error.message});}
    }
    if(url.pathname==='/api/depth-profile') {
      const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon')),coastNormal=Number(url.searchParams.get('coastNormal'));
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<57||lat>72||lon<3||lon>32) return send(res,400,{error:'Ugyldig lat/lon for norskekysten'});
      if(!Number.isFinite(coastNormal)||coastNormal<0||coastNormal>360) return send(res,400,{error:'Mangler gyldig kystnormal for dybdeprofil'});
      return send(res,200,await depthProfileAtPoint(lat,lon,coastNormal));
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
      if((allMode||isFreshwaterFish(fishSelection))&&(input.east-input.west>0.5||input.north-input.south>0.5)) return send(res,400,{error:'Zoom nærmere vannet for ferskvannsanalyse.'});
      const lat=(input.south+input.north)/2,lon=(input.west+input.east)/2;
      let current=null,marineConditions=null,weatherWarning=null,marineWarning=null;
      const moon=moonInfo();
      const tasks=[weather(lat,lon).then(value=>{current=value;}).catch(()=>{weatherWarning='Værdata er midlertidig utilgjengelig.';})];
      if(!allMode&&!isFreshwaterFish(fishSelection)) tasks.push(marine(lat,lon).then(value=>{marineConditions=value;}).catch(()=>{marineWarning='Marine modelldata er midlertidig utilgjengelig; score beregnes uten sjøtemperatur, bølger, strøm og tidevann.';}));
      await Promise.all(tasks);
      if(allMode){
        const freshTypes=['orret','abbor'];
        const results=[];
        // Vestfjella «Ingen» betyr ørret + abbor. Kjør sekvensielt slik at NVE/OSM-cache gjenbrukes.
        for(const type of freshTypes) results.push(await generateZones(input,current,type,{goal:'numbers',baseLat,baseLon,radiusM,moon,limit:12}));
        const zones=results.flatMap((result,groupIndex)=>result.zones.slice(0,6).map((zone,index)=>({...zone,id:`${freshTypes[groupIndex]}-${zone.id}`,fishType:freshTypes[groupIndex],fishLabel:FISH_TYPES[freshTypes[groupIndex]],speciesRank:index+1}))).sort((a,b)=>b.score-a.score).slice(0,12);
        const stats={tested:results.reduce((sum,r)=>sum+(r.stats.tested||0),0),rejected:results.reduce((sum,r)=>sum+(r.stats.rejected||0),0),goal:'numbers',base:hasBase?{lat:baseLat,lon:baseLon}:null,radiusM:hasRadius?radiusM:null,strictLandmask:true,waterType:'freshwater',waterMaskAvailable:results.every(r=>r.stats.waterMaskAvailable!==false),freshwaterAreas:Math.max(...results.map(r=>r.stats.freshwaterAreas||0)),freshwaterLookup:results.find(r=>r.stats.freshwaterLookup)?.stats.freshwaterLookup||null,freshwaterDepthSource:results.find(r=>r.stats.freshwaterDepthSource)?.stats.freshwaterDepthSource||null,restrictedWaters:Math.max(...results.map(r=>r.stats.restrictedWaters||0)),hardRestrictionFilter:true,depthAvailable:zones.filter(z=>Number.isFinite(z.depth?.meters)).length,depthResolutionM:results.find(r=>r.stats.depthResolutionM)?.stats.depthResolutionM||null,generatedAt:new Date().toISOString(),source:'Flerartsanalyse Vestfjella: ørret + abbor · NVE Innsjødatabase/Dybdekart + OSM + MET Norway'};
        const publicWeather=current?{...current}:null;if(publicWeather) delete publicWeather.hourly;
        const bestTimes=bestFishingTimes(current?.hourly||[],'orret');
        const resultWarnings=results.map(r=>r.stats.warning).filter(Boolean);
        return send(res,200,{zones,stats,fishType:'all',fishLabel:'Ørret + abbor',weather:publicWeather,marine:marineConditions,moon,bestTimes,warnings:[weatherWarning,marineWarning,...resultWarnings].filter(Boolean)});
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
function startServer(port=PORT) { const server=createServer(); return server.listen(port,()=>{ let ip='localhost'; for(const list of Object.values(os.networkInterfaces())) for(const item of list||[]) if(item.family==='IPv4'&&!item.internal) ip=item.address; console.log(`Vestfjella Fiske / Fiste 2 kjører på http://${ip}:${port}`); }); }
if(require.main===module) startServer();
module.exports={nveLakeQuery,nveLakeQueryAll,nveSurveyQuality,resolveNveDepthContext,nveFeaturesToFreshwaterAreas,fetchNveFreshwaterAreas,deriveIdealLureProfile,colorTagsFromText,selectPhotographedLures,sourceBackedLureChoice,kartverketBathymetryGrid,nveFreshwaterBathymetryGrid,freshwaterDepthOverlay,sampleBathymetryGridDepth,freshwaterStructureFromGrid,geoJsonContainsPoint,inverseDistanceDepth,buildZoneBiteGuide,bathymetryGridPlan,classifyKartverketHeight,lonLatToUtm33,bathymetryRaster,computeScore,computeLiveScore,computeHabitatScore,buildAnalysisConfidence,classifyQuickStructure,classifyDepthProfile,depthProfileAtPoint,fetchMarineHabitatContext,marineHabitatAtPoint,legalStatusForPoint,environmentalScoreAdjustments,moonInfo,deriveMarineSummary,marine,hydrology,boatRamps,validateZoneRequest,createBoundedCache,windExposure,formatReason,recommendLure,lureCatalog,parseDepthFeatureInfo,depthAtPoint,norwegianHour,buildDataQuality,normalizeFishType,normalizeFishSelection,searchBoundsForBase,isFreshwaterFish,isNearOfficialNoFishingZone,parseFreshwaterAreas,freshwaterAtPoint,freshwaterCandidateGrid,freshwaterCoastInfo,polygonMostlyInFreshwater,parseNominatimWater,fetchNominatimWater,fetchFreshwaterAreas,bestFishingTimes,MAX_ZONE_COUNT,MAX_ZONE_CANDIDATES,FISH_TYPES,createServer,startServer,weather,generateZones,VESTFJELLA_WATERS,VESTFJELLA_BOUNDS,normalizeWaterLookupName,waterNameSimilarity,locateVestfjellaWater,flyOnlyLureAdvice,isVestfjellaFlyOnly};
