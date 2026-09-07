const uiStateKey='vestfjella-fiske-ui-state-stable-1-2';
function readUiState(){try{return JSON.parse(localStorage.getItem(uiStateKey)||'{}')||{};}catch{return {};}}
function saveUiState(){try{const c=map.getCenter();localStorage.setItem(uiStateKey,JSON.stringify({fishType:$('fishType')?.value||'',fishGoal:$('fishGoal')?.value||'numbers',baseRadius:$('baseRadius')?.value||'500',mapStyle:$('mapStyle')?.value||'standard',center:[c.lat,c.lng],zoom:map.getZoom(),basePoint}));}catch{}}
const savedUiState=readUiState();
const initialCenter=Array.isArray(savedUiState.center)&&savedUiState.center.length===2?savedUiState.center:[59.2700,11.5890];
const initialZoom=Number.isFinite(savedUiState.zoom)?savedUiState.zoom:13;
const map = L.map('map', { zoomControl: true }).setView(initialCenter, initialZoom);
const standardLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const satelliteLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Tiles © Esri'});
const hybridLabelsLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Labels © Esri'});
const seaChartLayer=L.tileLayer.wms('https://wms.geonorge.no/skwms1/wms.sjokartraster2',{layers:'all',styles:'',format:'image/png',transparent:false,version:'1.3.0',tileSize:512,updateWhenIdle:true,updateWhenZooming:false,keepBuffer:1,maxZoom:18,attribution:'© Kartverket · sjøkart raster'});
const detailedDepthLayer=L.tileLayer.wms('https://wms.geonorge.no/skwms1/wms.dybdedata2',{layers:'Dybdedata2',styles:'',format:'image/png',transparent:true,version:'1.3.0',tileSize:512,updateWhenIdle:true,updateWhenZooming:false,keepBuffer:1,opacity:.94,maxZoom:18,attribution:'© Kartverket · Sjøkart Dybdedata'});
const nveDepthLayer = L.tileLayer.wms('https://kart.nve.no/enterprise/services/Innsjodatabase2/MapServer/WMSServer', { layers: 'DybdeKurve,DybdePunkt', format: 'image/png', transparent: true, version: '1.3.0', maxZoom: 18, attribution: 'Kilde: <a href="https://data.norge.no/nb/datasets/a797219c-8378-3914-9bde-1ae4db09e370/dybdekart" target="_blank" rel="noopener">NVE – Innsjødatabase/Dybdekart</a>' });
let seaChartTileErrors=0,depthTileErrors=0;
seaChartLayer.on('tileerror',()=>{ if(++seaChartTileErrors===3 && $('mapStyle')?.value==='chart') $('warnings').textContent='Kartverkets sjøkart bruker litt tid eller mangler en kartflis. Standardkartet ligger under og blir stående synlig mens sjøkartet lastes.'; });
detailedDepthLayer.on('tileerror',()=>{ if(++depthTileErrors===3 && $('mapStyle')?.value==='fishing') $('warnings').textContent='Kartverkets dybdedata bruker litt tid eller mangler en kartflis. Grunnkartet beholdes under, så kartet blir ikke svart.'; });
seaChartLayer.on('tileload',()=>{seaChartTileErrors=0;}); detailedDepthLayer.on('tileload',()=>{depthTileErrors=0;});

const $ = id => document.getElementById(id);
const zoneLayer = L.layerGroup().addTo(map);
const navigationLayer = L.layerGroup().addTo(map);
const sourceSpotLayer = L.layerGroup().addTo(map);
const restrictionLayer = L.layerGroup().addTo(map);
const conditionLayer = L.layerGroup().addTo(map);
const boatRampLayer = L.layerGroup().addTo(map);
const waterFocusLayer = L.layerGroup().addTo(map);
const mapContainerObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
mapContainerObserver.observe(document.querySelector('.map-wrap'));
window.addEventListener('load', () => setTimeout(() => map.invalidateSize({ pan: false }), 0));
let timer;
let controller;
let locationMarker;
let baseMarker;
let baseRadiusCircle;
let basePoint=savedUiState.basePoint&&Number.isFinite(savedUiState.basePoint.lat)&&Number.isFinite(savedUiState.basePoint.lon)?savedUiState.basePoint:null;
let latestZones=[];
let waterDirectoryItems=[];
let waterDirectoryMeta={};
let selectedWaterDirectoryName=null;
const labels = { vind:'Vind', skydekke:'Skydekke', kyst:'Kyst', vannkant:'Vannkant', eksponering:'Eksponering', temperatur:'Temperatur', lufttemperatur:'Lufttemperatur', tidspunkt:'Tidspunkt', dybde:'Dybde', storfisk:'Stor fisk', lufttrykk:'Lufttrykk', sjoetemperatur:'Sjøtemp', boelger:'Bølger', havstroem:'Havstrøm', tidevann:'Tidevann', maane:'Måne', personlig:'Mine fangster' };
const freshwaterFishTypes = new Set(['orret','abbor']);
const catchStorageKey='vestfjella-fiske-catch-log-v1';
const analysisCacheKey='vestfjella-fiske-last-analysis-stable-1-2';
const fishLabels={all:'Ørret + abbor',orret:'Ørret',abbor:'Abbor'};
const speciesColors={orret:'#ef4444',abbor:'#3b82f6'};
let latestWeather=null;
let latestMarine=null;
let latestMoon=null;
let latestHydrology=null;
let showConditionVectors=false;
let showBoatRamps=false;
let sourceSpotData=null;
let restrictionData=null;
let showSourceSpots=true;
let showRestrictions=true;
const lureViewer = $('lureViewer');
const lureViewerImage = $('lureViewerImage');
const lureViewerCaption = $('lureViewerCaption');

let lureViewerHistoryActive=false;
function openLureViewer(src, caption='Anbefalt sluk') {
  if(!lureViewer.open){ history.pushState({lureViewer:true},''); lureViewerHistoryActive=true; }
  lureViewerImage.src = src;
  lureViewerImage.alt = caption;
  lureViewerCaption.textContent = caption;
  if (typeof lureViewer.showModal === 'function') lureViewer.showModal();
  else lureViewer.setAttribute('open', '');
}


function formatDistance(m){ if(!Number.isFinite(m)) return 'Avstand ikke satt'; return m<1000?`${Math.round(m)} m`:`${(m/1000).toFixed(1).replace('.',',')} km`; }
function radiusBounds(point,radiusM){
  const radius=Math.max(150,Number(radiusM)||0);
  const latPad=radius/110540;
  const lonPad=radius/(111320*Math.max(.2,Math.cos(point.lat*Math.PI/180)));
  return L.latLngBounds([point.lat-latPad,point.lon-lonPad],[point.lat+latPad,point.lon+lonPad]);
}
function updateBaseRadiusCircle(){
  if(baseRadiusCircle){baseRadiusCircle.remove();baseRadiusCircle=null;}
  const radius=Number($('baseRadius').value)||0;
  if(!basePoint||!radius) return;
  baseRadiusCircle=L.circle([basePoint.lat,basePoint.lon],{radius,color:'#38d477',weight:2,dashArray:'7 7',fillColor:'#38d477',fillOpacity:.045,interactive:false}).addTo(map);
}
function focusBaseRadius(){
  const radius=Number($('baseRadius').value)||0;
  if(!basePoint||!radius) return;
  updateBaseRadiusCircle();
  map.fitBounds(radiusBounds(basePoint,radius*1.08),{padding:[28,28],maxZoom:radius<=250?16:radius<=500?15:radius<=1000?14:13});
}
function clearBasePoint(){
  basePoint=null;
  if(baseMarker){baseMarker.remove();baseMarker=null;}
  if(baseRadiusCircle){baseRadiusCircle.remove();baseRadiusCircle=null;}
  $('baseRadius').value='0';
  $('setBase').textContent='⌖ Sett base';
  $('setBase').classList.remove('base-active');
  $('setBase').setAttribute('aria-pressed','false');
  navigationLayer.clearLayers();
  saveUiState();
  setState('ready','Base fjernet · avstandsfilter er slått av.');
  loadZones({immediate:true});
}
function setBasePoint(latlng,{label='Base',focus=true}={}){
  basePoint={lat:Number(latlng.lat),lon:Number(latlng.lng)};
  if(baseMarker) baseMarker.remove();
  baseMarker=L.marker([basePoint.lat,basePoint.lon],{title:label}).addTo(map).bindPopup(`<b>${escapeHtml(label)}</b><br>Startpunkt for avstandsfilter`);
  $('setBase').textContent='✓ Base satt · fjern';
  $('setBase').classList.add('base-active');
  $('setBase').setAttribute('aria-pressed','true');
  saveUiState();
  updateBaseRadiusCircle();
  if(focus) focusBaseRadius();
  loadZones({immediate:true});
}
function drawNavigation(zones=[]){
  navigationLayer.clearLayers();
  if(!zones.length) return;
  const best=zones[0];
  if(basePoint&&Number.isFinite(best.distanceM)){
    L.polyline([[basePoint.lat,basePoint.lon],[best.marker.lat,best.marker.lon]],{color:'#38d477',weight:4,dashArray:'8 8',opacity:.9}).addTo(navigationLayer);
  }
  zones.slice(0,3).forEach((zone,index)=>{
    if(!Number.isFinite(zone.castBearing)) return;
    const length=index===0?85:55, rad=zone.castBearing*Math.PI/180;
    const dLat=(Math.sin(rad)*length)/110540;
    const dLon=(Math.cos(rad)*length)/(111320*Math.cos(zone.marker.lat*Math.PI/180));
    L.polyline([[zone.marker.lat,zone.marker.lon],[zone.marker.lat+dLat,zone.marker.lon+dLon]],{color:index===0?'#ff9f1c':'#f2c94c',weight:index===0?5:3,opacity:.95}).bindTooltip(index===0?'Kast langs kanten':'Kastretning',{permanent:false}).addTo(navigationLayer);
  });
}
function renderBestNow(zones=[]){
  const holder=$('bestNow');
  $('goalBadge').textContent=$('fishType').value==='all'?'Ørret + abbor':($('fishGoal').value==='big'?'STOR FISK':'Mest fisk');
  if(!zones.length){ holder.innerHTML='<p class="muted">Ingen anbefalt sone innen valgt utsnitt/avstand. Øk radius eller flytt kartet litt.</p>'; return; }
  const zone=zones[0], lure=zone.lure||{}, w=lure.wobbler||{};
  const big=$('fishGoal').value==='big';
  const allMode=$('fishType').value==='all';
  const zoneFish=zone.fishType||$('fishType').value;
  const zoneFishLabel=zone.fishLabel||fishLabels[zoneFish]||'';
  holder.innerHTML=`<div class="best-now-grid"><div class="best-now-score"><strong>${zone.score}</strong><span>/100</span></div><div><span class="best-now-kicker">${big&&!allMode?'🏆 STOR FISK':'🎯 BEST MATCH'} · ${escapeHtml(zoneFishLabel)}</span><h3>${escapeHtml(zone.waterName||zone.name)}</h3><p>${escapeHtml(zone.reason||'')}</p></div></div><div class="best-now-facts"><article><span>Avstand fra base</span><b>${formatDistance(zone.distanceM)}</b></article><article><span>Bruk nå</span><b>${escapeHtml(lure.type||'Anbefalt agn')} · ${escapeHtml(lure.weight||'')}</b></article><article><span>Farge</span><b>${escapeHtml(lure.color||'')}</b></article>${zone.personalAdjustment?`<article><span>Mine fangstdata</span><b>+${zone.personalAdjustment} poeng</b></article>`:''}</div><div class="best-now-actions"><button type="button" id="goBest">VIS PÅ KART</button><span>Orange linje = foreslått kastretning langs vannkanten.</span></div>`;
  $('goBest')?.addEventListener('click',()=>{ map.setView([zone.marker.lat,zone.marker.lon],Math.max(map.getZoom(),16)); selectZone(zone.id,{scroll:true}); });
}

function scoreColor(score) { return score >= 82 ? '#38d477' : score >= 68 ? '#b8df45' : '#f2c94c'; }
function setState(state, text) {
  $('appState').dataset.state = state;
  $('status').textContent = text;
  $('retry').hidden = state !== 'error';
}
function formatValue(value, suffix='') { return Number.isFinite(value) ? `${value}${suffix}` : '–'; }
function formatSourceTime(value) {
  if (!value) return 'ukjent tidspunkt';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'ukjent tidspunkt' : date.toLocaleString('no-NO',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
}
function signed(value,digits=1,suffix='') {
  if(!Number.isFinite(value)) return '–';
  return `${value>0?'+':''}${Number(value).toFixed(digits)}${suffix}`;
}
function compass(degrees) {
  if(!Number.isFinite(degrees)) return '–';
  const dirs=['N','NØ','Ø','SØ','S','SV','V','NV'];
  return `${dirs[Math.round((((degrees%360)+360)%360)/45)%8]} · ${Math.round(degrees)}°`;
}
function renderWeather(weather) {
  if (!weather) {
    $('weatherGrid').innerHTML = '<p class="muted span-all">Værdata er ikke tilgjengelig akkurat nå.</p>';
    return;
  }
  const trend = Number.isFinite(weather.tempTrend) ? `${weather.tempTrend > 0 ? '+' : ''}${weather.tempTrend}° / 3 t` : '–';
  const pressureTrend=Number.isFinite(weather.pressureTrend)?signed(weather.pressureTrend,1,' hPa / 3 t'):'–';
  $('weatherGrid').innerHTML = [
    ['Vind', formatValue(weather.wind, ' m/s')],
    ['Retning', compass(weather.windDirection)],
    ['Skydekke', formatValue(Math.round(weather.cloud), '%')],
    ['Nedbør', formatValue(weather.precipitation, ' mm/t')],
    ['Temperatur', formatValue(weather.temp, '°C')],
    ['Temptrend', trend],
    ['Lufttrykk', Number.isFinite(weather.pressure)?`${Math.round(weather.pressure)} hPa`:'–'],
    ['Trykktrend', pressureTrend],
    ['Kilde', weather.source || 'MET Norway']
  ].map(([label,value]) => `<div class="weather-item"><span>${label}</span><strong>${value}</strong></div>`).join('');
}
function formatMarineTime(point) {
  if(!point?.time) return '–';
  const d=new Date(point.time);return Number.isNaN(d.getTime())?'–':`${d.toLocaleTimeString('no-NO',{hour:'2-digit',minute:'2-digit'})} · ${Number.isFinite(point.level)?point.level.toFixed(2)+' m':''}`;
}
function renderMarine(marine,moon) {
  const card=$('marineCard');
  const freshwater=$('fishType').value==='all'||freshwaterFishTypes.has($('fishType').value);
  card.hidden=freshwater||!Object.hasOwn(fishLabels,$('fishType').value);
  if(card.hidden) return;
  if(!marine){$('marineGrid').innerHTML='<p class="muted span-all">Marine modelldata er ikke tilgjengelig akkurat nå.</p>';$('marineCaveat').textContent='Score beregnes videre uten marine tillegg.';return;}
  const tide=marine.tideState?`${marine.tideState[0].toUpperCase()+marine.tideState.slice(1)} · ${signed(marine.tideTrend3h,2,' m / 3 t')}`:'–';
  $('marineGrid').innerHTML=[
    ['Sjøtemperatur',Number.isFinite(marine.seaTemp)?`${marine.seaTemp.toFixed(1)} °C`:'–'],
    ['Bølger',Number.isFinite(marine.waveHeight)?`${marine.waveHeight.toFixed(2)} m · ${Number.isFinite(marine.wavePeriod)?marine.wavePeriod.toFixed(1)+' s':'–'}`:'–'],
    ['Bølgeretning',compass(marine.waveDirection)],
    ['Havstrøm',Number.isFinite(marine.currentVelocity)?`${marine.currentVelocity.toFixed(2)} km/t`:'–'],
    ['Strømretning',compass(marine.currentDirection)],
    ['Tidevann',tide],
    ['Neste høyvann',formatMarineTime(marine.nextHigh)],
    ['Neste lavvann',formatMarineTime(marine.nextLow)],
    ['Måne',moon?`${moon.label} · ${moon.illuminationPct}%`:'–']
  ].map(([label,value])=>`<div class="weather-item"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('marineCaveat').innerHTML=`<b>Kilde:</b> ${escapeHtml(marine.source||'Open-Meteo Marine')} · ${formatSourceTime(marine.observedAt)}<br>${escapeHtml(marine.caveat||'Marine data er modellverdier og skal ikke brukes til navigasjon.')} Månefase har bare svak vekt i fiskescore.`;
}
function renderHydrology(data) {
  latestHydrology=data||null;
  const card=$('hydrologyCard');
  const freshwater=$('fishType').value==='all'||freshwaterFishTypes.has($('fishType').value);
  card.hidden=!freshwater;
  if(card.hidden) return;
  if(!data?.available){$('hydrologyGrid').innerHTML=`<p class="muted span-all">${escapeHtml(data?.reason||'NVE-data er ikke tilgjengelig akkurat nå.')}</p>`;$('hydrologyCaveat').textContent=data?.setup||'';return;}
  const row=(item,suffix)=>item&&Number.isFinite(item.value)?`${item.value} ${suffix}`:'–';
  $('hydrologyGrid').innerHTML=[
    ['Målestasjon',data.stationName||data.stationId||'–'],
    ['Avstand',Number.isFinite(data.distanceM)?formatDistance(data.distanceM):'–'],
    ['Vannstand',row(data.stage,'m')],
    ['Vannføring',row(data.discharge,'m³/s')],
    ['Vanntemperatur',row(data.waterTemp,'°C')]
  ].map(([label,value])=>`<div class="weather-item"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('hydrologyCaveat').innerHTML=`<b>Kilde:</b> NVE HydAPI. ${escapeHtml(data.caveat||'Bruk målestasjonen som referanse og kontroller lokalt vassdrag.')}`;
}
function renderConditionVectors() {
  conditionLayer.clearLayers();
  if(!showConditionVectors||$('fishType').value==='all'||freshwaterFishTypes.has($('fishType').value)||!latestWeather) return;
  const center=map.getCenter();
  const windHeading=Number.isFinite(latestWeather.windDirection)?(latestWeather.windDirection+180)%360:null;
  const currentHeading=Number.isFinite(latestMarine?.currentDirection)?latestMarine.currentDirection:null;
  const make=(kind,label,heading,value,offset)=>{
    if(!Number.isFinite(heading)) return;
    const icon=L.divIcon({className:`condition-vector ${kind}`,html:`<div><span style="transform:rotate(${heading}deg)">➤</span><b>${escapeHtml(label)}</b><small>${escapeHtml(value)}</small></div>`,iconSize:[106,52],iconAnchor:[53,26]});
    L.marker([center.lat+offset,center.lng],{icon,interactive:false}).addTo(conditionLayer);
  };
  const span=Math.max(.001,map.getBounds().getNorth()-map.getBounds().getSouth());
  make('wind','Vind',windHeading,Number.isFinite(latestWeather.wind)?`${latestWeather.wind} m/s`:'',span*.07);
  make('current','Strøm',currentHeading,Number.isFinite(latestMarine?.currentVelocity)?`${latestMarine.currentVelocity.toFixed(2)} km/t`:'',-span*.07);
}
async function loadBoatRamps() {
  boatRampLayer.clearLayers();
  if(!showBoatRamps) return;
  const bounds=map.getBounds();
  const bbox=[bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()].join(',');
  try{
    const response=await fetch(`/api/ramps?bbox=${encodeURIComponent(bbox)}&zoom=${map.getZoom()}`,{cache:'no-store'});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Båtrampedata feilet');
    for(const ramp of data.ramps||[]){
      const access=ramp.access?`<br>Adgang: ${escapeHtml(ramp.access)}`:'';
      const fee=ramp.fee?` · avgift: ${escapeHtml(ramp.fee)}`:'';
      L.circleMarker([ramp.lat,ramp.lon],{radius:7,color:'#051d27',weight:2,fillColor:'#72d7ff',fillOpacity:1}).bindTooltip(ramp.name||'Båtrampe',{sticky:true}).bindPopup(`<b>${escapeHtml(ramp.name||'Båtrampe / slip')}</b>${access}${fee}<br><small>Kilde: OpenStreetMap – kontroller adgang og lokale forhold før bruk.</small>`).addTo(boatRampLayer);
    }
    if(!(data.ramps||[]).length){const warning=$('warnings');warning.textContent=`${warning.textContent} Ingen OSM-registrerte båtramper i dette utsnittet.`.trim();}
  }catch(error){const warning=$('warnings');warning.textContent=`${warning.textContent} Båtrampelaget kunne ikke lastes.`.trim();}
}
async function loadHydrologyAtCenter() {
  if($('fishType').value!=='all'&&!freshwaterFishTypes.has($('fishType').value)) return;
  const c=map.getCenter();
  try{const response=await fetch(`/api/hydrology?lat=${c.lat.toFixed(5)}&lon=${c.lng.toFixed(5)}`,{cache:'no-store'});const data=await response.json();renderHydrology(response.ok?data:{available:false,reason:data.error||'NVE-data kunne ikke lastes.'});}
  catch{renderHydrology({available:false,reason:'NVE-data kunne ikke lastes mens du er offline.'});}
}

function escapeHtml(value) {
  return String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
}
function formatClock(value) {
  const date=new Date(value);
  return Number.isNaN(date.getTime())?'–':date.toLocaleTimeString('no-NO',{hour:'2-digit',minute:'2-digit'});
}
function renderBestTimes(advice={}) {
  if(!advice.available||!Array.isArray(advice.windows)||!advice.windows.length) {
    $('bestTimes').innerHTML=`<p class="muted">${escapeHtml(advice.message||'Dagens tidsprognose er ikke tilgjengelig akkurat nå.')}</p><small class="best-times-source">${escapeHtml(advice.source||'MET Norway')}</small>`;
    return;
  }
  const calculated=advice.generatedAt?` · beregnet ${formatSourceTime(advice.generatedAt)}`:'';
  $('bestTimes').innerHTML=`<div class="time-windows">${advice.windows.map((window,index)=>`<article class="time-window" data-rank="${index+1}"><div><span>${index===0?'Beste vindu':`Alternativ ${index+1}`}</span><b>${formatClock(window.start)}–${formatClock(window.end)}</b></div><strong>${escapeHtml(window.label)} · ${Number(window.score)||0}/100</strong><small>${escapeHtml(window.reason)}</small></article>`).join('')}</div><p class="best-times-disclaimer">${escapeHtml(advice.disclaimer||'Veiledende anbefaling – ingen garanti for fangst.')}</p><small class="best-times-source">Kilde: ${escapeHtml(advice.source||'MET Norway')}${calculated}</small>`;
}
function localDateTimeValue(date=new Date()) {
  return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
function readCatchEntries() {
  try {
    const parsed=JSON.parse(localStorage.getItem(catchStorageKey)||'[]');
    return Array.isArray(parsed)?parsed.filter(entry=>entry&&typeof entry==='object').slice(0,200):[];
  } catch {
    $('catchStatus').textContent='Kunne ikke lese den lokale fangstloggen. Nye poster kan fortsatt lagres.';
    return [];
  }
}
function writeCatchEntries(entries) {
  try { localStorage.setItem(catchStorageKey,JSON.stringify(entries.slice(0,200))); return true; }
  catch { $('catchStatus').textContent='Kunne ikke lagre lokalt. Kontroller at nettleserlagring er tillatt.'; return false; }
}
function catchWeatherText(weather) {
  weather=weather||{};
  const parts=[];
  if(Number.isFinite(weather.wind)) parts.push(`${weather.wind} m/s`);
  if(Number.isFinite(weather.cloud)) parts.push(`${Math.round(weather.cloud)} % skydekke`);
  if(Number.isFinite(weather.precipitation)) parts.push(`${weather.precipitation} mm/t nedbør`);
  if(Number.isFinite(weather.temp)) parts.push(`${weather.temp} °C`);
  if(Number.isFinite(weather.tempTrend)) parts.push(`${weather.tempTrend>0?'+':''}${weather.tempTrend} °C / 3 t`);
  if(Number.isFinite(weather.pressure)) parts.push(`${Math.round(weather.pressure)} hPa`);
  if(Number.isFinite(weather.seaTemp)) parts.push(`${weather.seaTemp.toFixed(1)} °C sjø`);
  if(Number.isFinite(weather.waveHeight)) parts.push(`${weather.waveHeight.toFixed(2)} m bølger`);
  if(weather.tideState) parts.push(`${weather.tideState} vann`);
  return parts.join(' · ');
}
function renderFishingInsights(entries=readCatchEntries(),fish=$('fishType').value) {
  if(fish==='all') return;
  const api=globalThis.FishingInsights;
  if(!api) {
    $('speciesGuide').innerHTML='<p class="muted">Artsguiden er midlertidig utilgjengelig.</p>';
    $('catchInsights').innerHTML='<p class="muted">Fangstmønstre er midlertidig utilgjengelige.</p>';
    return;
  }
  const guide=api.getSpeciesGuide(fish);
  $('speciesGuide').innerHTML=`<div class="species-guide-head"><div><span>Valgt art</span><h3>${escapeHtml(guide.name)}</h3></div><b>${escapeHtml(guide.season)}</b></div><div class="species-guide-grid"><article><span>Hvor</span><p>${escapeHtml(guide.habitat)}</p></article><article><span>Hvordan</span><p>${escapeHtml(guide.presentation)}</p></article><article><span>Vannsøyle</span><p>${escapeHtml(guide.waterColumn)}</p></article></div><p class="species-caution"><b>Husk:</b> ${escapeHtml(guide.caution)}</p>`;
  const insight=api.buildCatchInsights(entries,fish);
  const weather=catchWeatherText(insight.caughtWeather);
  const bestTime=insight.bestTime?`${escapeHtml(insight.bestTime.label)} · ${escapeHtml(insight.bestTime.range)} · ${insight.bestTime.rate} % fangstrate`:'Trenger minst to turer i samme tidsrom';
  const topLure=insight.topLure?`${escapeHtml(insight.topLure.label)} · ${insight.topLure.count} fangst${insight.topLure.count===1?'':'er'}`:'Ikke nok registrerte fangster';
  $('catchInsights').innerHTML=`<div class="insight-heading"><div><span>Mine data for ${escapeHtml(guide.name)}</span><h3>${escapeHtml(insight.confidence)}</h3></div><small>${escapeHtml(insight.message)}</small></div><div class="insight-metrics"><article><span>Turer</span><b>${insight.sessions}</b></article><article><span>Fangster</span><b>${insight.catches}</b></article><article><span>Fangstrate</span><b>${insight.catchRate} %</b></article></div><div class="pattern-list"><p><span>Beste tidsrom</span><b>${bestTime}</b></p><p><span>Mest vellykket agn</span><b>${topLure}</b></p><p><span>Gjennomsnittsvær ved fangst</span><b>${weather?escapeHtml(weather):'Ikke nok værdata'}</b></p></div>`;
}
function renderCatchEntries(entries=readCatchEntries()) {
  renderFishingInsights(entries);
  if(!entries.length) {
    $('catchEntries').innerHTML='<div class="empty catch-empty"><b>Ingen turer registrert ennå</b><span>Registrer både fangst og turer uten fangst. Det gir et ærligere erfaringsgrunnlag.</span></div>';
    return;
  }
  $('catchEntries').innerHTML=entries.map(entry=>{
    const date=new Date(entry.time);
    const when=Number.isNaN(date.getTime())?'Ukjent tid':date.toLocaleString('no-NO',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const metrics=[entry.length?`${escapeHtml(entry.length)} cm`:null,entry.weight?`${escapeHtml(entry.weight)} kg`:null].filter(Boolean).join(' · ');
    const weather=catchWeatherText(entry.weather);
    return `<article class="catch-entry" data-catch-id="${escapeHtml(entry.id)}"><div class="catch-entry-head"><div><span class="catch-result ${entry.result==='fangst'?'caught':'blank'}">${entry.result==='fangst'?'Fangst':'Ingen fangst'}</span><b>${escapeHtml(fishLabels[entry.fish]||entry.fish||'Ukjent art')}</b></div><button type="button" class="delete-catch secondary" data-delete-catch="${escapeHtml(entry.id)}" aria-label="Slett loggpost">Slett</button></div><time datetime="${escapeHtml(entry.time)}">${escapeHtml(when)}</time><p><b>${escapeHtml(entry.place||'Ukjent sted')}</b>${metrics?` · ${metrics}`:''}</p>${entry.lure?`<p>Sluk/agn: ${escapeHtml(entry.lure)}</p>`:''}${weather?`<small>Registrert vær: ${escapeHtml(weather)}</small>`:''}${entry.note?`<blockquote>${escapeHtml(entry.note)}</blockquote>`:''}</article>`;
  }).join('');
}
function setCatchDefaults() {
  $('catchTime').value=localDateTimeValue();
  if($('fishType').value!=='all') $('catchFish').value=$('fishType').value;
}
function initCatchLog() {
  setCatchDefaults();
  renderCatchEntries();
  $('catchForm').addEventListener('submit',event=>{
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    const center=map.getCenter();
    const rawTime=String(form.get('time')||'');
    const parsedTime=new Date(rawTime);
    if(!rawTime||Number.isNaN(parsedTime.getTime())) { $('catchStatus').textContent='Velg gyldig dato og tidspunkt.'; return; }
    const entry={
      id:globalThis.crypto?.randomUUID?.()||`catch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt:new Date().toISOString(),result:String(form.get('result')||'ingen-fangst'),time:parsedTime.toISOString(),fish:String(form.get('fish')||$('fishType').value),
      place:String(form.get('place')||'').trim()||`Kartposisjon ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`,
      length:String(form.get('length')||'').trim(),weight:String(form.get('weight')||'').trim(),lure:String(form.get('lure')||'').trim().slice(0,120),note:String(form.get('note')||'').trim().slice(0,500),
      mapCenter:{lat:Number(center.lat.toFixed(5)),lon:Number(center.lng.toFixed(5))},weather:latestWeather?{wind:latestWeather.wind,cloud:latestWeather.cloud,precipitation:latestWeather.precipitation,temp:latestWeather.temp,tempTrend:latestWeather.tempTrend,pressure:latestWeather.pressure,pressureTrend:latestWeather.pressureTrend,seaTemp:latestMarine?.seaTemp??null,waveHeight:latestMarine?.waveHeight??null,currentVelocity:latestMarine?.currentVelocity??null,tideState:latestMarine?.tideState??null,tideTrend3h:latestMarine?.tideTrend3h??null,moonPhase:latestMoon?.label??null,observedAt:latestWeather.observedAt}:null
    };
    const entries=[entry,...readCatchEntries()];
    if(!writeCatchEntries(entries)) return;
    event.currentTarget.reset(); setCatchDefaults(); renderCatchEntries(entries);
    $('catchStatus').textContent='Loggpost lagret lokalt på denne enheten.';
  });
  $('catchEntries').addEventListener('click',event=>{
    const button=event.target.closest?.('[data-delete-catch]'); if(!button) return;
    if(!confirm('Slette denne loggposten?')) return;
    const entries=readCatchEntries().filter(entry=>entry.id!==button.dataset.deleteCatch);
    if(writeCatchEntries(entries)){renderCatchEntries(entries);$('catchStatus').textContent='Loggpost slettet.';}
  });
}
function breakdownHtml(breakdown={}) {
  return Object.entries(breakdown).map(([key,value]) => `<span class="factor">${labels[key] || key}: <b>${Number(value)>0?'+':''}${value}</b></span>`).join('');
}
function strongestFactorsHtml(breakdown={}) {
  return Object.entries(breakdown).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,3).map(([key,value])=>`<span>${labels[key]||key} <b>${Number(value)>0?'+':''}${value}</b></span>`).join('');
}
function dataQualityHtml(quality={}) {
  const level=quality.level || 'Begrenset';
  const weather=quality.weather || {}, depth=quality.depth || {}, coast=quality.coast || {};
  const inlandDepth=String(depth.source || '').toLowerCase().includes('innland');
  const depthText=depth.available ? `${depth.source || 'EMODnet'} · estimert · ca. ${depth.resolutionM || 125} m oppløsning` : inlandDepth ? 'Innlandsdybde er ikke tilgjengelig – vurder lokalt dybdekart og synlige grunner' : 'Dybde mangler – slukvalget er et konservativt startvalg';
  return `<div class="data-quality" data-level="${level.toLowerCase()}"><div><span>Datagrunnlag</span><b>${level}</b></div><small>${quality.summary || 'Kildestatus ukjent'}</small><details><summary>Kilder og usikkerhet</summary><ul><li><b>${weather.kind || 'Værmodell'}:</b> ${weather.source || 'MET Norway'} · ${formatSourceTime(weather.updatedAt)}</li><li><b>${coast.kind || 'Beregnet analyse'}:</b> ${coast.source || 'OSM-vannmaske og kystgeometri'}</li><li><b>Dybde:</b> ${depthText}</li></ul></details></div>`;
}
function renderSources(weather,stats={}) {
  const modelTime=formatSourceTime(weather?.observedAt);
  const analysisTime=formatSourceTime(stats.generatedAt);
  const freshwater=stats.waterType === 'freshwater';
  $('analysisSources').innerHTML=`<b>Værmodell:</b> ${weather?.source || 'MET Norway'} · ${modelTime}<br><b>Analyse:</b> ${analysisTime} · ${freshwater ? 'OSM-vannmaske · valgfritt NVE-dybdekart der NVE har publisert kurver/punkter; ingen innlandsdybde antas' : 'OSM-kystgeometri · EMODnet-dybde · Open-Meteo Marine der tilgjengelig'}`;
}

function applyMapStyle() {
  const style=$('mapStyle').value;
  const freshwater=$('fishType').value==='all'||freshwaterFishTypes.has($('fishType').value);
  for(const layer of [standardLayer,satelliteLayer,hybridLabelsLayer,seaChartLayer,detailedDepthLayer]) if(map.hasLayer(layer)) map.removeLayer(layer);
  if(style==='fishing'&&!freshwater){ standardLayer.addTo(map); detailedDepthLayer.addTo(map); }
  else if(style==='chart'&&!freshwater){ standardLayer.addTo(map); seaChartLayer.addTo(map); }
  else if(style==='satellite'||style==='hybrid') satelliteLayer.addTo(map); else standardLayer.addTo(map);
  if(style==='hybrid') hybridLabelsLayer.addTo(map);
  saveUiState();
}

function updateMapLegend(){
  const legend=$('mapLegend');
  if(!legend) return;
  if($('fishType').value==='all'){
    legend.innerHTML='<span><i class="species-orret"></i> ørret</span><span><i class="species-abbor"></i> abbor</span>';
  }else{
    legend.innerHTML='<span><i class="best"></i> svært høy</span><span><i class="high"></i> høy</span><span><i class="moderate"></i> moderat</span>';
  }
}

function updateWaterModeUI() {
  const fishType=$('fishType').value;
  const hasSelection=Object.hasOwn(fishLabels,fishType);
  const allMode=fishType==='all';
  const freshwater=allMode||freshwaterFishTypes.has(fishType);
  if(!['standard','satellite','hybrid'].includes($('mapStyle').value)) $('mapStyle').value='standard';
  $('multiSpeciesCard').hidden=!allMode;
  $('insightsCard').hidden=allMode;
  $('fishGoal').disabled=allMode;
  if(allMode) $('fishGoal').value='numbers';
  if(freshwater&&['fishing','chart'].includes($('mapStyle').value)) $('mapStyle').value='standard';
  $('nveDepthToggle').hidden=!freshwater;
  $('conditionToggle').hidden=true;
  $('marineCard').hidden=true;
  $('hydrologyCard').hidden=!freshwater;
  if(!freshwater&&map.hasLayer(nveDepthLayer)) map.removeLayer(nveDepthLayer);
  if(!freshwater){$('nveDepthToggle').setAttribute('aria-pressed','false');$('nveDepthToggle').classList.remove('depth-active');}
  if(freshwater){showConditionVectors=false;$('conditionToggle').setAttribute('aria-pressed','false');$('conditionToggle').classList.remove('layer-active');conditionLayer.clearLayers();}
  $('sourceSpotToggle').hidden=true;
  $('restrictionToggle').hidden=true;
  $('analysisMode').textContent=!hasSelection?'Velg fisketype for analyse':allMode?'Ferskvann · Ørret + abbor · MET Norway · OSM':'Ferskvann · MET Norway · OSM';
  $('mask').textContent=!hasSelection?'Velg fisketype for å starte analysen.':'Kontrollerer faktisk innsjø/elv og vannkant …';
  updateMapLegend();
  applyMapStyle();
  renderReferenceLayers();
  return freshwater;
}

function sourceSpotPopup(spot,source={}) {
  const restricted=spot.status==='restricted';
  return `<article class="source-map-popup ${restricted?'restricted':''}"><span>${restricted?'Historisk omtale – ikke anbefaling':'Historisk omtalt sjøørretområde'}</span><h3>${escapeHtml(spot.name)}</h3>${restricted?`<p class="legal-warning"><b>Alt fiske forbudt hele året</b><br>${escapeHtml(spot.legalNote||spot.safety)}</p>`:''}<p>${escapeHtml(spot.summary)}</p><p><b>Kjennetegn:</b> ${escapeHtml((spot.features||[]).join(' · '))}</p><p><b>Sikkerhet/adkomst:</b> ${escapeHtml(spot.safety)}</p>${!restricted&&spot.legalNote?`<p class="legal-caution"><b>Nær fredningssone:</b> ${escapeHtml(spot.legalNote)}</p>`:''}<small>Gul/rød sirkel er en omtrentlig områdeindikator, ikke en eiendoms-, frednings- eller fangstgrense. ${escapeHtml(spot.disclaimer)}</small><div class="map-popup-sources"><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">Rosareke – erfaringskilde</a><a href="${escapeHtml(spot.coordinateSourceUrl)}" target="_blank" rel="noopener noreferrer">Kartverket – stedsnavn/koordinat</a></div></article>`;
}

function restrictionPopup(zone,regulation={}) {
  return `<article class="source-map-popup restricted"><span>Gjeldende fredningsgrense</span><h3>${escapeHtml(zone.name)}</h3><p class="legal-warning"><b>Alt fiske forbudt hele året</b><br>${escapeHtml(zone.legalText)}</p><p><b>Rød linje:</b> koordinatfestet yttergrense · ${escapeHtml(zone.sourceRef)} · oppgitt lengde ${escapeHtml(zone.lengthM)} m.</p><small>Linjen er yttergrensen, ikke hele flaten. Ved tvil gjelder ajourført Lovdata og offisielt kartvedlegg.</small><div class="map-popup-sources"><a href="${escapeHtml(regulation.url)}" target="_blank" rel="noopener noreferrer">Lovdata ${escapeHtml(regulation.id||'')}</a></div></article>`;
}

function renderReferenceLayers() {
  sourceSpotLayer.clearLayers();
  restrictionLayer.clearLayers();
  const fishType=$('fishType').value;
  if(showSourceSpots&&fishType==='sjoorret'&&sourceSpotData) {
    for(const spot of sourceSpotData.spots) {
      const restricted=spot.status==='restricted';
      L.circle([spot.lat,spot.lon],{radius:spot.radiusM,color:restricted?'#ff5d55':'#f2c94c',weight:restricted?3:2,dashArray:restricted?'7 5':'5 5',fillColor:restricted?'#ff5d55':'#f2c94c',fillOpacity:restricted?.12:.08})
        .bindTooltip(spot.name,{sticky:true,className:restricted?'restricted-source-tip':'source-spot-tip'})
        .bindPopup(sourceSpotPopup(spot,sourceSpotData.source),{maxWidth:360,className:'source-leaflet-popup'}).addTo(sourceSpotLayer);
    }
  }
  if(showRestrictions&&!freshwaterFishTypes.has(fishType)&&restrictionData) {
    for(const zone of restrictionData.zones.filter(item=>item.renderBoundary)) {
      L.polyline(zone.outerBoundary.map(point=>[point.lat,point.lon]),{color:'#ff3b30',weight:6,opacity:.95,dashArray:'12 7',lineCap:'round'})
        .bindTooltip(`Helårsforbud · ${zone.name}`,{sticky:true,className:'restriction-tip'})
        .bindPopup(restrictionPopup(zone,restrictionData.regulation),{maxWidth:360,className:'source-leaflet-popup'}).addTo(restrictionLayer);
    }
  }
}

async function loadReferenceLayers(){ sourceSpotData=null; restrictionData=null; sourceSpotLayer.clearLayers(); restrictionLayer.clearLayers(); }
function alternativeLuresHtml(alternatives=[]){
  if(!Array.isArray(alternatives)||!alternatives.length) return '';
  return `<div class="lure-alternatives"><div class="alt-head"><b>BYTT TIL DISSE HVIS DET ER DØDT</b><span>${alternatives.length} reelle alternativer fra din slukboks</span></div><div class="alt-lure-grid">${alternatives.map((alt,index)=>`<article class="alt-lure"><span class="alt-rank">${index+2}</span><img class="zoomable-lure" src="${escapeHtml(alt.image||'')}" alt="${escapeHtml(alt.name||'Alternativ sluk')}" loading="lazy" tabindex="0" role="button"><div><b>${escapeHtml(alt.name||alt.type||'Alternativ')}</b><small>${escapeHtml(alt.color||'')} · match ${Number.isFinite(alt.matchScore)?alt.matchScore:'–'}/100</small></div></article>`).join('')}</div></div>`;
}
function popupAlternativeLuresHtml(alternatives=[]){
  if(!Array.isArray(alternatives)||!alternatives.length) return '';
  return `<div class="popup-alternatives"><b>Alternativer:</b>${alternatives.slice(0,3).map(alt=>`<span>${escapeHtml(alt.name||alt.type||'Sluk')} · ${escapeHtml(alt.color||'')}</span>`).join('')}</div>`;
}
function genericCombinationsHtml(){ return ''; }
function sourceBackedLureHtml(){ return ''; }
function presentationTacticsHtml(lure={}) {
  const presentation=lure.presentation||{};
  const fly=lure.dropperFly||{};
  if(!presentation.band&&!fly.pattern) return '';
  return `<div class="presentation-tactics"><article><span>Slukhøyde i vannet</span><b>${presentation.band||'Søk trinnvis i vannsøylen'}</b><small>${presentation.method||''}<br><em>${presentation.basis||''}</em></small></article><article class="dropper-fly" data-recommended="${fly.recommended?'yes':'no'}"><span>Opphengerflue · ${fly.recommended?'Ja':'Nei'}</span>${fly.image?`<img class="dropper-fly-image zoomable-lure" src="${fly.image}" alt="Illustrasjon av ${fly.pattern} – ${fly.color}" loading="lazy" tabindex="0" role="button">`:''}<b>${fly.pattern||'Ikke anbefalt'}${fly.color&&fly.color!=='Ikke aktuelt'?` · ${fly.color}`:''}</b><small>${fly.distance||''}<br>${fly.reason||''}<br><em>${fly.rulesNote||''}</em></small></article></div>`;
}
function waterEnvironmentHtml(environment={}) {
  if(!environment.label) return '';
  return `<div class="water-environment"><b>${escapeHtml(environment.label)} · ${escapeHtml(environment.classification||'')}</b><span>${escapeHtml(environment.basis||'')}</span><small>${escapeHtml(environment.caveat||'')}</small></div>`;
}
function lureHtml(lure={}) {
  const depth = lure.depth || {};
  return `<div class="lure-cell"><div class="lure-main"><img class="lure-photo zoomable-lure" src="${escapeHtml(lure.image || '')}" alt="${escapeHtml(lure.name || 'Anbefalt sluk fra din samling')}" loading="lazy" tabindex="0" role="button"><div><span class="lure-label">BEST NÅ · KUN FRA DIN EGEN SLUKBOKS</span><b>${escapeHtml(lure.name || lure.type || 'Valgt sluk')}</b><span class="lure-color">◉ ${escapeHtml(lure.color || '')}</span><span class="depth-note">${escapeHtml(lure.type||'')} · ${escapeHtml(lure.weight||'')}</span><span class="depth-note">Dybde: ${escapeHtml(depth.label || 'ukjent')}</span></div></div><small>${escapeHtml(lure.reason || 'Tilpass innsveivingen etter forholdene.')}</small>${alternativeLuresHtml(lure.alternatives)}${waterEnvironmentHtml(lure.waterEnvironment)}${presentationTacticsHtml(lure)}</div>`;
}
function compactPopupHtml(zone,index) {
  const lure=zone.lure || {};
  const presentation=lure.presentation||{};
  const fly=lure.dropperFly||{};
  return `<div class="compact-popup"><div class="compact-popup-head"><span>${$('fishType').value==='all'?escapeHtml(zone.fishLabel||'Ferskvannsart')+' · ':''}${escapeHtml(zone.waterName||`Sone ${index+1}`)}</span><b>${zone.name}${zone.flyOnly?' · KUN FLUE':''}</b></div><div class="popup-score"><span>Fiskeforhold</span><b>${zone.score}/100</b><small>Veiledende rangering – ikke fangstsannsynlighet</small></div><div class="popup-factors">${strongestFactorsHtml(zone.breakdown)}</div><div class="popup-quality"><span>Datagrunnlag</span><b>${zone.dataQuality?.level || 'Begrenset'}</b><small>${zone.dataQuality?.summary || 'Kildestatus ukjent'}</small></div><div class="popup-primary"><img class="popup-lure-thumb zoomable-lure" src="${lure.image || '/lures/spoon-blue-silver.jpg'}" alt="${lure.name || 'Anbefalt sluk'} – ${lure.color || 'Sølv/blå'}" tabindex="0" role="button"><div><span>Ditt bildevalg · ${escapeHtml(lure.waterEnvironment?.label||'riktig vannmiljø')}</span><b>${lure.name ? `${lure.name} · ` : ''}${lure.type || 'Smal kystsluk'} · ${lure.weight || '18–22 g'}</b><small>${lure.color || 'Sølv/blå'}${lure.inventoryNote?`<br>På bildet: ${escapeHtml(lure.inventoryNote)}`:''}</small></div></div>${popupAlternativeLuresHtml(lure.alternatives)}<div class="popup-tactics"><b>Slukhøyde:</b> ${presentation.band||'Søk trinnvis'}<br><b>Opphengerflue:</b> ${fly.recommended?'Ja':'Nei'}${fly.recommended&&fly.color?` · ${fly.color}`:''}</div><button type="button" class="popup-details" data-zone="${zone.id}">Vis alle detaljer i listen</button></div>`;
}
function lureText(zone={}) { const lure=zone.lure||{}; return [lure.name,lure.type,lure.color,lure.weight].filter(Boolean).join(' '); }
function tokenOverlap(a,b) {
  const tokens=value=>new Set(String(value||'').toLocaleLowerCase('no-NO').replace(/[^a-z0-9æøå]+/gi,' ').split(/\s+/).filter(word=>word.length>=3));
  const left=tokens(a),right=tokens(b);let count=0;for(const token of left)if(right.has(token))count++;return count;
}
function applyPersonalRanking(zones=[]) {
  const api=globalThis.FishingInsights;
  const fish=$('fishType').value;
  if(!api||fish==='all') return zones;
  const insight=api.buildCatchInsights(readCatchEntries(),fish);
  return zones.map(zone=>{
    const modelScore=Number(zone.score)||0;
    if(insight.sessions<3) return {...zone,modelScore,personalAdjustment:0};
    let adjustment=0;
    const band=api.timeBand(new Date());
    if(insight.bestTime?.id===band.id) adjustment+=2;
    const overlap=insight.topLure?tokenOverlap(insight.topLure.label,lureText(zone)):0;
    if(overlap) adjustment+=Math.min(3,overlap);
    let weatherFit=0;
    if(Number.isFinite(insight.caughtWeather?.wind)&&Number.isFinite(latestWeather?.wind)&&Math.abs(insight.caughtWeather.wind-latestWeather.wind)<=2) weatherFit++;
    if(Number.isFinite(insight.caughtWeather?.cloud)&&Number.isFinite(latestWeather?.cloud)&&Math.abs(insight.caughtWeather.cloud-latestWeather.cloud)<=20) weatherFit++;
    if(Number.isFinite(insight.caughtWeather?.temp)&&Number.isFinite(latestWeather?.temp)&&Math.abs(insight.caughtWeather.temp-latestWeather.temp)<=3) weatherFit++;
    adjustment+=Math.min(2,weatherFit);
    adjustment=Math.min(6,adjustment);
    return {...zone,modelScore,personalAdjustment:adjustment,score:Math.min(100,modelScore+adjustment),breakdown:adjustment?{...zone.breakdown,personlig:adjustment}:zone.breakdown};
  }).sort((a,b)=>b.score-a.score||b.modelScore-a.modelScore);
}
function downloadTextFile(name,text,type) {
  const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportCatchGpx() {
  const entries=readCatchEntries().filter(entry=>Number.isFinite(entry.mapCenter?.lat)&&Number.isFinite(entry.mapCenter?.lon));
  if(!entries.length){$('catchStatus').textContent='Ingen loggposter med kartposisjon å eksportere.';return;}
  const xmlEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const waypoints=entries.map(entry=>`<wpt lat="${entry.mapCenter.lat}" lon="${entry.mapCenter.lon}"><time>${xmlEscape(entry.time)}</time><name>${xmlEscape(entry.place||fishLabels[entry.fish]||'Fisketur')}</name><desc>${xmlEscape(`${entry.result==='fangst'?'Fangst':'Ingen fangst'} · ${fishLabels[entry.fish]||entry.fish}${entry.lure?' · '+entry.lure:''}`)}</desc><type>${entry.result==='fangst'?'catch':'session'}</type></wpt>`).join('');
  downloadTextFile(`vestfjella-fiske-fangster-${new Date().toISOString().slice(0,10)}.gpx`,`<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Vestfjella Fiske STABLE 1.2" xmlns="http://www.topografix.com/GPX/1/1">${waypoints}</gpx>`,'application/gpx+xml');
  $('catchStatus').textContent=`Eksporterte ${entries.length} posisjoner som GPX.`;
}
function exportCatchJson() { const entries=readCatchEntries();downloadTextFile(`vestfjella-fiske-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify({version:1,exportedAt:new Date().toISOString(),entries},null,2),'application/json');$('catchStatus').textContent=`Backup med ${entries.length} loggposter er eksportert.`; }
function cacheAnalysis(data) { try{const c=map.getCenter();localStorage.setItem(analysisCacheKey,JSON.stringify({savedAt:new Date().toISOString(),fish:$('fishType').value,center:{lat:c.lat,lon:c.lng},data}));}catch{} }
function distanceKm(a,b){if(!a||!b)return Infinity;const R=6371,toRad=Math.PI/180,dLat=(b.lat-a.lat)*toRad,dLon=(b.lon-a.lon)*toRad,h=Math.sin(dLat/2)**2+Math.cos(a.lat*toRad)*Math.cos(b.lat*toRad)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
function readCachedAnalysis() { try{const cached=JSON.parse(localStorage.getItem(analysisCacheKey)||'null');if(!cached?.data||cached.fish!==$('fishType').value)return null;if(distanceKm(cached.center,map.getCenter())>35)return null;return cached;}catch{return null;} }
function applyAnalysisData(data,{cached=false}={}) {
  latestWeather=data.weather||null;latestMarine=data.marine||null;latestMoon=data.moon||null;
  renderWeather(latestWeather);renderMarine(latestMarine,latestMoon);renderSources(latestWeather,data.stats||{});renderBestTimes(data.bestTimes||{});renderZones(data.zones||[]);renderConditionVectors();
  $('mask').textContent=data.stats?.waterMaskAvailable===false?'Vannmasken er midlertidig utilgjengelig.':`Aktiv · ${data.stats?.tested??0} kandidater kontrollert · ${data.stats?.rejected??0} forkastet`;
  const warning=(data.warnings||[]).join(' ');$('warnings').textContent=cached?`OFFLINE: viser siste lagrede analyse fra ${formatSourceTime(data.stats?.generatedAt)}. ${warning}`.trim():warning;
}
function selectZone(zoneId,{scroll=false}={}) {
  document.querySelectorAll('.zone-row').forEach(row=>row.classList.toggle('selected',row.dataset.zone===zoneId));
  zoneLayer.eachLayer(layer=>{
    if (!layer._zoneId || typeof layer.setStyle!=='function') return;
    layer.setStyle({weight:layer._zoneId===zoneId?4:2,fillOpacity:(layer._zoneId===zoneId ? .48 : .34)});
  });
  const row=document.querySelector(`[data-zone="${zoneId}"]`);
  const selected=latestZones.find(zone=>zone.id===zoneId);
  if(row&&!$('catchPlace').value) $('catchPlace').value=selected?.waterName||row.querySelector('.zone-title b')?.textContent||'';
  if(selected&&!$('catchLure').value) $('catchLure').value=lureText(selected);
  if(selected?.fishType&&$('fishType').value==='all') $('catchFish').value=selected.fishType;
  if (scroll) row?.scrollIntoView({behavior:'smooth',block:'center'});
}
function renderZones(zones) {
  zones=applyPersonalRanking(zones);
  latestZones=zones;
  renderWaterDirectory();
  zoneLayer.clearLayers();
  renderBestNow(zones);
  drawNavigation(zones);
  if (!zones.length) {
    const radius=Number($('baseRadius').value)||0;
    const filtered=Boolean(basePoint&&radius);
    $('zones').innerHTML=filtered
      ?`<div class="empty"><b>Ingen anbefalt sone innen ${escapeHtml(formatDistance(radius))} fra basen</b><span>Den grønne sirkelen viser området som faktisk søkes. Trykk «Base satt · fjern» for å fjerne basen, eller sett en ny base nærmere sjøen.</span></div>`
      :'<div class="empty"><b>Ingen sikre soner i utsnittet</b><span>Zoom nærmere kysten eller flytt kartet litt.</span></div>';
    return;
  }
  const allMode=$('fishType').value==='all';
  $('zones').innerHTML = zones.map((zone,index) => {
    const zoneFish=zone.fishType||$('fishType').value;
    const fishBadge=allMode?`<span class="species-badge species-badge-${zoneFish}">${escapeHtml(zone.fishLabel||fishLabels[zoneFish]||zoneFish)}</span>`:'';
    return `<article class="zone-row" tabindex="0" data-zone="${zone.id}" data-fish="${zoneFish}"><div class="zone-rank">${index+1}</div><div class="zone-copy"><div class="zone-title"><b>${escapeHtml(zone.waterName||`Sone ${index+1}`)} · ${zone.name}</b>${fishBadge}${zone.flyOnly?'<span class="fly-only-badge">KUN FLUE</span>':''}${zone.personalAdjustment?`<span class="personal-boost">Mine data +${zone.personalAdjustment}</span>`:''}</div><p>${zone.reason}</p><div class="score-explanation"><span>Fiskeforhold ${zone.score}/100</span><div>${breakdownHtml(zone.breakdown)}</div></div>${dataQualityHtml(zone.dataQuality)}</div>${lureHtml(zone.lure)}<div class="score" data-score="${zone.score}" aria-label="Fiskeforhold ${zone.score} av 100, ikke fangstsannsynlighet" style="--score:${zone.score};--score-color:${allMode?(speciesColors[zoneFish]||scoreColor(zone.score)):scoreColor(zone.score)}"></div></article>`;
  }).join('');
  zones.forEach((zone,index) => {
    const zoneFish=zone.fishType||$('fishType').value;
    const mapColor=$('fishType').value==='all'?(speciesColors[zoneFish]||scoreColor(zone.score)):scoreColor(zone.score);
    const marker=L.circleMarker([zone.marker.lat,zone.marker.lon],{radius:$('fishType').value==='all'?7:5,color:'#10251f',weight:2,fillColor:mapColor,fillOpacity:1,opacity:1})
      .bindTooltip(String(index+1),{permanent:true,direction:'center',className:`zone-number ${$('fishType').value==='all'?`zone-number-${zoneFish}`:''}`});
    const layer=Array.isArray(zone.polygon)&&zone.polygon.length>=3
      ?L.polygon(zone.polygon,{color:mapColor,weight:2,fillColor:mapColor,fillOpacity:.34,opacity:.96}).bindPopup(compactPopupHtml(zone,index),{maxWidth:330,className:'compact-leaflet-popup'})
      :L.circleMarker([zone.marker.lat,zone.marker.lon],{radius:15,color:mapColor,weight:2,fillColor:mapColor,fillOpacity:.16,opacity:.96}).bindPopup(compactPopupHtml(zone,index),{maxWidth:330,className:'compact-leaflet-popup'});
    layer._zoneId=zone.id;
    marker._zoneId=zone.id;
    layer.on('click',()=>selectZone(zone.id,{scroll:true}));
    marker.on('click',()=>{selectZone(zone.id,{scroll:true});layer.openPopup();});
    layer.addTo(zoneLayer);
    marker.addTo(zoneLayer);
    const row = document.querySelector(`[data-zone="${zone.id}"]`);
    const open=()=>{ selectZone(zone.id); map.fitBounds(layer.getBounds(), { maxZoom:16, padding:[30,30] }); layer.openPopup(); };
    row?.addEventListener('click', open);
    row?.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();open();}});
  });
}
async function loadZones({ immediate=false }={}) {
  if(!Object.hasOwn(fishLabels,$('fishType').value)) {
    clearTimeout(timer); controller?.abort(); zoneLayer.clearLayers();
    $('zones').innerHTML='<div class="empty"><b>Velg fisketype</b><span>Velg art i nedtrekksmenyen for å starte kartanalysen.</span></div>';
    $('mask').textContent='Velg fisketype for å starte analysen.';
    setState('ready','Velg fisketype for å starte.');
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(async () => {
    controller?.abort(); controller = new AbortController();
    const bounds = map.getBounds();
    const bbox = [bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()].join(',');
    const allMode=$('fishType').value==='all';
    const freshwater=allMode||freshwaterFishTypes.has($('fishType').value);
    setState('loading',allMode?'Analyserer ørret og abbor samtidig i faktiske vannflater …':'Analyserer vannkant, vind og ferskvannsforhold …');
    $('zones').setAttribute('aria-busy','true');
    try {
      const searchParams = new URLSearchParams({ bbox, zoom:String(map.getZoom()) });
      searchParams.set('fish', $('fishType').value);
      searchParams.set('goal',$('fishGoal').value);
      const radius=Number($('baseRadius').value)||0;
      if(basePoint){searchParams.set('baseLat',String(basePoint.lat));searchParams.set('baseLon',String(basePoint.lon));if(radius)searchParams.set('radiusM',String(radius));}
      const response = await fetch(`/api/zones?${searchParams}`, { cache:'no-store', signal:controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `API-feil ${response.status}`);
      applyAnalysisData(data);cacheAnalysis(data);
      if(freshwater) loadHydrologyAtCenter(); else renderHydrology(null);
      setState('ready',`Oppdatert ${new Date().toLocaleTimeString('no-NO',{hour:'2-digit',minute:'2-digit'})} · ${(data.zones || []).length} soner`);
    } catch (error) {
      if (error.name === 'AbortError') return;
      const offline = !navigator.onLine;
      const cached=readCachedAnalysis();
      if(cached){applyAnalysisData(cached.data,{cached:true});setState('ready',`Offline · siste lagrede analyse ${formatSourceTime(cached.savedAt)}`);}
      else{setState('error',offline ? 'Du er offline og har ingen lagret analyse for dette området.' : `Kunne ikke oppdatere: ${error.message}`);$('zones').innerHTML = `<div class="empty error"><b>${offline ? 'Ingen nettforbindelse' : 'Analysen feilet'}</b><span>Prøv igjen. Kartet kan fortsatt brukes.</span></div>`;}
    } finally { $('zones').setAttribute('aria-busy','false'); }
  }, immediate ? 0 : 550);
}
// ResizeObserver/invalidateSize can emit moveend without user interaction.
// Listening to dragend instead prevents a render → resize → reload feedback loop.
map.on('dragend zoomend', () => {saveUiState();renderConditionVectors();if(showBoatRamps)loadBoatRamps();loadZones();});
$('locate').addEventListener('click', () => { setState('locating','Finner posisjonen din …'); map.locate({ setView:true, maxZoom:14, enableHighAccuracy:true }); });
$('retry').addEventListener('click', () => loadZones({immediate:true}));
$('fishType').addEventListener('change', () => { if($('fishType').value!=='all') $('catchFish').value=$('fishType').value; saveUiState(); renderFishingInsights(); updateWaterModeUI(); loadZones({immediate:true}); });
$('fishGoal').addEventListener('change',()=>{saveUiState();loadZones({immediate:true});});
$('baseRadius').addEventListener('change',()=>{saveUiState();updateBaseRadiusCircle();if(basePoint&&Number($('baseRadius').value)>0)focusBaseRadius();loadZones({immediate:true});});
$('setBase').addEventListener('click',()=>{if(basePoint)clearBasePoint();else setBasePoint(map.getCenter(),{label:'Valgt base'});});
$('mapStyle').addEventListener('change',()=>{applyMapStyle();saveUiState();});
$('sourceSpotToggle').addEventListener('click',()=>{showSourceSpots=!showSourceSpots;$('sourceSpotToggle').setAttribute('aria-pressed',String(showSourceSpots));$('sourceSpotToggle').classList.toggle('layer-active',showSourceSpots);$('sourceSpotToggle').textContent=showSourceSpots?'Kirkøy-steder':'Vis Kirkøy-steder';renderReferenceLayers();});
$('restrictionToggle').addEventListener('click',()=>{showRestrictions=!showRestrictions;$('restrictionToggle').setAttribute('aria-pressed',String(showRestrictions));$('restrictionToggle').classList.toggle('restriction-active',showRestrictions);$('restrictionToggle').textContent=showRestrictions?'Fredningsgrenser':'Vis fredningsgrenser';renderReferenceLayers();});
$('nveDepthToggle').addEventListener('click',()=>{const enable=!map.hasLayer(nveDepthLayer);if(enable)nveDepthLayer.addTo(map);else map.removeLayer(nveDepthLayer);$('nveDepthToggle').setAttribute('aria-pressed',String(enable));$('nveDepthToggle').classList.toggle('depth-active',enable);$('nveDepthToggle').textContent=enable?'Skjul NVE-dybde':'NVE dybdekart';});
$('conditionToggle').addEventListener('click',()=>{showConditionVectors=!showConditionVectors;$('conditionToggle').setAttribute('aria-pressed',String(showConditionVectors));$('conditionToggle').classList.toggle('layer-active',showConditionVectors);$('conditionToggle').textContent=showConditionVectors?'Skjul vind/strøm':'Vind/strøm';renderConditionVectors();});
$('boatRampToggle').addEventListener('click',()=>{showBoatRamps=!showBoatRamps;$('boatRampToggle').setAttribute('aria-pressed',String(showBoatRamps));$('boatRampToggle').classList.toggle('layer-active',showBoatRamps);$('boatRampToggle').textContent=showBoatRamps?'Skjul båtramper':'Båtramper';if(showBoatRamps)loadBoatRamps();else boatRampLayer.clearLayers();});
$('closeLureViewer').addEventListener('click', () => { lureViewer.close(); if(lureViewerHistoryActive){lureViewerHistoryActive=false;history.back();} });
lureViewer.addEventListener('click', event => { if (event.target === lureViewer){ lureViewer.close(); if(lureViewerHistoryActive){lureViewerHistoryActive=false;history.back();} } });
window.addEventListener('popstate',()=>{ if(lureViewer.open){lureViewerHistoryActive=false;lureViewer.close();} });
document.addEventListener('click', event => { const image=event.target.closest?.('.zoomable-lure'); if (!image) return; event.preventDefault(); event.stopPropagation(); openLureViewer(image.currentSrc || image.src, image.alt); }, true);
document.addEventListener('click', event => { const button=event.target.closest?.('[data-water-focus]'); if(!button) return; event.preventDefault(); selectedWaterDirectoryName=button.dataset.waterFocus; const item=waterDirectoryItems.find(w=>normalizeDirectoryName(w.name)===normalizeDirectoryName(selectedWaterDirectoryName)); if(item) renderWaterProfile(item); focusKnownWater(selectedWaterDirectoryName); });
document.addEventListener('click', event => { const button=event.target.closest?.('.popup-details'); if(!button) return; event.preventDefault(); const zoneId=button.dataset.zone; map.closePopup(); selectZone(zoneId,{scroll:true}); });
document.addEventListener('keydown', event => { const image=event.target.closest?.('.zoomable-lure'); if (image && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openLureViewer(image.currentSrc || image.src, image.alt); } });
map.on('locationfound', event => { if (locationMarker) locationMarker.remove(); locationMarker=L.circleMarker(event.latlng,{radius:7,color:'#fff',weight:2,fillColor:'#38d477',fillOpacity:1}).addTo(map).bindPopup('Din posisjon').openPopup(); setBasePoint(event.latlng,{label:'Base: din posisjon',focus:false}); $('setBase').textContent='✓ Base = GPS · fjern'; setState('ready','Posisjon funnet. Bruker den som base og oppdaterer soner …'); });
map.on('locationerror', () => setState('error','Kunne ikke hente posisjonen. Tillat posisjon eller flytt kartet manuelt.'));
window.addEventListener('online', () => loadZones({immediate:true}));
window.addEventListener('offline', () => {const cached=readCachedAnalysis();setState(cached?'ready':'error',cached?'Du er offline. Siste lagrede analyse er tilgjengelig.':'Du er offline. Kartskallet virker; lagret analyse vises når den finnes.');});
async function loadOwnedLureNames(){try{const response=await fetch('/data/user-lures.json',{cache:'force-cache'});const data=await response.json();$('ownedLures').innerHTML=(data.lures||[]).map(item=>`<option value="${escapeHtml(item.name||item.type||'')}"></option>`).join('');}catch{}}
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js?v=1.2', { updateViaCache: 'none' }).catch(() => {}));
loadOwnedLureNames();
if(savedUiState.fishType&&Object.hasOwn(fishLabels,savedUiState.fishType)) $('fishType').value=savedUiState.fishType;
if(['numbers','big'].includes(savedUiState.fishGoal)) $('fishGoal').value=savedUiState.fishGoal;
if(['0','250','500','1000','2000'].includes(String(savedUiState.baseRadius))) $('baseRadius').value=String(savedUiState.baseRadius);
if(['standard','satellite','hybrid'].includes(savedUiState.mapStyle)) $('mapStyle').value=savedUiState.mapStyle;
if(basePoint){baseMarker=L.marker([basePoint.lat,basePoint.lon]).addTo(map).bindPopup('<b>Lagret base</b>');$('setBase').textContent='✓ Base satt · fjern';$('setBase').classList.add('base-active');$('setBase').setAttribute('aria-pressed','true');updateBaseRadiusCircle();}
initCatchLog();
$('exportGpx')?.addEventListener('click',exportCatchGpx);
$('exportJson')?.addEventListener('click',exportCatchJson);
updateWaterModeUI();
loadWaterDirectory();
loadReferenceLayers();
loadZones({immediate:true});
function normalizeDirectoryName(value=''){
  return String(value||'').toLowerCase().replace(/æ/g,'ae').replace(/ø/g,'o').replace(/å/g,'a').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').replace(/tjernene\b/g,'tjern').replace(/tjernet\b/g,'tjern').replace(/vannet\b/g,'vann').replace(/vanna\b/g,'vann').replace(/vatnet\b/g,'vann').trim();
}

function confidenceLabel(value='limited'){
  return ({high:'Høy',medium_high:'God',medium:'Middels',limited:'Begrenset'})[value]||'Begrenset';
}
function speciesLabelFromItem(item){
  if(!Array.isArray(item?.species)||!item.species.length) return 'Ikke kildebekreftet per vann';
  return item.species.map(v=>v==='orret'?'Ørret':v==='abbor'?'Abbor':v).join(' + ');
}
function formatWaterArea(item,located){
  if(Number.isFinite(item?.areaKm2Official)) return `${item.areaKm2Official.toFixed(item.areaKm2Official<0.1?2:1)} km² (${Math.round(item.areaKm2Official*1000)} daa) · ${item.areaSource||'offisiell kilde'}`;
  if(Number.isFinite(located?.areaDaaApprox)) return `ca. ${located.areaDaaApprox} daa · kartberegnet fra OSM-vannpolygon`;
  return 'Ikke tilgjengelig i innlagte kilder';
}
function renderWaterKnowledgeSummary(){
  const holder=$('waterKnowledgeSummary');
  if(!holder||!waterDirectoryMeta) return;
  const culture=waterDirectoryMeta.areaWideCulture||{};
  const hidden=Array.isArray(waterDirectoryMeta.localHiddenGemWaters)?waterDirectoryMeta.localHiddenGemWaters:[];
  holder.innerHTML=`<div class="water-knowledge-grid"><article><span>Området</span><b>${Number(waterDirectoryMeta.officialTotalWaterCount)||96} vann</b><small>${Number(waterDirectoryMeta.officialTroutWaterCount)||45} med ørret ifølge Inatur</small></article><article><span>Kultivering</span><b>Kalking siden ${culture.limingSince||1990}</b><small>Årlig ørretutsetting i området · vannprøver ${escapeHtml(culture.waterSampling||'')}</small></article><article><span>Spesialregler</span><b>4 fluevann · 2 fiskebrygger</b><small>Regler lagres som harde felt når de er kildebekreftet</small></article></div>${hidden.length?`<p class="source-details"><b>Lokalt omtalte småvann:</b> ${hidden.map(escapeHtml).join(', ')}. FishKing omtaler disse som mulige «skattekister»; det er ikke en garanti for dagens bestand.</p>`:''}<div class="map-source-links"><a href="https://www.inatur.no/fiske/5105163ce4b02d9c4217516b" target="_blank" rel="noopener">Inatur / Vestfjella</a><a href="https://fishking.no/blogs/anbefalte-fiskeomrader/vestfjella-et-orreteldorado-i-ostfold" target="_blank" rel="noopener">FishKing Vestfjella</a><a href="https://finnfisk.no/fiske/aremark" target="_blank" rel="noopener">Finnfisk / NVE</a><a href="https://fishking.no/collections/kart/products/store-le-aremark-1-50-000" target="_blank" rel="noopener">Store Le 1:50 000</a></div>`;
}
function renderWaterProfile(item,located=null,error=null){
  const holder=$('waterProfile');
  if(!holder||!item) return;
  const fish=$('fishType')?.value||'orret';
  const selectedScore=directoryScoreFor(item).score;
  const species=speciesLabelFromItem(item);
  const sourceConfidence=confidenceLabel(item.sourceConfidence);
  const profileTags=[item.flyOnly?'KUN FLUE':null,item.accessiblePier?'♿ fiskebrygge':null,item.hiddenGem?'🎯 lokalt omtalt småvann':null].filter(Boolean);
  const mismatch=Array.isArray(item.species)&&item.species.length&&fish!=='all'&&!item.species.includes(fish);
  const cultivation=item.cultivationNote||(item.name==='Stubbetjern'?'Selvforsynt ørretbestand er omtalt; ingen utsetting antas i appen.':'Området kalkes og har årlig ørretutsetting, men status er ikke bekreftet for akkurat dette vannet.');
  const ruleText=item.flyOnly?'Kun fluefiske':`Generelle Vestfjella-regler · sesong ${waterDirectoryMeta?.rules?.season||'1. jan.–30. sep.'}`;
  holder.innerHTML=`<div class="water-profile-head"><div><span>Valgt vann</span><h3>${escapeHtml(item.name)}</h3></div><b>${Math.round(selectedScore)}/100</b></div>${profileTags.length?`<div class="water-profile-tags">${profileTags.map(t=>`<span>${escapeHtml(t)}</span>`).join('')}</div>`:''}<div class="water-profile-grid"><article><span>Bestand</span><b>${escapeHtml(species)}</b></article><article><span>Vannareal</span><b>${escapeHtml(formatWaterArea(item,located))}</b></article><article><span>Regler</span><b>${escapeHtml(ruleText)}</b></article><article><span>Kultivering</span><b>${escapeHtml(cultivation)}</b></article><article><span>Adkomst</span><b>${escapeHtml(item.access||'Ikke spesifisert')}${item.accessiblePier?' · fiskebrygge':''}</b></article><article><span>Kildegrad</span><b>${escapeHtml(sourceConfidence)}</b></article></div><p>${escapeHtml(item.populationNote||'')}</p>${item.sourceNote?`<p class="source-details"><b>Kildeinfo:</b> ${escapeHtml(item.sourceNote)}</p>`:''}${mismatch?`<p class="water-profile-warning">Valgt fisketype er ikke dokumentert i dette vannet i kildene som er lagt inn. Appen nedprioriterer derfor vannet for denne arten.</p>`:''}${error?`<p class="water-profile-warning">Kartplassering: ${escapeHtml(error)}</p>`:''}${located?.matchedAlias?`<p class="source-details">Kartnavn: ${escapeHtml(located.name)} · matchet via ${escapeHtml(located.matchedAlias)}</p>`:''}`;
}
function baselineDirectoryScore(item){
  const fish=$('fishType')?.value||'orret',goal=$('fishGoal')?.value||'numbers';
  let trout=Math.max(20,Math.min(99,Number(goal==='big'?item.big:item.base)||70)+(Number(item.troutBias)||0));
  let perch=Math.max(20,Math.min(96,63+(Number(item.perchBias)||0)+((Number(item.accessScore)||3)-3)*2+(item.waterBody==='open_lake'?2:0)-(item.flyOnly?5:0)));
  const species=Array.isArray(item.species)?item.species:[];
  if(species.length){
    trout += species.includes('orret')?4:-24;
    perch += species.includes('abbor')?4:-24;
  }
  if(goal==='big'){
    const trophy=item.trophyPotential==='very_high'?8:item.trophyPotential==='high'?5:item.trophyPotential==='medium_high'?3:0;
    if(species.includes('orret')||!species.length) trout+=trophy;
    if(species.includes('abbor')) perch+=trophy;
    if(item.hiddenGem&&species.includes('orret')) trout+=2;
  }else if(item.abundance==='high'){
    if(species.includes('orret')||!species.length) trout+=4;
    if(species.includes('abbor')) perch+=4;
  }
  trout=Math.max(15,Math.min(99,trout)); perch=Math.max(15,Math.min(99,perch));
  if(fish==='abbor') return perch;
  if(fish==='all') return Math.max(trout,perch);
  return trout;
}
function directoryScoreFor(item){
  const key=normalizeDirectoryName(item.name);
  const matches=latestZones.filter(zone=>{
    const z=normalizeDirectoryName(zone.waterName||'');
    return z&&(z===key||z.includes(key)||key.includes(z));
  });
  if(matches.length) return {score:Math.max(...matches.map(zone=>Number(zone.score)||0)),live:true};
  return {score:baselineDirectoryScore(item),live:false};
}
function renderWaterDirectory(){
  const container=$('waterDirectory'),badge=$('waterDirectoryCount');
  if(!container||!badge||!waterDirectoryItems.length) return;
  const ranked=waterDirectoryItems.map(item=>{const scored=directoryScoreFor(item);return {...item,currentScore:scored.score,scoreLive:scored.live};}).sort((a,b)=>b.currentScore-a.currentScore||String(a.name).localeCompare(String(b.name),'no'));
  const liveCount=ranked.filter(item=>item.scoreLive).length;
  const officialTotal=Number(waterDirectoryMeta?.officialTotalWaterCount)||ranked.length;
  badge.textContent=`${ranked.length} i register · ${officialTotal} totalt · beste først`;
  container.innerHTML=ranked.map((item,index)=>`<button type="button" class="water-directory-row${selectedWaterDirectoryName===item.name?' selected':''}" data-water-focus="${escapeHtml(item.name)}" title="Vis ${escapeHtml(item.name)} på kartet"><span class="water-directory-rank">${index+1}</span><span class="water-directory-name"><b>${escapeHtml(item.name)}</b>${item.flyOnly?'<small>KUN FLUE</small>':''}${item.accessiblePier?'<small>♿ fiskebrygge</small>':''}${item.hiddenGem?'<small>🎯 SMÅVANN</small>':''}${Array.isArray(item.species)&&item.species.length?`<small>${escapeHtml(speciesLabelFromItem(item))}</small>`:''}<small>${item.scoreLive?'LIVE I KARTUTSNITT':'KILDEJUSTERT GRUNNRANGERING'}</small></span><span class="water-directory-score has-score">${Math.round(item.currentScore)}/100</span></button>`).join('');
}
async function focusKnownWater(name){
  const item=waterDirectoryItems.find(w=>normalizeDirectoryName(w.name)===normalizeDirectoryName(name));
  if(item) renderWaterProfile(item);
  const key=normalizeDirectoryName(name);
  const zone=latestZones.find(item=>{const z=normalizeDirectoryName(item.waterName||'');return z&&(z===key||z.includes(key)||key.includes(z));});
  if(zone){
    map.flyTo([zone.marker.lat,zone.marker.lon],15,{duration:.7});
    selectZone(zone.id);
    waterFocusLayer.clearLayers();
    L.circleMarker([zone.marker.lat,zone.marker.lon],{radius:18,color:'#38d477',weight:3,fillColor:'#38d477',fillOpacity:.08}).bindTooltip(name,{permanent:false}).addTo(waterFocusLayer);
    return;
  }
  setState('loading',`Finner ${name} på kartet …`);
  try{
    const response=await fetch(`/api/water-locate?name=${encodeURIComponent(name)}`,{cache:'no-store'});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'Fant ikke vannet');
    waterFocusLayer.clearLayers();
    if(data.bounds&&[data.bounds.south,data.bounds.west,data.bounds.north,data.bounds.east].every(Number.isFinite)){
      const bounds=L.latLngBounds([data.bounds.south,data.bounds.west],[data.bounds.north,data.bounds.east]);
      map.fitBounds(bounds.pad(.45),{padding:[35,35],maxZoom:16});
    } else map.flyTo([data.lat,data.lon],15,{duration:.7});
    L.circleMarker([data.lat,data.lon],{radius:16,color:'#38d477',weight:3,fillColor:'#38d477',fillOpacity:.1}).bindTooltip(data.name||name,{permanent:false}).addTo(waterFocusLayer);
    if(item) renderWaterProfile(item,data);
    renderWaterDirectory();
    setState('ready',`${data.name||name} vises på kartet. Oppdaterer anbefalte soner …`);
    setTimeout(()=>loadZones({immediate:true}),150);
  }catch(error){ if(item) renderWaterProfile(item,null,error.message); setState('error',`${name}: ${error.message}`);}
}
async function loadWaterDirectory(){
  const container=$('waterDirectory'),badge=$('waterDirectoryCount');
  if(!container||!badge) return;
  try{
    const response=await fetch('/api/water-directory',{cache:'no-store'});
    if(!response.ok) throw new Error('Vannregister utilgjengelig');
    const data=await response.json();
    waterDirectoryMeta=data||{};
    waterDirectoryItems=Array.isArray(data.waters)?data.waters:[];
    renderWaterKnowledgeSummary();
    renderWaterDirectory();
  }catch(error){ badge.textContent='Register'; container.innerHTML='<p class="muted">Kunne ikke laste vannregisteret akkurat nå.</p>'; }
}


