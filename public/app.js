const uiStateKey='vestfjella-fiste2-ui-state-v17';
function readUiState(){try{return JSON.parse(localStorage.getItem(uiStateKey)||'{}')||{};}catch{return {};}}
function saveUiState(){try{const c=map.getCenter();localStorage.setItem(uiStateKey,JSON.stringify({fishType:$('fishType')?.value||'',fishGoal:$('fishGoal')?.value||'numbers',accessFilter:$('accessFilter')?.value||'all',baseRadius:$('baseRadius')?.value||'500',mapStyle:$('mapStyle')?.value||'fishing',center:[c.lat,c.lng],zoom:map.getZoom(),basePoint}));}catch{}}
const savedUiState=readUiState();
const initialCenter=Array.isArray(savedUiState.center)&&savedUiState.center.length===2?savedUiState.center:[59.2700,11.5890];
const initialZoom=Number.isFinite(savedUiState.zoom)?savedUiState.zoom:13;
const map = L.map('map', { zoomControl: true }).setView(initialCenter, initialZoom);
const standardLayer=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const topoLayer=L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png',{maxZoom:19,updateWhenIdle:true,keepBuffer:1,attribution:'© Kartverket (CC BY 4.0)'});
const satelliteLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Tiles © Esri'});
const seaChartLayer=L.tileLayer.wms('https://wms.geonorge.no/skwms1/wms.sjokartraster2',{layers:'all',styles:'',format:'image/png',transparent:false,version:'1.3.0',tileSize:512,updateWhenIdle:true,updateWhenZooming:false,keepBuffer:1,maxZoom:18,attribution:'© Kartverket · sjøkart raster'});
const detailedDepthLayer=L.tileLayer.wms('https://wms.geonorge.no/skwms1/wms.dybdedata2',{layers:'Dybdedata2',styles:'',format:'image/png',transparent:true,version:'1.3.0',tileSize:512,updateWhenIdle:true,updateWhenZooming:false,keepBuffer:1,opacity:.94,maxZoom:18,attribution:'© Kartverket · Sjøkart Dybdedata'});
let seaChartTileErrors=0,depthTileErrors=0;

const $ = id => document.getElementById(id);
const warningMessages=new Map();
function renderWarnings(){const el=$('warnings');if(!el)return;const values=[...warningMessages.values()].filter(Boolean);el.textContent=[...new Set(values)].join(' ');}
function setWarning(key,message){if(!message){warningMessages.delete(key);}else warningMessages.set(key,String(message).trim());renderWarnings();}
function clearWarning(key){warningMessages.delete(key);renderWarnings();}
function clearTransientWarnings(){for(const key of ['analysis-fallback','analysis-error','ramps','nve-map'])warningMessages.delete(key);renderWarnings();}
seaChartLayer.on('tileerror',()=>{ if(++seaChartTileErrors===3 && $('mapStyle')?.value==='chart') setWarning('chart-tiles','Kartverkets sjøkart mangler noen kartfliser akkurat nå. Grunnkartet beholdes under.'); });
detailedDepthLayer.on('tileerror',()=>{ if(++depthTileErrors===3 && $('mapStyle')?.value==='fishing'&&!freshwaterFishTypes.has($('fishType')?.value)) setWarning('marine-depth-tiles','Kartverkets sjødybder mangler noen kartfliser akkurat nå. Grunnkartet beholdes under.'); });
seaChartLayer.on('tileload',()=>{seaChartTileErrors=0;clearWarning('chart-tiles');}); detailedDepthLayer.on('tileload',()=>{depthTileErrors=0;clearWarning('marine-depth-tiles');});
const zoneLayer = L.layerGroup().addTo(map);
const navigationLayer = L.layerGroup().addTo(map);
const sourceSpotLayer = L.layerGroup().addTo(map);
const restrictionLayer = L.layerGroup().addTo(map);
const conditionLayer = L.layerGroup().addTo(map);
const boatRampLayer = L.layerGroup().addTo(map);
const waterFocusLayer=L.layerGroup().addTo(map);
let waterDirectoryItems=[];
let waterDirectoryMeta={};
let selectedWaterDirectoryName=null;
// REV41: freshwater depth overlay comes from the same NVE REST layers used by 3D.
// This avoids relying on a separate WMS toggle and lets the app say clearly when a lake has no surveyed depths.
const freshwaterDepthLayer=L.layerGroup();
let freshwaterDepthController=null;
let freshwaterDepthGridController=null;
let freshwaterDepthKey='';
let freshwaterDepthInfo=null;
let freshwaterDepthGrid=null;
const mapContainerObserver = new ResizeObserver(() => map.invalidateSize({ pan: false }));
mapContainerObserver.observe(document.querySelector('.map-wrap'));
window.addEventListener('load', () => setTimeout(() => map.invalidateSize({ pan: false }), 0));
let timer;
let controller;
let locationMarker;
let baseMarker;
let baseRadiusCircle;
let basePoint=savedUiState.basePoint&&Number.isFinite(savedUiState.basePoint.lat)&&Number.isFinite(savedUiState.basePoint.lon)?savedUiState.basePoint:null;
// REV27 LIVE GPS: kontinuerlig posisjonsfolging for dorging og forflytning.
const liveTrackLayer=L.polyline([],{color:'#38d477',weight:4,opacity:.9,lineCap:'round',lineJoin:'round'}).addTo(map);
let liveWatchId=null;
let liveActive=false;
let livePosition=null;
let liveLocationMarker=null;
let liveAccuracyCircle=null;
let liveTrackPoints=[];
let liveLastFix=null;
let liveLastAnalysisAt=0;
let liveLastAnalysisPoint=null;
let liveWakeLock=null;
function currentAnalysisBase(){ return liveActive&&livePosition?{lat:livePosition.lat,lon:livePosition.lon}:basePoint; }
function liveDistanceMeters(a,b){ return a&&b?distanceKm(a,b)*1000:Infinity; }
function liveSpeedKmh(coords,timestamp,lat,lon){
  if(Number.isFinite(coords.speed)&&coords.speed>=0) return coords.speed*3.6;
  if(liveLastFix&&Number.isFinite(liveLastFix.timestamp)&&timestamp>liveLastFix.timestamp){
    const moved=liveDistanceMeters({lat:liveLastFix.lat,lon:liveLastFix.lon},{lat,lon});
    const seconds=(timestamp-liveLastFix.timestamp)/1000;
    if(seconds>0&&Number.isFinite(moved)) return Math.min(80,(moved/seconds)*3.6);
  }
  return null;
}
function renderLiveHud(){
  const hud=$('liveHud'),text=$('liveHudText');
  if(!hud||!text) return;
  hud.hidden=!liveActive;
  if(!liveActive) return;
  if(!livePosition){text.textContent='Venter på GPS-signal …';return;}
  const speed=Number.isFinite(livePosition.speedKmh)?`${livePosition.speedKmh.toFixed(1).replace('.',',')} km/t`:'fart –';
  const accuracy=Number.isFinite(livePosition.accuracy)?`±${Math.round(livePosition.accuracy)} m`:'nøyaktighet –';
  const heading=Number.isFinite(livePosition.heading)?` · kurs ${Math.round(livePosition.heading)}°`:'';
  text.textContent=`${speed} · ${accuracy}${heading}`;
}
function setLiveButton(){
  const button=$('live');
  if(!button) return;
  button.classList.toggle('live-active',liveActive);
  button.setAttribute('aria-pressed',String(liveActive));
  button.textContent=liveActive?'● LIVE PÅ':'● Live';
}
async function acquireLiveWakeLock(){
  if(!liveActive||document.visibilityState!=='visible'||!('wakeLock' in navigator)) return;
  try{liveWakeLock=await navigator.wakeLock.request('screen');liveWakeLock.addEventListener?.('release',()=>{liveWakeLock=null;},{once:true});}catch{}
}
async function releaseLiveWakeLock(){
  try{await liveWakeLock?.release();}catch{}
  liveWakeLock=null;
}
function updateLiveMapPosition(position){
  if(!liveActive) return;
  const {latitude,longitude,accuracy,heading}=position.coords||{};
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)) return;
  const timestamp=Number(position.timestamp)||Date.now();
  const speedKmh=liveSpeedKmh(position.coords||{},timestamp,latitude,longitude);
  livePosition={lat:latitude,lon:longitude,accuracy:Number.isFinite(accuracy)?accuracy:null,heading:Number.isFinite(heading)?heading:null,speedKmh,timestamp};
  const latlng=L.latLng(latitude,longitude);
  if(!liveLocationMarker){
    liveLocationMarker=L.circleMarker(latlng,{radius:9,color:'#fff',weight:3,fillColor:'#38d477',fillOpacity:1,pane:'markerPane'}).addTo(map).bindTooltip('LIVE-posisjon',{direction:'top'});
  }else liveLocationMarker.setLatLng(latlng);
  if(Number.isFinite(accuracy)){
    if(!liveAccuracyCircle) liveAccuracyCircle=L.circle(latlng,{radius:accuracy,color:'#38d477',weight:1,fillColor:'#38d477',fillOpacity:.08,interactive:false}).addTo(map);
    else liveAccuracyCircle.setLatLng(latlng).setRadius(accuracy);
  }
  const lastTrack=liveTrackPoints[liveTrackPoints.length-1];
  if(!lastTrack||liveDistanceMeters({lat:lastTrack.lat,lon:lastTrack.lng},{lat:latitude,lon:longitude})>=3){
    liveTrackPoints.push(latlng);
    if(liveTrackPoints.length>1500) liveTrackPoints.shift();
    liveTrackLayer.setLatLngs(liveTrackPoints);
  }
  updateBaseRadiusCircle();
  renderLiveHud();
  sync3DReferenceAndLive();
  if(is3DMode()&&threeDMap){threeDProgrammaticMove=true;threeDMap.easeTo({center:[longitude,latitude],zoom:Math.max(15,threeDMap.getZoom()),pitch:62,duration:liveLastFix?320:500});threeDSyncing=true;map.setView(latlng,Math.max(15,map.getZoom()),{animate:false});setTimeout(()=>{threeDSyncing=false;},0);}
  else if(is3DMode()){map.setView(latlng,Math.max(15,map.getZoom()),{animate:!liveLastFix});scheduleNative3DRefresh(240);}
  else if(!liveLastFix) map.setView(latlng,Math.max(15,map.getZoom()),{animate:true});
  else map.panTo(latlng,{animate:true,duration:.35,noMoveStart:true});
  const now=Date.now();
  const movedSinceAnalysis=liveLastAnalysisPoint?liveDistanceMeters(liveLastAnalysisPoint,{lat:latitude,lon:longitude}):Infinity;
  if(!liveLastAnalysisAt||now-liveLastAnalysisAt>=20000||movedSinceAnalysis>=60){
    liveLastAnalysisAt=now;
    liveLastAnalysisPoint={lat:latitude,lon:longitude};
    loadZones({immediate:true});
  }
  liveLastFix={lat:latitude,lon:longitude,timestamp};
  setState('ready',`LIVE GPS · ${Number.isFinite(speedKmh)?speedKmh.toFixed(1).replace('.',',')+' km/t · ':''}${Number.isFinite(accuracy)?'±'+Math.round(accuracy)+' m · ':''}kartet følger posisjonen`);
}
function handleLiveGpsError(error){
  if(error?.code===1){stopLiveMode({message:false});setState('error','LIVE GPS fikk ikke tilgang til posisjon. Tillat posisjon for dette nettstedet og prøv igjen.');return;}
  setState('locating','LIVE GPS: venter på bedre GPS-signal …');
  const text=$('liveHudText'); if(text) text.textContent='GPS-signal midlertidig utilgjengelig …';
}
function startLiveMode(){
  if(liveActive){stopLiveMode();return;}
  if(!navigator.geolocation){setState('error','Denne nettleseren støtter ikke kontinuerlig GPS.');return;}
  liveActive=true;
  livePosition=null;
  liveLastFix=null;
  liveLastAnalysisAt=0;
  liveLastAnalysisPoint=null;
  liveTrackPoints=[];
  liveTrackLayer.setLatLngs([]);
  setLiveButton();
  renderLiveHud();
  setState('locating','LIVE GPS starter … kartet vil følge deg kontinuerlig.');
  acquireLiveWakeLock();
  liveWatchId=navigator.geolocation.watchPosition(updateLiveMapPosition,handleLiveGpsError,{enableHighAccuracy:true,maximumAge:1000,timeout:20000});
}
function stopLiveMode({message=true}={}){
  if(liveWatchId!==null&&navigator.geolocation) navigator.geolocation.clearWatch(liveWatchId);
  liveWatchId=null;
  liveActive=false;
  livePosition=null;
  liveLastFix=null;
  liveLastAnalysisAt=0;
  liveLastAnalysisPoint=null;
  if(liveAccuracyCircle){liveAccuracyCircle.remove();liveAccuracyCircle=null;}
  if(liveLocationMarker){liveLocationMarker.remove();liveLocationMarker=null;}
  updateBaseRadiusCircle();
  sync3DReferenceAndLive();
  setLiveButton();
  renderLiveHud();
  releaseLiveWakeLock();
  if(message) setState('ready','LIVE GPS stoppet. Sporlinjen blir stående på kartet til Live startes igjen.');
}
let latestZones=[];
let selectedZoneId=null;
// REV36: optional lazy-loaded MapLibre 3D terrain view with dual-CDN mobile fallback. Leaflet remains the analysis engine;
// the two maps are synchronized so 3D never changes the scoring logic or Live GPS behavior.
let threeDMap=null;
let threeDReady=false;
let threeDLoadPromise=null;
let threeDActive=false;
let threeDSyncing=false;
let threeDProgrammaticMove=false;
let threeDErrorCount=0;
let forceNative3DTerrain=false;
let nativeThreeDLoadToken=0;
let nativeThreeDReady=false;
let nativeThreeDScene=null;
let nativeThreeDResizeObserver=null;
let nativeThreeDProjectedZones=[];
const nativeThreeDView={yaw:-0.55,pitch:0.88,zoom:1,pointers:new Map(),moved:false,lastPinch:0};
const THREE_D_LIB_VERSION='6.10.0';
function is3DMode(){return threeDActive&&$('mapStyle')?.value==='3d';}
function ensureMapLibre(){
  if(window.maplibregl) return Promise.resolve(window.maplibregl);
  if(threeDLoadPromise) return threeDLoadPromise;
  threeDLoadPromise=(async()=>{
    const probe=document.createElement('canvas');
    if(!probe.getContext('webgl2')&&!probe.getContext('webgl')) throw new Error('Nettleseren har ikke WebGL aktivert for 3D-kart.');
    const cssUrls=[`https://unpkg.com/maplibre-gl@${THREE_D_LIB_VERSION}/dist/maplibre-gl.css`,`https://cdn.jsdelivr.net/npm/maplibre-gl@${THREE_D_LIB_VERSION}/dist/maplibre-gl.css`];
    cssUrls.forEach((href,index)=>{if(!document.querySelector(`link[data-maplibre-css="${index}"]`)){const link=document.createElement('link');link.rel='stylesheet';link.dataset.maplibreCss=String(index);link.href=href;document.head.appendChild(link);}});
    const load=src=>new Promise((resolve,reject)=>{const tag=document.createElement('script');tag.src=src;tag.async=true;tag.dataset.maplibre='1';const timer=setTimeout(()=>{tag.remove();reject(new Error('timeout'));},9000);tag.onload=()=>{clearTimeout(timer);window.maplibregl?resolve(window.maplibregl):reject(new Error('MapLibre mangler etter lasting'));};tag.onerror=()=>{clearTimeout(timer);tag.remove();reject(new Error('lastingsfeil'));};document.head.appendChild(tag);});
    const sources=[`https://unpkg.com/maplibre-gl@${THREE_D_LIB_VERSION}/dist/maplibre-gl.js`,`https://cdn.jsdelivr.net/npm/maplibre-gl@${THREE_D_LIB_VERSION}/dist/maplibre-gl.js`];
    let lastError=null;for(const src of sources){try{return await load(src);}catch(error){lastError=error;}}
    throw new Error(`MapLibre kunne ikke lastes på denne enheten${lastError?.message?`: ${lastError.message}`:''}`);
  })().catch(error=>{threeDLoadPromise=null;throw error;});
  return threeDLoadPromise;
}
function threeDStyleSpec(){
  const freshwater=freshwaterFishTypes.has($('fishType')?.value);
  return {version:8,glyphs:'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',sources:{
    topo:{type:'raster',tiles:['https://cache.kartverket.no/v1/wmts/1.0.0/toporaster/default/webmercator/{z}/{y}/{x}.png'],tileSize:256,maxzoom:19,attribution:'© Kartverket (CC BY 4.0)'},
    terrain:{type:'raster-dem',tiles:['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],tileSize:256,minzoom:0,maxzoom:15,encoding:'terrarium',attribution:'© AWS Terrain Tiles'},
    depthwms:{type:'raster',tiles:['https://wms.geonorge.no/skwms1/wms.dybdedata2?service=WMS&request=GetMap&version=1.1.1&layers=Dybdedata2&styles=&format=image/png&transparent=true&srs=EPSG:3857&bbox={bbox-epsg-3857}&width=256&height=256'],tileSize:256,maxzoom:18,attribution:'© Kartverket · dybdedata'}
  },layers:[
    {id:'topo-raster',type:'raster',source:'topo',paint:{'raster-opacity':1}},
    {id:'terrain-hillshade',type:'hillshade',source:'terrain',paint:{'hillshade-exaggeration':0.42,'hillshade-shadow-color':'#27352f','hillshade-highlight-color':'#f7fbf6','hillshade-accent-color':'#556b60'}},
    {id:'depth-overlay',type:'raster',source:'depthwms',layout:{visibility:freshwater?'none':'visible'},paint:{'raster-opacity':0.78}}
  ]};
}
function emptyFeatureCollection(){return {type:'FeatureCollection',features:[]};}
function ensure3DDataLayers(){
  if(!threeDMap||!(threeDMap.isStyleLoaded?.()||threeDReady)) return;
  const addSource=(id)=>{if(!threeDMap.getSource(id))threeDMap.addSource(id,{type:'geojson',data:emptyFeatureCollection()});};
  addSource('fiste-zones');addSource('fiste-casts');addSource('fiste-reference');addSource('fiste-live-track');addSource('fiste-restrictions');addSource('fiste-source-spots');
  if(!threeDMap.getLayer('fiste-restrictions')) threeDMap.addLayer({id:'fiste-restrictions',type:'line',source:'fiste-restrictions',paint:{'line-color':'#ff3b30','line-width':6,'line-opacity':0.9,'line-dasharray':[2,1.4]}});
  if(!threeDMap.getLayer('fiste-source-spots')) threeDMap.addLayer({id:'fiste-source-spots',type:'circle',source:'fiste-source-spots',paint:{'circle-radius':8,'circle-color':['get','color'],'circle-opacity':0.45,'circle-stroke-color':['get','color'],'circle-stroke-width':2}});
  if(!threeDMap.getLayer('fiste-casts')) threeDMap.addLayer({id:'fiste-casts',type:'line',source:'fiste-casts',paint:{'line-color':'#ff9f1c','line-width':4,'line-opacity':0.9}});
  if(!threeDMap.getLayer('fiste-live-track')) threeDMap.addLayer({id:'fiste-live-track',type:'line',source:'fiste-live-track',paint:{'line-color':'#38d477','line-width':4,'line-opacity':0.95}});
  if(!threeDMap.getLayer('fiste-zone-halo')) threeDMap.addLayer({id:'fiste-zone-halo',type:'circle',source:'fiste-zones',paint:{'circle-radius':['case',['==',['get','selected'],1],18,14],'circle-color':['get','color'],'circle-opacity':0.20,'circle-stroke-color':['case',['==',['get','selected'],1],'#ffffff','#0b241d'],'circle-stroke-width':['case',['==',['get','selected'],1],4,2]}});
  if(!threeDMap.getLayer('fiste-zone-points')) threeDMap.addLayer({id:'fiste-zone-points',type:'circle',source:'fiste-zones',paint:{'circle-radius':7,'circle-color':['get','color'],'circle-stroke-color':'#10251f','circle-stroke-width':2}});
  if(!threeDMap.getLayer('fiste-zone-labels')) threeDMap.addLayer({id:'fiste-zone-labels',type:'symbol',source:'fiste-zones',layout:{'text-field':['get','label'],'text-size':12,'text-font':['Open Sans Bold'],'text-offset':[0,1.55],'text-anchor':'top','text-allow-overlap':true},paint:{'text-color':'#ffffff','text-halo-color':'#071b16','text-halo-width':2}});
  if(!threeDMap.getLayer('fiste-reference')) threeDMap.addLayer({id:'fiste-reference',type:'circle',source:'fiste-reference',paint:{'circle-radius':['case',['==',['get','kind'],'live'],9,7],'circle-color':['case',['==',['get','kind'],'live'],'#38d477','#f2c94c'],'circle-stroke-color':'#ffffff','circle-stroke-width':2}});
}
function threeDFeatureColor(zone){const fish=zone.fishType||$('fishType')?.value;return $('fishType')?.value==='all'?(speciesColors[fish]||scoreColor(zone.score)):scoreColor(zone.score);}
function sync3DZones(){
  if((!threeDMap||!threeDReady)&&native3DActiveNow()){renderNative3DCanvas();return;}
  if(!threeDMap||!threeDReady) return;
  ensure3DDataLayers();
  const zoneSource=threeDMap.getSource('fiste-zones'),castSource=threeDMap.getSource('fiste-casts');
  if(!zoneSource||!castSource)return;
  const features=latestZones.map((zone,index)=>({type:'Feature',geometry:{type:'Point',coordinates:[zone.marker.lon,zone.marker.lat]},properties:{id:zone.id,rank:index+1,score:Math.round(zone.score||0),selected:zone.id===selectedZoneId?1:0,color:threeDFeatureColor(zone),label:`${index+1}${Number.isFinite(zone.depth?.meters)?' · '+zone.depth.meters.toFixed(1)+' m':''}`}}));
  zoneSource.setData({type:'FeatureCollection',features});
  const castFeatures=latestZones.slice(0,3).filter(zone=>Number.isFinite(zone.castBearing)).map((zone,index)=>{const length=index===0?90:60,rad=zone.castBearing*Math.PI/180,dLat=(Math.sin(rad)*length)/110540,dLon=(Math.cos(rad)*length)/(111320*Math.max(.2,Math.cos(zone.marker.lat*Math.PI/180)));return {type:'Feature',geometry:{type:'LineString',coordinates:[[zone.marker.lon,zone.marker.lat],[zone.marker.lon+dLon,zone.marker.lat+dLat]]},properties:{id:zone.id}};});
  castSource.setData({type:'FeatureCollection',features:castFeatures});
  if(native3DActiveNow()) renderNative3DCanvas();
}
function sync3DReferenceAndLive(){
  if((!threeDMap||!threeDReady)&&native3DActiveNow()){renderNative3DCanvas();return;}
  if(!threeDMap||!threeDReady) return;
  ensure3DDataLayers();
  const ref=threeDMap.getSource('fiste-reference'),track=threeDMap.getSource('fiste-live-track');
  const point=liveActive&&livePosition?{lon:livePosition.lon,lat:livePosition.lat,kind:'live'}:basePoint?{lon:basePoint.lon,lat:basePoint.lat,kind:'base'}:null;
  ref?.setData({type:'FeatureCollection',features:point?[{type:'Feature',geometry:{type:'Point',coordinates:[point.lon,point.lat]},properties:{kind:point.kind}}]:[]});
  track?.setData({type:'FeatureCollection',features:liveTrackPoints.length>1?[{type:'Feature',geometry:{type:'LineString',coordinates:liveTrackPoints.map(p=>[p.lng,p.lat])},properties:{}}]:[]});
}
function sync3DReferenceLayers(){
  if((!threeDMap||!threeDReady)&&native3DActiveNow()){renderNative3DCanvas();return;}
  if(!threeDMap||!threeDReady)return;
  ensure3DDataLayers();
  const freshwater=freshwaterFishTypes.has($('fishType')?.value);
  const restrictionFeatures=[];
  if(showRestrictions&&!freshwater&&restrictionData){
    for(const zone of restrictionData.zones.filter(item=>item.renderBoundary&&Array.isArray(item.outerBoundary)&&item.outerBoundary.length>=2)){
      restrictionFeatures.push({type:'Feature',geometry:{type:'LineString',coordinates:zone.outerBoundary.map(point=>[point.lon,point.lat])},properties:{name:zone.name||'Fredningsgrense'}});
    }
  }
  threeDMap.getSource('fiste-restrictions')?.setData({type:'FeatureCollection',features:restrictionFeatures});
  const spotFeatures=[];
  if(showSourceSpots&&$('fishType')?.value==='sjoorret'&&sourceSpotData){
    for(const spot of sourceSpotData.spots||[]) spotFeatures.push({type:'Feature',geometry:{type:'Point',coordinates:[spot.lon,spot.lat]},properties:{name:spot.name||'',color:spot.status==='restricted'?'#ff5d55':'#f2c94c'}});
  }
  threeDMap.getSource('fiste-source-spots')?.setData({type:'FeatureCollection',features:spotFeatures});
  if(native3DActiveNow()) renderNative3DCanvas();
}
function sync3DWaterMode(){
  if(!threeDMap||!threeDReady||!threeDMap.getLayer('depth-overlay'))return;
  const freshwater=freshwaterFishTypes.has($('fishType')?.value);
  try{threeDMap.setLayoutProperty('depth-overlay','visibility',freshwater?'none':'visible');}catch{}
}
function focusMapOnZone(zone,zoom=15){
  if(!zone?.marker)return;
  if(is3DMode()&&threeDMap){threeDProgrammaticMove=true;threeDMap.easeTo({center:[zone.marker.lon,zone.marker.lat],zoom:Math.max(threeDMap.getZoom(),zoom),pitch:62,bearing:threeDMap.getBearing(),duration:550});}
  else{map.setView([zone.marker.lat,zone.marker.lon],Math.max(map.getZoom(),zoom),{animate:true});if(is3DMode())scheduleNative3DRefresh(180);}
}
function syncLeafletFrom3D({reload=true}={}){
  if(!threeDMap||!threeDActive)return;
  const c=threeDMap.getCenter(),z=Math.max(3,Math.min(19,threeDMap.getZoom()));
  threeDSyncing=true;map.setView([c.lat,c.lng],z,{animate:false});setTimeout(()=>{threeDSyncing=false;},0);
  saveUiState();if(reload)loadZones();
}
async function enable3DMap(){
  threeDActive=true;
  const wrap=document.querySelector('.map-wrap'),container=$('map3d'),hud=$('threeDHud');
  wrap?.classList.add('three-d-active');if(container)container.hidden=false;if(hud)hud.hidden=false;
  const notice=document.querySelector('.map-notice');if(notice)notice.textContent='Laster 3D topo … 10 beste punkter, GPS-spor og dybdeetiketter vises også i 3D.';
  if(freshwaterFishTypes.has($('fishType')?.value)){await enableNative3DMap();return;}
  if(forceNative3DTerrain){await enableNative3DMap();return;}
  try{
    const lib=await ensureMapLibre();
    if(!threeDActive||$('mapStyle')?.value!=='3d')return;
    if(!threeDMap){
      const c=map.getCenter();
      threeDMap=new lib.Map({container:'map3d',style:threeDStyleSpec(),center:[c.lng,c.lat],zoom:map.getZoom(),pitch:62,bearing:-18,maxPitch:78,renderWorldCopies:false,attributionControl:true});
      threeDMap.addControl(new lib.NavigationControl({visualizePitch:true}),'top-right');
      threeDMap.on('load',()=>{threeDReady=true;try{threeDMap.setTerrain({source:'terrain',exaggeration:1.35});}catch{}ensure3DDataLayers();sync3DZones();syncBathyZones();sync3DReferenceAndLive();sync3DReferenceLayers();sync3DWaterMode();
        const zoneLayers=['fiste-zone-halo','fiste-zone-points','fiste-zone-labels'];
        threeDMap.on('click',event=>{const layers=zoneLayers.filter(id=>threeDMap.getLayer(id));const hit=layers.length?threeDMap.queryRenderedFeatures(event.point,{layers})[0]:null;if(hit?.properties?.id){selectZone(hit.properties.id,{scroll:false});return;}setBasePoint(L.latLng(event.lngLat.lat,event.lngLat.lng),{label:'Kartklikk 3D',focus:false});setState('ready','3D-kartklikk satt som referansepunkt. Oppdaterer 10 beste soner …');});
        zoneLayers.forEach(id=>{threeDMap.on('mouseenter',id,()=>{threeDMap.getCanvas().style.cursor='pointer';});threeDMap.on('mouseleave',id,()=>{threeDMap.getCanvas().style.cursor='';});});
        const n=document.querySelector('.map-notice');if(n)n.textContent='3D topo: roter kartet for å lese terreng og kanter. Dybdekoter vises i sjø; de er ikke en 3D-ekkoloddmodell.';
      });
      threeDMap.on('moveend',()=>{const reload=!threeDProgrammaticMove;threeDProgrammaticMove=false;syncLeafletFrom3D({reload});});
      threeDMap.on('error',event=>{threeDErrorCount++;if(threeDErrorCount===2)setWarning('3d','3D-terreng svarte ikke akkurat nå. 2D-kartet fungerer fortsatt.');});
    }else{
      const c=map.getCenter();threeDProgrammaticMove=true;threeDMap.jumpTo({center:[c.lng,c.lat],zoom:map.getZoom(),pitch:62});threeDMap.resize();sync3DZones();syncBathyZones();sync3DReferenceAndLive();sync3DReferenceLayers();sync3DWaterMode();
    }
  }catch(error){
    forceNative3DTerrain=true;
    clearWarning('3d');const n=document.querySelector('.map-notice');if(n)n.textContent='3D-topo bruker innebygd terrengvisning på denne enheten.';
    await enableNative3DMap();
  }
}
function disable3DMap(){
  threeDActive=false;document.querySelector('.map-wrap')?.classList.remove('three-d-active');if($('map3d'))$('map3d').hidden=true;if($('threeDHud'))$('threeDHud').hidden=true;const notice=document.querySelector('.map-notice');if(notice)notice.textContent='Klikk i kartet = nytt referansepunkt. De 10 beste sonene oppdateres automatisk.';setTimeout(()=>map.invalidateSize({pan:false}),0);
}

function ensureNative3DCanvas(){
  const container=$('map3d');
  if(!container||container.dataset.nativeTerrain==='1') return;
  container.dataset.nativeTerrain='1';
  container.innerHTML='<canvas id="terrain3DCanvas" aria-label="Interaktivt 3D topografisk kart. Dra for å rotere, bruk to fingre eller musehjul for zoom."></canvas><div id="terrain3DEmpty" class="terrain3d-empty">Åpner 3D terreng …</div><div id="terrain3DAttribution" class="terrain3d-attribution">Kartverket terreng og dybdedata · innebygd 3D</div>';
}
function native3DCanvas(){return $('terrain3DCanvas');}
function native3DEmpty(){return $('terrain3DEmpty');}
function native3DActiveNow(){return threeDActive&&$('mapStyle')?.value==='3d';}
function renderNative3DCanvas(){
  const canvas=native3DCanvas();
  if(!canvas||!nativeThreeDScene||!native3DActiveNow()) return;
  const {ctx,w,h}=bathyEnsureCanvasSize(canvas),scene=nativeThreeDScene;if(w<20||h<20)return;
  const bg=ctx.createLinearGradient(0,0,0,h);bg.addColorStop(0,'#173a31');bg.addColorStop(.38,'#0e241d');bg.addColorStop(1,'#061713');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
  const polys=scene.triangles.map(t=>{const p=t.v.map(v=>bathyProject(scene,v,w,h,nativeThreeDView));return {t,p,d:(p[0].depth+p[1].depth+p[2].depth)/3};}).sort((a,b)=>a.d-b.d);
  for(const item of polys){const {t,p}=item;const shade=.9+bathyClamp((item.d+1)*.085,0,.18);ctx.beginPath();ctx.moveTo(p[0].x,p[0].y);ctx.lineTo(p[1].x,p[1].y);ctx.lineTo(p[2].x,p[2].y);ctx.closePath();ctx.fillStyle=t.sea?bathySeaColor(t.depth,scene.depthCap,shade):bathyLandColor(Math.max(0,t.z),scene.landCap,shade);ctx.fill();ctx.strokeStyle=t.sea?'rgba(210,248,255,.14)':'rgba(170,210,190,.12)';ctx.lineWidth=.55;ctx.stroke();}
  ctx.strokeStyle='rgba(195,246,252,.72)';ctx.lineWidth=1.15;ctx.beginPath();
  for(let r=0;r<scene.grid.height;r++)for(let c=0;c<scene.grid.width-1;c++){const a=scene.vertices[r][c],b=scene.vertices[r][c+1];if(a&&b&&a.sea!==b.sea){const pa=bathyProject(scene,{x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:0},w,h,nativeThreeDView);ctx.moveTo(pa.x-1,pa.y);ctx.lineTo(pa.x+1,pa.y);}}
  ctx.stroke();
  nativeThreeDProjectedZones=[];
  const zones=latestZones.filter(v=>v?.marker&&v.marker.lon>=scene.grid.west&&v.marker.lon<=scene.grid.east&&v.marker.lat>=scene.grid.south&&v.marker.lat<=scene.grid.north).slice(0,10);
  zones.forEach((zone,index)=>{const z=(bathyGridValueAt(scene.grid,zone.marker.lon,zone.marker.lat)??0)+2;const p=bathyProject(scene,{x:scene.frame.xForLon(zone.marker.lon),y:scene.frame.yForLat(zone.marker.lat),z},w,h,nativeThreeDView);nativeThreeDProjectedZones.push({x:p.x,y:p.y,id:zone.id});ctx.beginPath();ctx.arc(p.x,p.y,8,0,Math.PI*2);ctx.fillStyle=threeDFeatureColor(zone);ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#fff';ctx.stroke();ctx.font='700 11px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillStyle='#fff';ctx.shadowColor='rgba(0,0,0,.78)';ctx.shadowBlur=3;ctx.fillText(`${index+1} · ${Math.round(zone.score||0)}`,p.x,p.y-10);ctx.shadowBlur=0;});
  const focusPoint=liveActive&&livePosition?{lat:livePosition.lat,lon:livePosition.lon,color:'#38d477',radius:7}:{lat:map.getCenter().lat,lon:map.getCenter().lng,color:'#ef4444',radius:6};
  if(focusPoint.lon>=scene.grid.west&&focusPoint.lon<=scene.grid.east&&focusPoint.lat>=scene.grid.south&&focusPoint.lat<=scene.grid.north){const z=(bathyGridValueAt(scene.grid,focusPoint.lon,focusPoint.lat)??0)+3;const p=bathyProject(scene,{x:scene.frame.xForLon(focusPoint.lon),y:scene.frame.yForLat(focusPoint.lat),z},w,h,nativeThreeDView);ctx.beginPath();ctx.arc(p.x,p.y,focusPoint.radius,0,Math.PI*2);ctx.fillStyle=focusPoint.color;ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}
  ctx.fillStyle='rgba(222,244,234,.92)';ctx.font='700 11px system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='top';ctx.fillText('3D terreng / bunn',12,12);
  ctx.font='600 11px system-ui,sans-serif';ctx.textBaseline='alphabetic';ctx.fillStyle='rgba(222,244,234,.88)';ctx.fillText('Kartverket · interaktiv 3D',12,h-14);
}
function native3DCamera(kind='pitch'){
  if(kind==='top'){nativeThreeDView.yaw=0;nativeThreeDView.pitch=0;nativeThreeDView.zoom=.98;}
  else{nativeThreeDView.yaw=-0.55;nativeThreeDView.pitch=0.88;nativeThreeDView.zoom=1;}
  renderNative3DCanvas();
}
function bindNative3DCanvas(){
  const canvas=native3DCanvas();if(!canvas||canvas.dataset.bound==='1')return;canvas.dataset.bound='1';
  const point=e=>({x:e.clientX,y:e.clientY});
  canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture?.(e.pointerId);nativeThreeDView.pointers.set(e.pointerId,point(e));nativeThreeDView.moved=false;if(nativeThreeDView.pointers.size===2){const q=[...nativeThreeDView.pointers.values()];nativeThreeDView.lastPinch=Math.hypot(q[0].x-q[1].x,q[0].y-q[1].y);}});
  canvas.addEventListener('pointermove',e=>{const prev=nativeThreeDView.pointers.get(e.pointerId);if(!prev)return;const now=point(e),dx=now.x-prev.x,dy=now.y-prev.y;nativeThreeDView.pointers.set(e.pointerId,now);if(Math.abs(dx)+Math.abs(dy)>2)nativeThreeDView.moved=true;if(nativeThreeDView.pointers.size===1){nativeThreeDView.yaw+=dx*.009;nativeThreeDView.pitch=bathyClamp(nativeThreeDView.pitch-dy*.006,0,1.28);renderNative3DCanvas();}else if(nativeThreeDView.pointers.size>=2){const q=[...nativeThreeDView.pointers.values()].slice(0,2),dist=Math.hypot(q[0].x-q[1].x,q[0].y-q[1].y);if(nativeThreeDView.lastPinch>0)nativeThreeDView.zoom=bathyClamp(nativeThreeDView.zoom*(dist/nativeThreeDView.lastPinch),.58,2.7);nativeThreeDView.lastPinch=dist;renderNative3DCanvas();}});
  const end=e=>{const pos=point(e);nativeThreeDView.pointers.delete(e.pointerId);if(nativeThreeDView.pointers.size<2)nativeThreeDView.lastPinch=0;if(!nativeThreeDView.moved){let best=null;for(const z of nativeThreeDProjectedZones){const d=Math.hypot(z.x-(pos.x-canvas.getBoundingClientRect().left),z.y-(pos.y-canvas.getBoundingClientRect().top));if(d<28&&(!best||d<best.d))best={...z,d};}if(best)selectZone(best.id,{scroll:false});}};
  canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('wheel',e=>{e.preventDefault();nativeThreeDView.zoom=bathyClamp(nativeThreeDView.zoom*(e.deltaY>0?.92:1.08),.58,2.7);renderNative3DCanvas();},{passive:false});
  canvas.addEventListener('dblclick',e=>{e.preventDefault();native3DCamera('pitch');});
  if('ResizeObserver' in window&&!nativeThreeDResizeObserver){nativeThreeDResizeObserver=new ResizeObserver(()=>renderNative3DCanvas());nativeThreeDResizeObserver.observe(canvas);}
}
async function refreshNative3DMap(){
  if(!native3DActiveNow()) return;
  ensureNative3DCanvas();
  const token=++nativeThreeDLoadToken;const empty=native3DEmpty();
  if(empty){empty.hidden=false;empty.textContent='Henter terreng- og dybdedata fra Kartverket …';}
  const notice=document.querySelector('.map-notice');if(notice)notice.textContent='3D terreng: dra for å rotere, bruk musehjul eller to fingre for zoom. Velg sone under til høyre for å hoppe i utsnittet.';
  try{
    const grid=await fetchBathymetryGrid();
    if(token!==nativeThreeDLoadToken||!native3DActiveNow()) return;
    nativeThreeDScene=buildBathyScene(grid);nativeThreeDReady=true;bindNative3DCanvas();requestAnimationFrame(()=>{renderNative3DCanvas();if(empty)empty.hidden=true;});
  }catch(error){
    if(token!==nativeThreeDLoadToken) return;
    nativeThreeDReady=false;nativeThreeDScene=null;
    if(empty){empty.hidden=false;empty.textContent=error.message;}
    setWarning('3d',`3D terreng kunne ikke oppdateres: ${error.message}`);
  }
}
async function enableNative3DMap(){
  ensureNative3DCanvas();
  await refreshNative3DMap();
}
function scheduleNative3DRefresh(delay=650){if(!native3DActiveNow()) return;clearTimeout(scheduleNative3DRefresh._t);scheduleNative3DRefresh._t=setTimeout(()=>refreshNative3DMap(),delay);}

// REV36: mobile-first 3D bathymetry lives in a collapsible panel BELOW the normal map.
// The renderer uses the browser's native 2D canvas instead of a third-party 3D CDN,
// so Android/Samsung browsers do not depend on Plotly/WebGL just to show the seabed.
let bathyActive=false;
let bathyLoadToken=0;
let bathyPlotReady=false;
let bathyLastGrid=null;
let bathyScene=null;
let bathyRefreshTimer=null;
let bathyResizeObserver=null;
let bathyProjectedZones=[];
const bathyView={yaw:-0.55,pitch:0.88,zoom:1,pointers:new Map(),moved:false,lastPinch:0};
function isBathy3DMode(){return bathyActive&&Boolean($('bathyPanel')?.open);}
function bathyBounds(){
  const b=map.getBounds();let west=b.getWest(),east=b.getEast(),south=b.getSouth(),north=b.getNorth();
  const c=map.getCenter(),maxSpan=.16;
  if(east-west>maxSpan){west=c.lng-maxSpan/2;east=c.lng+maxSpan/2;}
  if(north-south>maxSpan){south=c.lat-maxSpan/2;north=c.lat+maxSpan/2;}
  return {west,south,east,north,centerLat:c.lat,centerLon:c.lng};
}
function bathyLocalFrame(grid){
  const centerLat=(grid.south+grid.north)/2,centerLon=(grid.west+grid.east)/2;
  const metresPerLon=111320*Math.cos(centerLat*Math.PI/180),metresPerLat=110540;
  return {centerLat,centerLon,metresPerLon,metresPerLat,xForLon:lon=>(lon-centerLon)*metresPerLon,yForLat:lat=>(lat-centerLat)*metresPerLat};
}
function bathyGridValueAt(grid,lon,lat){
  if(lon<grid.west||lon>grid.east||lat<grid.south||lat>grid.north)return null;
  const col=Math.max(0,Math.min(grid.width-1,Math.round((lon-grid.west)/(grid.east-grid.west)*Math.max(1,grid.width-1))));
  const row=Math.max(0,Math.min(grid.height-1,Math.round((grid.north-lat)/(grid.north-grid.south)*Math.max(1,grid.height-1))));
  return grid.elevations?.[row]?.[col]??null;
}
async function fetchBathymetryGrid(){
  const requested=bathyBounds(),zoom=Math.max(10,Math.min(18,Math.round(map.getZoom())));
  const mobile=window.matchMedia?.('(max-width: 850px)').matches||navigator.maxTouchPoints>0;
  const quality=mobile?'mobile':'standard';
  const water=freshwaterFishTypes.has($('fishType')?.value)?'freshwater':'saltwater';
  const url=`/api/bathymetry-grid?bbox=${encodeURIComponent([requested.west,requested.south,requested.east,requested.north].join(','))}&zoom=${zoom}&quality=${quality}&water=${water}`;
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),26000);
  let response;
  try{response=await fetch(url,{headers:{Accept:'application/json'},signal:controller.signal,cache:'no-store'});}catch(error){if(error?.name==='AbortError')throw new Error('Dybdekilden brukte for lang tid. Zoom nærmere og trykk Oppdater.');throw error;}finally{clearTimeout(timer);}
  if(!response.ok){let message='Kunne ikke hente 3D-bunn';try{const j=await response.json();message=j.error||message;}catch{}throw new Error(message);}
  const grid=await response.json();
  if(!grid||!Array.isArray(grid.elevations)||!Array.isArray(grid.depths)||!Number.isFinite(grid.width)||!Number.isFinite(grid.height))throw new Error('3D-bunnen kom tilbake i ugyldig format.');
  if(grid.elevations.length!==grid.height||grid.depths.length!==grid.height)throw new Error('3D-bunnen er ufullstendig.');
  return {...grid,sourceResolution:Number(grid.sourceResolution)||null,sampling:Number(grid.samplingApproxM)||null};
}
function bathyClamp(v,a,b){return Math.max(a,Math.min(b,v));}
function bathyMix(a,b,t){t=bathyClamp(t,0,1);return Math.round(a+(b-a)*t);}
function bathySeaColor(depth,cap,shade=1){
  const t=bathyClamp((depth||0)/Math.max(1,cap),0,1),m=t<.45?t/.45:(t-.45)/.55;
  const a=t<.45?[157,232,239]:[44,159,202],b=t<.45?[44,159,202]:[6,47,93];
  return `rgb(${bathyClamp(Math.round(bathyMix(a[0],b[0],m)*shade),0,255)},${bathyClamp(Math.round(bathyMix(a[1],b[1],m)*shade),0,255)},${bathyClamp(Math.round(bathyMix(a[2],b[2],m)*shade),0,255)})`;
}
function bathyLandColor(height,cap,shade=1){
  const t=bathyClamp((height||0)/Math.max(1,cap),0,1),a=[49,78,63],b=[16,37,31];
  return `rgb(${bathyClamp(Math.round(bathyMix(a[0],b[0],t)*shade),0,255)},${bathyClamp(Math.round(bathyMix(a[1],b[1],t)*shade),0,255)},${bathyClamp(Math.round(bathyMix(a[2],b[2],t)*shade),0,255)})`;
}
function smoothBathymetryGrid(grid,passes=1){
  if(!grid?.elevations||!grid?.depths||passes<=0)return grid;
  let elevations=grid.elevations.map(r=>r.slice()),depths=grid.depths.map(r=>r.slice());
  for(let pass=0;pass<passes;pass++){
    const nextE=elevations.map(r=>r.slice()),nextD=depths.map(r=>r.slice());
    for(let r=1;r<grid.height-1;r++)for(let c=1;c<grid.width-1;c++){
      const centerE=elevations[r][c],centerD=depths[r][c];if(!Number.isFinite(centerE))continue;
      const isWater=Number.isFinite(centerD),valsE=[],valsD=[];
      for(let rr=r-1;rr<=r+1;rr++)for(let cc=c-1;cc<=c+1;cc++){
        const e=elevations[rr][cc],d=depths[rr][cc];if(!Number.isFinite(e)||Number.isFinite(d)!==isWater)continue;valsE.push(e);if(isWater&&Number.isFinite(d))valsD.push(d);
      }
      if(valsE.length>=4){const avg=valsE.reduce((a,b)=>a+b,0)/valsE.length;nextE[r][c]=centerE*.58+avg*.42;}
      if(isWater&&valsD.length>=4){const avg=valsD.reduce((a,b)=>a+b,0)/valsD.length;nextD[r][c]=centerD*.58+avg*.42;}
    }
    elevations=nextE;depths=nextD;
  }
  return {...grid,elevations,depths};
}
function bathyContourLevels(maxDepth){return [2,5,10,15,20,30,40,50,75,100,150].filter(v=>v<maxDepth*.98);}
function bathyContourSegments(scene,level){
  const out=[];
  const edgePoint=(a,b)=>{const da=a?.depth,db=b?.depth;if(!Number.isFinite(da)||!Number.isFinite(db)||(da-level)*(db-level)>0||da===db)return null;const t=(level-da)/(db-da);if(t<0||t>1)return null;return {x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,z:a.z+(b.z-a.z)*t,depth:level};};
  for(let r=0;r<scene.grid.height-1;r++)for(let c=0;c<scene.grid.width-1;c++){
    const a=scene.vertices[r][c],b=scene.vertices[r][c+1],d=scene.vertices[r+1][c],e=scene.vertices[r+1][c+1];if(!a||!b||!d||!e)continue;
    const pts=[edgePoint(a,b),edgePoint(b,e),edgePoint(e,d),edgePoint(d,a)].filter(Boolean);if(pts.length===2)out.push([pts[0],pts[1]]);else if(pts.length===4){out.push([pts[0],pts[1]],[pts[2],pts[3]]);}
  }
  return out;
}
function buildBathyScene(grid){
  const smoothPasses=2;grid=smoothBathymetryGrid(grid,smoothPasses);
  const frame=bathyLocalFrame(grid),vertices=[];
  const lonForCol=i=>grid.west+(grid.east-grid.west)*i/Math.max(1,grid.width-1);
  const latForRow=i=>grid.north-(grid.north-grid.south)*i/Math.max(1,grid.height-1);
  const depthCap=Math.max(10,Math.min(180,Math.ceil(Math.max(1,grid.maxDepth||0)/10)*10));
  const landCap=Math.max(12,Math.min(140,Math.ceil(Math.min(grid.maxLand||0,140)/10)*10||20));
  for(let r=0;r<grid.height;r++){
    const row=[];
    for(let c=0;c<grid.width;c++){
      const elevation=grid.elevations[r]?.[c],depth=grid.depths[r]?.[c];
      row.push(Number.isFinite(elevation)?{x:frame.xForLon(lonForCol(c)),y:frame.yForLat(latForRow(r)),z:elevation,depth:Number.isFinite(depth)?depth:null,sea:Number.isFinite(depth),row:r,col:c}:null);
    }
    vertices.push(row);
  }
  const widthM=Math.abs(frame.xForLon(grid.east)-frame.xForLon(grid.west)),heightM=Math.abs(frame.yForLat(grid.north)-frame.yForLat(grid.south));
  const maxXY=Math.max(1,widthM,heightM),verticalSpan=Math.max(20,depthCap+landCap);
  const verticalExaggeration=bathyClamp((maxXY/verticalSpan)*.105,1.45,4.2);
  const triangles=[];
  const addTri=(a,b,c)=>{const vals=[a,b,c].filter(Boolean);if(vals.length!==3)return;const seaCount=vals.filter(v=>v.sea).length;const avgDepth=vals.reduce((n,v)=>n+(v.depth||0),0)/3;const avgZ=vals.reduce((n,v)=>n+v.z,0)/3;triangles.push({v:vals,sea:seaCount>=2,depth:avgDepth,z:avgZ});};
  for(let r=0;r<grid.height-1;r++)for(let c=0;c<grid.width-1;c++){const a=vertices[r][c],b=vertices[r][c+1],d=vertices[r+1][c],e=vertices[r+1][c+1];addTri(a,b,e);addTri(a,e,d);}
  $('bathyDepthMax').textContent=`${depthCap} m+`;
  const contourLevels=bathyContourLevels(depthCap);
  return {grid,frame,vertices,triangles,depthCap,landCap,widthM,heightM,maxXY,verticalExaggeration,contourLevels};
}
function bathyProject(scene,v,w,h,view=bathyView){
  const yaw=view.yaw,pitch=view.pitch,cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const nx=v.x/scene.maxXY,ny=v.y/scene.maxXY,nz=(v.z*scene.verticalExaggeration)/scene.maxXY;
  const rx=nx*cy-ny*sy,ry=nx*sy+ny*cy;
  const py=ry*cp+nz*sp,depth=ry*sp-nz*cp;
  const scale=Math.min(w,h)*.76*view.zoom;
  return {x:w*.5+rx*scale,y:h*.56-py*scale,depth};
}
function bathyEnsureCanvasSize(canvas){
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(2,Math.max(1,window.devicePixelRatio||1));
  const width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr));
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  const ctx=canvas.getContext('2d',{alpha:false});ctx.setTransform(dpr,0,0,dpr,0,0);return {ctx,w:rect.width,h:rect.height,dpr};
}
function renderBathyCanvas(){
  const canvas=$('bathyCanvas');if(!canvas||!bathyScene||!$('bathyPanel')?.open)return;
  const {ctx,w,h}=bathyEnsureCanvasSize(canvas),scene=bathyScene;if(w<20||h<20)return;
  const bg=ctx.createLinearGradient(0,0,0,h);bg.addColorStop(0,'#12332b');bg.addColorStop(1,'#061713');ctx.fillStyle=bg;ctx.fillRect(0,0,w,h);
  const polys=scene.triangles.map(t=>{const p=t.v.map(v=>bathyProject(scene,v,w,h));return {t,p,d:(p[0].depth+p[1].depth+p[2].depth)/3};}).sort((a,b)=>a.d-b.d);
  for(const item of polys){const {t,p}=item;const shade=.86+bathyClamp((item.d+1)*.09,0,.22);ctx.beginPath();ctx.moveTo(p[0].x,p[0].y);ctx.lineTo(p[1].x,p[1].y);ctx.lineTo(p[2].x,p[2].y);ctx.closePath();ctx.fillStyle=t.sea?bathySeaColor(t.depth,scene.depthCap,shade):bathyLandColor(Math.max(0,t.z),scene.landCap,shade);ctx.fill();ctx.strokeStyle=t.sea?'rgba(210,248,255,.13)':'rgba(156,201,179,.10)';ctx.lineWidth=.55;ctx.stroke();}
  // Sea-level coastline accent where sign changes between adjacent samples.
  ctx.strokeStyle='rgba(183,242,245,.72)';ctx.lineWidth=1.15;ctx.beginPath();
  for(let r=0;r<scene.grid.height;r++)for(let c=0;c<scene.grid.width-1;c++){const a=scene.vertices[r][c],b=scene.vertices[r][c+1];if(a&&b&&a.sea!==b.sea){const pa=bathyProject(scene,{x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:0},w,h);ctx.moveTo(pa.x-1,pa.y);ctx.lineTo(pa.x+1,pa.y);}}
  ctx.stroke();
  // FjordSpot-like readable depth contours on top of the mesh.
  for(const level of scene.contourLevels||[]){const segments=bathyContourSegments(scene,level);ctx.beginPath();for(const seg of segments){const a=bathyProject(scene,seg[0],w,h),b=bathyProject(scene,seg[1],w,h);ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}ctx.strokeStyle=level<=10?'rgba(225,252,255,.42)':'rgba(203,240,248,.28)';ctx.lineWidth=level<=10?1.05:.75;ctx.stroke();}
  bathyProjectedZones=[];
  const zones=latestZones.filter(v=>v?.marker&&v.marker.lon>=scene.grid.west&&v.marker.lon<=scene.grid.east&&v.marker.lat>=scene.grid.south&&v.marker.lat<=scene.grid.north).slice(0,10);
  zones.forEach((zone,index)=>{const z=(bathyGridValueAt(scene.grid,zone.marker.lon,zone.marker.lat)??0)+2;const p=bathyProject(scene,{x:scene.frame.xForLon(zone.marker.lon),y:scene.frame.yForLat(zone.marker.lat),z},w,h);bathyProjectedZones.push({x:p.x,y:p.y,id:zone.id});ctx.beginPath();ctx.arc(p.x,p.y,8,0,Math.PI*2);ctx.fillStyle=threeDFeatureColor(zone);ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#fff';ctx.stroke();ctx.font='700 11px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='bottom';ctx.fillStyle='#fff';ctx.shadowColor='rgba(0,0,0,.8)';ctx.shadowBlur=3;ctx.fillText(`${index+1} · ${Math.round(zone.score||0)}`,p.x,p.y-10);ctx.shadowBlur=0;});
  const center=map.getCenter();if(center.lng>=scene.grid.west&&center.lng<=scene.grid.east&&center.lat>=scene.grid.south&&center.lat<=scene.grid.north){const z=(bathyGridValueAt(scene.grid,center.lng,center.lat)??0)+3;const p=bathyProject(scene,{x:scene.frame.xForLon(center.lng),y:scene.frame.yForLat(center.lat),z},w,h);ctx.beginPath();ctx.arc(p.x,p.y,6,0,Math.PI*2);ctx.fillStyle='#ef4444';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}
  ctx.font='600 11px system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillStyle='rgba(222,244,234,.88)';const source=scene.grid.waterType==='freshwater'?`NVE · ${scene.grid.lakeName||'oppmålt vann'}`:'Kartverket';ctx.fillText(`${source} · interaktiv 3D-bunn`,12,h-14);
}
function bathyCamera(kind='pitch'){
  if(kind==='top'){bathyView.yaw=0;bathyView.pitch=0;bathyView.zoom=.96;}
  else{bathyView.yaw=-.55;bathyView.pitch=.88;bathyView.zoom=1;}
  renderBathyCanvas();
}
function bathyResetView(){bathyView.yaw=-.55;bathyView.pitch=.88;bathyView.zoom=1;renderBathyCanvas();}
function bindBathyCanvas(){
  const canvas=$('bathyCanvas');if(!canvas||canvas.dataset.bound==='1')return;canvas.dataset.bound='1';
  const point=e=>({x:e.clientX,y:e.clientY});
  canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture?.(e.pointerId);bathyView.pointers.set(e.pointerId,point(e));bathyView.moved=false;if(bathyView.pointers.size===2){const q=[...bathyView.pointers.values()];bathyView.lastPinch=Math.hypot(q[0].x-q[1].x,q[0].y-q[1].y);}});
  canvas.addEventListener('pointermove',e=>{const prev=bathyView.pointers.get(e.pointerId);if(!prev)return;const now=point(e),dx=now.x-prev.x,dy=now.y-prev.y;bathyView.pointers.set(e.pointerId,now);if(Math.abs(dx)+Math.abs(dy)>2)bathyView.moved=true;if(bathyView.pointers.size===1){bathyView.yaw+=dx*.009;bathyView.pitch=bathyClamp(bathyView.pitch-dy*.006,0,1.28);renderBathyCanvas();}else if(bathyView.pointers.size>=2){const q=[...bathyView.pointers.values()].slice(0,2),dist=Math.hypot(q[0].x-q[1].x,q[0].y-q[1].y);if(bathyView.lastPinch>0)bathyView.zoom=bathyClamp(bathyView.zoom*(dist/bathyView.lastPinch),.58,2.7);bathyView.lastPinch=dist;renderBathyCanvas();}});
  const end=e=>{const pos=point(e);bathyView.pointers.delete(e.pointerId);if(bathyView.pointers.size<2)bathyView.lastPinch=0;if(!bathyView.moved){let best=null;for(const z of bathyProjectedZones){const d=Math.hypot(z.x-(pos.x-canvas.getBoundingClientRect().left),z.y-(pos.y-canvas.getBoundingClientRect().top));if(d<28&&(!best||d<best.d))best={...z,d};}if(best)selectZone(best.id,{scroll:false});}};
  canvas.addEventListener('pointerup',end);canvas.addEventListener('pointercancel',end);
  canvas.addEventListener('wheel',e=>{e.preventDefault();bathyView.zoom=bathyClamp(bathyView.zoom*(e.deltaY>0?.92:1.08),.58,2.7);renderBathyCanvas();},{passive:false});
  canvas.addEventListener('dblclick',e=>{e.preventDefault();bathyResetView();});
  if('ResizeObserver'in window){bathyResizeObserver=new ResizeObserver(()=>renderBathyCanvas());bathyResizeObserver.observe(canvas);}
}
async function refreshBathy3D(){
  if(!bathyActive||!$('bathyPanel')?.open)return;const token=++bathyLoadToken,status=$('bathyStatus'),summary=$('bathySummaryStatus'),empty=$('bathyEmpty');
  const freshwater=freshwaterFishTypes.has($('fishType')?.value);if(status)status.textContent='Henter bunn for kartutsnittet …';if(summary)summary.textContent='Laster …';if(empty){empty.hidden=false;empty.textContent=freshwater?'Henter oppmålte NVE-dybder …':'Henter Kartverkets høyde- og dybdedata …';}
  try{
    const grid=await fetchBathymetryGrid();if(token!==bathyLoadToken||!bathyActive)return;
    bathyLastGrid=grid;bathyScene=buildBathyScene(grid);bathyPlotReady=true;bindBathyCanvas();
    requestAnimationFrame(()=>{renderBathyCanvas();if(empty)empty.hidden=true;});
    const pointCount=latestZones.filter(v=>v?.marker&&v.marker.lon>=grid.west&&v.marker.lon<=grid.east&&v.marker.lat>=grid.south&&v.marker.lat<=grid.north).slice(0,10).length;
    const sourceLabel=grid.waterType==='freshwater'?`NVE 3D · ${grid.lakeName||'innsjø'}`:'Kartverket 3D';
    if(status)status.textContent=`${sourceLabel} · ca. ${grid.sampling||'–'} m rutenett · ${pointCount} fiskepunkt`;
    if(summary)summary.textContent=`Klar · ${grid.waterType==='freshwater'?'NVE oppmålt':'Kartverket'} · ca. ${grid.sampling||'–'} m`;
  }catch(error){if(token!==bathyLoadToken)return;bathyPlotReady=false;bathyScene=null;if(status)status.textContent='3D bunn kunne ikke lastes';if(summary)summary.textContent='Kunne ikke laste';if(empty){empty.hidden=false;empty.textContent=`${error.message}`;}if(!freshwaterFishTypes.has($('fishType')?.value))setWarning('bathy',`3D bunn kunne ikke oppdateres: ${error.message}`);else clearWarning('bathy');}
}
async function enableBathy3D(){
  bathyActive=true;bindBathyCanvas();
  await refreshBathy3D();
}
function disableBathy3D(){bathyActive=false;bathyLoadToken++;clearTimeout(bathyRefreshTimer);const summary=$('bathySummaryStatus');if(summary)summary.textContent=bathyPlotReady?'Klar – trykk for å åpne':'Trykk for å åpne';}
function scheduleBathyRefresh(delay=650){if(!isBathy3DMode())return;clearTimeout(bathyRefreshTimer);bathyRefreshTimer=setTimeout(()=>refreshBathy3D(),delay);}
function syncBathyZones(){if(isBathy3DMode()&&bathyPlotReady&&bathyScene)renderBathyCanvas();}


const labels = { vind:'Vind', skydekke:'Skydekke', kyst:'Kyst', vannkant:'Vannkant', eksponering:'Eksponering', temperatur:'Temperatur', lufttemperatur:'Lufttemperatur', tidspunkt:'Tidspunkt', dybde:'Dybde', storfisk:'Stor fisk', lufttrykk:'Lufttrykk', sjoetemperatur:'Sjøtemp', boelger:'Bølger', havstroem:'Havstrøm', tidevann:'Tidevann', maane:'Måne', personlig:'Mine fangster', habitat:'Habitat', forhold:'Nå' };
const freshwaterFishTypes = new Set(['orret','abbor','gjedde','all']);
const catchStorageKey='fiste-guiden-catch-log-v1';
const analysisCacheKey='fiste-guiden-last-analysis-v39';
const fishLabels={all:'Ørret + abbor',orret:'Ørret',abbor:'Abbor',gjedde:'Gjedde',sjoorret:'Sjøørret',makrell:'Makrell',sei:'Sei'};
const speciesColors={sjoorret:'#ef4444',makrell:'#3b82f6',sei:'#22c55e'};
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
  const analysisBase=currentAnalysisBase();
  if(!analysisBase||!radius) return;
  baseRadiusCircle=L.circle([analysisBase.lat,analysisBase.lon],{radius,color:'#38d477',weight:2,dashArray:'7 7',fillColor:'#38d477',fillOpacity:.045,interactive:false}).addTo(map);
}
function focusBaseRadius(){
  const radius=Number($('baseRadius').value)||0;
  const analysisBase=currentAnalysisBase();
  if(!analysisBase||!radius) return;
  updateBaseRadiusCircle();
  map.fitBounds(radiusBounds(analysisBase,radius*1.08),{padding:[28,28],maxZoom:radius<=250?16:radius<=500?15:radius<=1000?14:13});
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
  sync3DReferenceAndLive();
  saveUiState();
  setState('ready','Base fjernet · avstandsfilter er slått av.');
  loadZones({immediate:true});
}
function setBasePoint(latlng,{label='Base',focus=true}={}){
  basePoint={lat:Number(latlng.lat),lon:Number(latlng.lng)};
  if(baseMarker) baseMarker.remove();
  baseMarker=L.circleMarker([basePoint.lat,basePoint.lon],{radius:7,color:'#fff',weight:2,fillColor:'#f2c94c',fillOpacity:.95}).addTo(map).bindTooltip(label,{direction:'top'});
  $('setBase').textContent='✓ Base satt · fjern';
  $('setBase').classList.add('base-active');
  $('setBase').setAttribute('aria-pressed','true');
  saveUiState();
  updateBaseRadiusCircle();
  sync3DReferenceAndLive();
  if(focus) focusBaseRadius();
  loadZones({immediate:true});
}
function drawNavigation(zones=[]){
  navigationLayer.clearLayers();
  if(!zones.length) return;
  const best=zones[0];
  const analysisBase=currentAnalysisBase();
  if(analysisBase&&Number.isFinite(best.distanceM)){
    L.polyline([[analysisBase.lat,analysisBase.lon],[best.marker.lat,best.marker.lon]],{color:'#38d477',weight:4,dashArray:'8 8',opacity:.9}).addTo(navigationLayer);
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
  $('goalBadge').textContent=$('fishType').value==='all'?'Alle sjøarter':($('fishGoal').value==='big'?'STOR FISK':'Mest fisk');
  if(!zones.length){ holder.innerHTML='<p class="muted">Ingen anbefalt sone innen valgt utsnitt/avstand. Øk radius eller flytt kartet litt.</p>'; return; }
  const zone=zones[0], lure=zone.lure||{}, w=lure.wobbler||{};
  const big=$('fishGoal').value==='big';
  const allMode=$('fishType').value==='all';
  const zoneFish=zone.fishType||$('fishType').value;
  const zoneFishLabel=zone.fishLabel||fishLabels[zoneFish]||'';
  holder.innerHTML=`<div class="best-now-grid"><div class="best-now-score"><strong>${zone.score}</strong><span>/100</span></div><div><span class="best-now-kicker">${big&&!allMode?'🏆 STOR FISK':'🎯 BEST MATCH'} · ${escapeHtml(zoneFishLabel)}</span><h3>${escapeHtml(zone.waterName||zone.name)}</h3><p>${escapeHtml(zone.reason||'')}</p></div></div><div class="best-now-facts"><article><span>${liveActive?'Avstand fra deg':'Avstand fra base'}</span><b>${formatDistance(zone.distanceM)}</b></article><article><span>Bruk nå</span><b>${escapeHtml(lure.type||'Anbefalt agn')} · ${escapeHtml(lure.weight||'')}</b></article><article><span>Farge</span><b>${escapeHtml(lure.color||'')}</b></article>${zone.personalAdjustment?`<article><span>Mine fangstdata</span><b>+${zone.personalAdjustment} poeng</b></article>`:''}</div><div class="best-now-actions"><button type="button" id="goBest">VIS PÅ KART</button><span>Orange linje = praktisk kastretning langs vannkanten.</span></div>`;
  $('goBest')?.addEventListener('click',()=>{ focusMapOnZone(zone,16); selectZone(zone.id,{scroll:true}); });
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
  const freshwater=freshwaterFishTypes.has($('fishType').value);
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
  const freshwater=freshwaterFishTypes.has($('fishType').value);
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
  if(!showConditionVectors||freshwaterFishTypes.has($('fishType').value)||!latestWeather) return;
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
    clearWarning('ramps');
    if(!(data.ramps||[]).length){$('boatRampToggle').title='Ingen OSM-registrerte båtramper i dette utsnittet.';}else $('boatRampToggle').title='';
  }catch(error){clearWarning('ramps');if(showBoatRamps)$('boatRampToggle').title='Båtramper kunne ikke hentes akkurat nå.';}
}
async function loadHydrologyAtCenter() {
  if(!freshwaterFishTypes.has($('fishType').value)) return;
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
  $('analysisSources').innerHTML=`<b>Værmodell:</b> ${weather?.source || 'MET Norway'} · ${modelTime}<br><b>Analyse:</b> ${analysisTime} · ${freshwater ? `${escapeHtml(stats.freshwaterLookup||'NVE/OSM vanngeometri')} · NVE dybdekart brukes automatisk der oppmålt data finnes` : `OSM-kystgeometri · EMODnet-dybde/struktur · Open-Meteo Marine · habitatdekning ${Number.isFinite(stats.habitatCoveragePercent)?stats.habitatCoveragePercent+' %':'–'}`}`;
}

function freshwaterDepthBoundsKey(){
  const b=map.getBounds(),z=Math.max(7,Math.min(18,Math.round(map.getZoom())));
  const vals=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(v=>Number(v).toFixed(4));
  return `${vals.join(',')}@${z}`;
}
function clearFreshwaterDepthOverlay(){
  freshwaterDepthController?.abort();freshwaterDepthGridController?.abort();freshwaterDepthController=null;freshwaterDepthGridController=null;freshwaterDepthKey='';freshwaterDepthInfo=null;freshwaterDepthGrid=null;freshwaterDepthLayer.clearLayers();
  if(map.hasLayer(freshwaterDepthLayer))map.removeLayer(freshwaterDepthLayer);
  clearWarning('nve-map');
}
function nveDepthBandColor(depth,maxDepth=30){
  if(!Number.isFinite(depth))return [0,0,0,0];
  const d=Math.max(0,depth),cap=Math.max(5,maxDepth||30);
  if(d<=2)return [191,244,250,190];
  if(d<=5)return [118,223,241,198];
  if(d<=10)return [53,181,225,204];
  if(d<=20)return [24,118,191,210];
  if(d<=40)return [13,76,145,214];
  return [5,44,99,218];
}
function sampleDepthGrid(grid,x,y){
  const gx=x*(grid.width-1),gy=y*(grid.height-1),x0=Math.floor(gx),x1=Math.min(grid.width-1,x0+1),y0=Math.floor(gy),y1=Math.min(grid.height-1,y0+1),tx=gx-x0,ty=gy-y0;
  const cells=[[x0,y0,(1-tx)*(1-ty)],[x1,y0,tx*(1-ty)],[x0,y1,(1-tx)*ty],[x1,y1,tx*ty]];let sum=0,w=0;
  for(const [cx,cy,cw] of cells){const d=grid.depths?.[cy]?.[cx];if(Number.isFinite(d)){sum+=d*cw;w+=cw;}}
  return w>.35?sum/w:null;
}
function renderFreshwaterDepthRaster(grid){
  if(!grid?.depths||!Number.isFinite(grid.width)||!Number.isFinite(grid.height))return;
  const aspect=Math.max(.35,Math.min(2.8,(grid.east-grid.west)/Math.max(.000001,grid.north-grid.south)));
  const height=360,width=Math.max(180,Math.min(720,Math.round(height*aspect)));
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d'),img=ctx.createImageData(width,height),data=img.data;
  for(let py=0;py<height;py++)for(let px=0;px<width;px++){
    const d=sampleDepthGrid(grid,px/Math.max(1,width-1),py/Math.max(1,height-1));const c=nveDepthBandColor(d,grid.maxDepth);const i=(py*width+px)*4;data[i]=c[0];data[i+1]=c[1];data[i+2]=c[2];data[i+3]=c[3];
  }
  ctx.putImageData(img,0,0);
  const overlay=L.imageOverlay(canvas.toDataURL('image/png'),[[grid.south,grid.west],[grid.north,grid.east]],{opacity:.78,interactive:false,className:'freshwater-depth-raster'}).addTo(freshwaterDepthLayer);
  try{overlay.bringToBack();}catch{}
  return overlay;
}
function lineCoords(feature){const g=feature?.geometry||{};return g.type==='LineString'?[g.coordinates]:g.type==='MultiLineString'?(g.coordinates||[]):[];}
function lineVertexCount(feature){return lineCoords(feature).reduce((n,line)=>n+(line?.length||0),0);}
function lineMidpoint(feature){const lines=lineCoords(feature).filter(line=>Array.isArray(line)&&line.length);if(!lines.length)return null;const line=lines.slice().sort((a,b)=>b.length-a.length)[0],p=line[Math.floor(line.length/2)];return Array.isArray(p)&&p.length>=2?{lon:Number(p[0]),lat:Number(p[1])}:null;}
function addNveDepthLabels(features=[],maxDepth=null){
  const byDepth=new Map();
  for(const f of features){const d=Number(f?.properties?.dybde_m);if(!Number.isFinite(d)||d<=0)continue;const key=Number(d.toFixed(1));const old=byDepth.get(key);if(!old||lineVertexCount(f)>lineVertexCount(old))byDepth.set(key,f);}
  let depths=[...byDepth.keys()].sort((a,b)=>a-b);const cap=Number(maxDepth)||Math.max(0,...depths);
  const major=d=>cap<=8?d>=1:cap<=20?(Math.abs(d%2)<.15||Math.abs(d%5)<.15):(Math.abs(d%5)<.15||d>=20&&Math.abs(d%10)<.15);
  depths=depths.filter(major).slice(0,12);
  for(const d of depths){const p=lineMidpoint(byDepth.get(d));if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lon))continue;const label=L.marker([p.lat,p.lon],{interactive:false,keyboard:false,icon:L.divIcon({className:'nve-depth-label',html:`<span>${String(d).replace('.',',')} m</span>`,iconSize:[44,18],iconAnchor:[22,9]})});label.addTo(freshwaterDepthLayer);}
}
function addNveDepthFeature(feature){
  const depth=Number(feature?.properties?.dybde_m),kind=feature?.properties?.fisteKind||'';
  if(kind==='point'||feature?.geometry?.type==='Point'){
    const c=feature.geometry?.coordinates;if(!Array.isArray(c)||c.length<2)return;
    const marker=L.circleMarker([Number(c[1]),Number(c[0])],{radius:2.8,color:'#e8fcff',weight:1,fillColor:'#0d7fb9',fillOpacity:.9,interactive:true});
    if(Number.isFinite(depth))marker.bindTooltip(`${depth.toFixed(depth%1?1:0)} m`,{direction:'top'});marker.addTo(freshwaterDepthLayer);return;
  }
  const color=Number.isFinite(depth)?(depth<=2?'#d8fbff':depth<=5?'#81e2ef':depth<=10?'#35b9df':depth<=20?'#1776bc':'#093d82'):'#159fe0';
  const major=Number.isFinite(depth)&&(Math.abs(depth%5)<.01||depth>=20&&Math.abs(depth%10)<.01);
  const line=L.geoJSON(feature,{style:{color,weight:major?2.5:1.45,opacity:.96,interactive:true}});
  if(Number.isFinite(depth))line.bindTooltip(`${depth.toFixed(depth%1?1:0)} m`,{sticky:true,direction:'top'});line.addTo(freshwaterDepthLayer);
}
async function fetchFreshwaterDepthGridForMap(bbox,zoom,signal,focus=null){
  // NVE interpolation is local on the server after contours are fetched, so standard grid quality is affordable even on phone.
  const quality='standard',focusQuery=focus&&Number.isFinite(focus.lat)&&Number.isFinite(focus.lon)?`&focusLat=${focus.lat.toFixed(6)}&focusLon=${focus.lon.toFixed(6)}`:'';
  const response=await fetch(`/api/bathymetry-grid?bbox=${encodeURIComponent(bbox)}&zoom=${zoom}&quality=${quality}&water=freshwater${focusQuery}`,{headers:{Accept:'application/json'},signal,cache:'no-store'});
  if(!response.ok)return null;const grid=await response.json().catch(()=>null);return grid?.depths?grid:null;
}
async function loadFreshwaterDepthOverlay({force=false}={}){
  const freshwater=freshwaterFishTypes.has($('fishType')?.value),style=$('mapStyle')?.value;
  if(!freshwater||style!=='fishing'){clearFreshwaterDepthOverlay();return null;}
  if(!map.hasLayer(freshwaterDepthLayer))freshwaterDepthLayer.addTo(map);
  const key=freshwaterDepthBoundsKey();if(!force&&key===freshwaterDepthKey&&freshwaterDepthInfo)return freshwaterDepthInfo;
  freshwaterDepthKey=key;freshwaterDepthController?.abort();freshwaterDepthGridController?.abort();freshwaterDepthController=new AbortController();freshwaterDepthGridController=new AbortController();
  const notice=document.querySelector('.map-notice');if(notice)notice.textContent='Henter NVE-dybdekart …';
  const b=map.getBounds(),bbox=[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].join(','),zoom=Math.max(7,Math.min(18,Math.round(map.getZoom())));
  const focus=currentAnalysisBase()||map.getCenter(),focusQuery=focus&&Number.isFinite(focus.lat)&&Number.isFinite(focus.lon)?`&focusLat=${focus.lat.toFixed(6)}&focusLon=${focus.lon.toFixed(6)}`:'';
  try{
    const response=await fetch(`/api/freshwater-depth-overlay?bbox=${encodeURIComponent(bbox)}&zoom=${zoom}${focusQuery}`,{headers:{Accept:'application/json'},signal:freshwaterDepthController.signal,cache:'no-store'});
    const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'NVE dybdedata kunne ikke hentes');
    freshwaterDepthLayer.clearLayers();freshwaterDepthInfo=data;freshwaterDepthGrid=null;clearWarning('nve-map');
    if(data.available){
      if(Array.isArray(data?.lake?.features))L.geoJSON({type:'FeatureCollection',features:data.lake.features},{style:{color:'#b8f4fb',weight:1.8,opacity:.88,fill:false,interactive:false}}).addTo(freshwaterDepthLayer);
      for(const feature of data?.curves?.features||[])addNveDepthFeature(feature);
      for(const feature of data?.points?.features||[])addNveDepthFeature(feature);
      addNveDepthLabels(data?.curves?.features||[],data.maxDepth);
      const bits=[data.lakeName||'NVE-vann',`${data.curveCount||0} koter`];if(data.pointCount)bits.push(`${data.pointCount} målepunkter`);if(Number.isFinite(data.maxDepth))bits.push(`maks ${Number(data.maxDepth).toFixed(1).replace('.',',')} m`);if(data.surveyQuality?.grade)bits.push(`oppmålt ${data.surveyQuality.grade}`);
      if(notice)notice.textContent=`NVE OPPMÅLT · ${bits.join(' · ')}`;
      const requestKey=freshwaterDepthKey;
      fetchFreshwaterDepthGridForMap(bbox,zoom,freshwaterDepthGridController.signal,focus).then(grid=>{if(!grid||freshwaterDepthKey!==requestKey||$('mapStyle')?.value!=='fishing')return;freshwaterDepthGrid=grid;renderFreshwaterDepthRaster(grid);}).catch(()=>{});
    }else{
      if(Array.isArray(data?.lake?.features))L.geoJSON({type:'FeatureCollection',features:data.lake.features},{style:{color:'#7fb8c8',weight:1.2,opacity:.65,fill:false,dashArray:'5 5',interactive:false}}).addTo(freshwaterDepthLayer);
      if(notice)notice.textContent=`${data.lakeName||'Dette vannet'}: ingen oppmålte NVE-dybder. Viser detaljert topo uten falske dybdekoter.`;
    }
    updateMapLegend();return data;
  }catch(error){
    if(error?.name==='AbortError')return null;freshwaterDepthLayer.clearLayers();freshwaterDepthInfo=null;freshwaterDepthGrid=null;
    if(notice)notice.textContent='NVE-dybder kunne ikke hentes akkurat nå. Detaljert topo vises videre.';
    setWarning('nve-map','NVE-dybdekartet svarte ikke akkurat nå. Topokartet og fiskeanalysen fungerer fortsatt.');
    return null;
  }
}

function applyMapStyle() {
  const freshwater=freshwaterFishTypes.has($('fishType').value);
  const allowed=new Set(['fishing','topo','3d','satellite','chart']);
  let style=$('mapStyle').value;
  if(!allowed.has(style))style=freshwater?'fishing':'topo';
  if(freshwater&&style==='chart')style='fishing';
  $('mapStyle').value=style;
  for(const layer of [standardLayer,topoLayer,satelliteLayer,seaChartLayer,detailedDepthLayer]) if(map.hasLayer(layer)) map.removeLayer(layer);
  if(map.hasLayer(freshwaterDepthLayer))map.removeLayer(freshwaterDepthLayer);
  if(style==='3d'){
    topoLayer.addTo(map); // 2D fallback under the built-in 3D renderer
    enable3DMap();saveUiState();return;
  }
  disable3DMap();
  if(style==='fishing'){
    topoLayer.addTo(map);
    if(freshwater){freshwaterDepthLayer.addTo(map);loadFreshwaterDepthOverlay({force:true});}
    else detailedDepthLayer.addTo(map);
  } else if(style==='chart'&&!freshwater) seaChartLayer.addTo(map);
  else if(style==='satellite') satelliteLayer.addTo(map);
  else topoLayer.addTo(map);
  if(!(freshwater&&style==='fishing'))clearFreshwaterDepthOverlay();
  saveUiState();
}

function updateMapLegend(){
  const legend=$('mapLegend');
  if(!legend) return;
  if($('fishType').value==='all'){
    legend.innerHTML='<span><i class="species-orret"></i> ørret</span><span><i class="species-abbor"></i> abbor</span><span class="nve-depth-legend"><i class="depth-gradient"></i> NVE dybde</span>';
  }else if(freshwaterFishTypes.has($('fishType').value)){
    const nve=$('mapStyle').value==='fishing'?'<span class="nve-depth-legend"><i class="depth-gradient"></i> NVE dybde</span>':'';
    legend.innerHTML=`<span><i class="best"></i> svært høy</span><span><i class="high"></i> høy</span><span><i class="moderate"></i> moderat</span>${nve}`;
  }else{
    legend.innerHTML='<span><i class="best"></i> svært høy</span><span><i class="high"></i> høy</span><span><i class="moderate"></i> moderat</span><span><i class="source-spot"></i> historisk omtalt</span><span><i class="no-fishing"></i> helårsforbud</span>';
  }
}

function updateWaterModeUI() {
  const fishType=$('fishType').value;
  const hasSelection=Object.hasOwn(fishLabels,fishType);
  const allMode=fishType==='all';
  const freshwater=freshwaterFishTypes.has(fishType);
  const fishingOption=$('mapStyle')?.querySelector('option[value="fishing"]');
  const chartOption=$('mapStyle')?.querySelector('option[value="chart"]');
  const threeDOption=$('mapStyle')?.querySelector('option[value="3d"]');
  if(fishingOption)fishingOption.textContent=freshwater?'Fiskekart – NVE dybder':'Fiskekart – sjødybder';
  if(chartOption){chartOption.disabled=freshwater;chartOption.hidden=freshwater;}
  if(threeDOption)threeDOption.textContent=freshwater?'3D bunn – NVE':'3D bunn / terreng';
  if($('mapStyle').value==='marine-depth') $('mapStyle').value='fishing';
  $('multiSpeciesCard').hidden=!allMode;
  $('insightsCard').hidden=allMode;
  $('fishGoal').disabled=allMode;
  if(allMode) $('fishGoal').value='numbers';
  if(freshwater&&$('mapStyle').value==='chart') $('mapStyle').value='fishing';
  $('conditionToggle').hidden=!hasSelection||freshwater;
  $('marineCard').hidden=!hasSelection||freshwater;
  $('hydrologyCard').hidden=!freshwater;
  if(!freshwater) clearFreshwaterDepthOverlay();
  if(freshwater){showConditionVectors=false;$('conditionToggle').setAttribute('aria-pressed','false');$('conditionToggle').classList.remove('layer-active');conditionLayer.clearLayers();}
  $('sourceSpotToggle').hidden=fishType!=='sjoorret';
  $('restrictionToggle').hidden=!hasSelection||freshwater;
  $('analysisMode').textContent=!hasSelection?'Velg fisketype for analyse':allMode?'Vestfjella · Ørret + abbor · MET Norway · NVE':freshwater ? 'Vestfjella · ferskvann · MET Norway · NVE' : 'Sjøanalyse · MET Norway · Kartverket';
  $('mask').textContent=!hasSelection?'Velg fisketype for å starte analysen.':allMode?'Kontrollerer ørret + abbor i vannet …':freshwater ? 'Kontrollerer innsjø/elv, NVE-dybde og vannkant …' : 'Kontrollerer sjø og kyst …';
  updateMapLegend();
  applyMapStyle();
  renderReferenceLayers();
  sync3DWaterMode();
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
  sync3DReferenceLayers();
}

async function loadReferenceLayers() {
  try {
    const [spotsResponse,restrictionsResponse]=await Promise.all([
      fetch('/data/kirkoy-seatrout-spots.json',{cache:'no-cache'}),
      fetch('/data/fishing-restrictions-2024.json',{cache:'no-cache'})
    ]);
    if(!spotsResponse.ok||!restrictionsResponse.ok) throw new Error('Kildelag kunne ikke lastes');
    [sourceSpotData,restrictionData]=await Promise.all([spotsResponse.json(),restrictionsResponse.json()]);
    renderReferenceLayers();
  } catch(error) {
    if($('fishType')?.value==='sjoorret')setWarning('reference-layers','Kildelag for Kirkøy/fredningsgrenser er midlertidig utilgjengelig.');
  }
}
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
  return `<div class="compact-popup"><div class="compact-popup-head"><span>${$('fishType').value==='all'?escapeHtml(zone.fishLabel||'Sjøart')+' · ':''}Sone ${index+1}</span><b>${zone.name}</b></div><div class="popup-score"><span>Fiskeforhold</span><b>${zone.score}/100</b><small>Veiledende rangering – ikke fangstsannsynlighet</small></div><div class="popup-factors">${strongestFactorsHtml(zone.breakdown)}</div><div class="popup-quality"><span>Datagrunnlag</span><b>${zone.dataQuality?.level || 'Begrenset'}</b><small>${zone.dataQuality?.summary || 'Kildestatus ukjent'}</small></div><div class="popup-primary"><img class="popup-lure-thumb zoomable-lure" src="${lure.image || '/lures/blue-silver-shallow.jpg'}" alt="${lure.name || 'Anbefalt sluk'} – ${lure.color || 'Sølv/blå'}" tabindex="0" role="button"><div><span>Ditt bildevalg · ${escapeHtml(lure.waterEnvironment?.label||'riktig vannmiljø')}</span><b>${lure.name ? `${lure.name} · ` : ''}${lure.type || 'Smal kystsluk'} · ${lure.weight || '18–22 g'}</b><small>${lure.color || 'Sølv/blå'}${lure.inventoryNote?`<br>På bildet: ${escapeHtml(lure.inventoryNote)}`:''}</small></div></div>${popupAlternativeLuresHtml(lure.alternatives)}<div class="popup-tactics"><b>Slukhøyde:</b> ${presentation.band||'Søk trinnvis'}<br><b>Opphengerflue:</b> ${fly.recommended?'Ja':'Nei'}${fly.recommended&&fly.color?` · ${fly.color}`:''}</div><button type="button" class="popup-details" data-zone="${zone.id}">Vis alle detaljer i listen</button></div>`;
}
function lureText(zone={}) { const lure=zone.lure||{}; return [lure.name,lure.type,lure.color,lure.weight].filter(Boolean).join(' '); }
function tokenOverlap(a,b) {
  const tokens=value=>new Set(String(value||'').toLocaleLowerCase('no-NO').replace(/[^a-z0-9æøå]+/gi,' ').split(/\s+/).filter(word=>word.length>=3));
  const left=tokens(a),right=tokens(b);let count=0;for(const token of left)if(right.has(token))count++;return count;
}
function applyPersonalLureHistory(zone={}) {
  const fish=zone.fishType||$('fishType')?.value,lure=zone.lure||{},candidates=Array.isArray(lure.candidates)?lure.candidates:[];
  if(!fish||fish==='all'||candidates.length<2)return zone;
  const entries=readCatchEntries().filter(entry=>entry?.fish===fish),sessions=entries.length,catches=entries.filter(entry=>entry?.result==='fangst'&&String(entry.lure||'').trim());
  if(sessions<3||catches.length<2)return zone;
  const bestCondition=Math.max(...candidates.map(c=>Number(c.conditionScore)||0));
  const evaluated=candidates.map((candidate,index)=>{
    const text=[candidate.name,candidate.type,candidate.color].filter(Boolean).join(' ');
    const matched=catches.filter(entry=>tokenOverlap(entry.lure,text)>0);
    const historyBoost=matched.length>=2?Math.min(6,matched.length*2):0;
    const condition=Number(candidate.conditionScore)||0;
    const eligible=condition>=bestCondition-8;
    return {...candidate,_index:index,_historyBoost:eligible?historyBoost:0,_historyMatches:matched.length,_combined:condition+(eligible?historyBoost:0)};
  }).sort((a,b)=>b._combined-a._combined||b.conditionScore-a.conditionScore||a._index-b._index);
  const selected=evaluated[0];if(!selected||selected._historyBoost<=0)return zone;
  const rest=evaluated.filter(c=>c.id!==selected.id).slice(0,6).map(c=>({id:c.id,name:c.name,type:c.type,color:c.color,image:c.image,inventoryNote:c.inventoryNote,ownedPhoto:true,matchScore:c.matchScore,conditionScore:c.conditionScore,matchReasons:c.matchReasons,weight:c.weight}));
  const personal=`Egen fangstlogg støtter dette valget (${selected._historyMatches} relevante fangster); grunnmatchen mot dagens forhold er fortsatt innenfor 8 poeng av beste kandidat.`;
  const nextLure={...lure,id:selected.id,name:selected.name,type:selected.type||lure.type,color:selected.color,image:selected.image,inventoryNote:selected.inventoryNote,matchScore:selected.matchScore,conditionScore:selected.conditionScore,matchReasons:selected.matchReasons,alternatives:rest,personalHistory:{matches:selected._historyMatches,boost:selected._historyBoost,reason:personal},reason:`${lure.reason||''} ${personal}`.trim()};
  return {...zone,lure:nextLure};
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
    const adjusted=Math.min(100,modelScore+adjustment);return {...zone,modelScore,personalAdjustment:adjustment,score:adjusted,analysis:zone.analysis?{...zone.analysis,total:adjusted,personalAdjustment:adjustment}:zone.analysis,breakdown:adjustment?{...zone.breakdown,personlig:adjustment}:zone.breakdown};
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
  downloadTextFile(`fiste-guiden-fangster-${new Date().toISOString().slice(0,10)}.gpx`,`<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Fiste guiden REV41" xmlns="http://www.topografix.com/GPX/1/1">${waypoints}</gpx>`,'application/gpx+xml');
  $('catchStatus').textContent=`Eksporterte ${entries.length} posisjoner som GPX.`;
}
function exportCatchJson() { const entries=readCatchEntries();downloadTextFile(`fiste-guiden-backup-${new Date().toISOString().slice(0,10)}.json`,JSON.stringify({version:1,exportedAt:new Date().toISOString(),entries},null,2),'application/json');$('catchStatus').textContent=`Backup med ${entries.length} loggposter er eksportert.`; }
function cacheAnalysis(data) { try{const c=map.getCenter();localStorage.setItem(analysisCacheKey,JSON.stringify({savedAt:new Date().toISOString(),fish:$('fishType').value,center:{lat:c.lat,lon:c.lng},data}));}catch{} }
function distanceKm(a,b){if(!a||!b)return Infinity;const R=6371,toRad=Math.PI/180,dLat=(b.lat-a.lat)*toRad,dLon=(b.lon-a.lon)*toRad,h=Math.sin(dLat/2)**2+Math.cos(a.lat*toRad)*Math.cos(b.lat*toRad)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
function readCachedAnalysis() { try{const cached=JSON.parse(localStorage.getItem(analysisCacheKey)||'null');if(!cached?.data||cached.fish!==$('fishType').value)return null;if(distanceKm(cached.center,map.getCenter())>35)return null;return cached;}catch{return null;} }
function applyAnalysisData(data,{cached=false,offline=false,errorMessage=''}={}) {
  latestWeather=data.weather||null;latestMarine=data.marine||null;latestMoon=data.moon||null;
  renderWeather(latestWeather);renderMarine(latestMarine,latestMoon);renderSources(latestWeather,data.stats||{});renderBestTimes(data.bestTimes||{});renderZones(data.zones||[]);renderConditionVectors();
  $('mask').textContent=data.stats?.waterMaskAvailable===false?'Vannkontrollen er midlertidig redusert.':`Aktiv · ${data.stats?.tested??0} kandidater kontrollert · ${data.stats?.rejected??0} forkastet`;
  const warnings=[...(data.warnings||[])].filter(Boolean).filter(item=>!/NVE har ikke registrert oppmålt dybdekart|NVE-dybde:/i.test(String(item)));
  setWarning('analysis',warnings.join(' '));
  if(cached){
    const saved=formatSourceTime(data.stats?.generatedAt);
    setWarning('analysis-fallback',offline?`Ingen nettforbindelse – viser sist lagrede analyse fra ${saved}.`:`Ny analyse kunne ikke hentes akkurat nå – viser sist lagrede analyse fra ${saved}.`);
  }else{clearWarning('analysis-fallback');clearWarning('analysis-error');}
}
function leanAlternativeLures(alternatives=[]){
  if(!Array.isArray(alternatives)||!alternatives.length)return '';
  return `<div class="lean-alt-grid">${alternatives.slice(0,3).map(alt=>`<article><img class="zoomable-lure" src="${escapeHtml(alt.image||'')}" alt="${escapeHtml(alt.name||alt.type||'Alternativ sluk')}" loading="lazy" tabindex="0"><div><b>${escapeHtml(alt.name||alt.type||'Alternativ')}</b><small>${escapeHtml(alt.color||'')}</small></div></article>`).join('')}</div>`;
}

const depthProfileCache=new Map();
function analysisScoreStripHtml(zone={}){
  const analysis=zone.analysis||{};
  const total=Number.isFinite(analysis.total)?analysis.total:Math.round(zone.score||0);
  const habitat=Number.isFinite(analysis.habitat)?analysis.habitat:null;
  const now=Number.isFinite(analysis.now)?analysis.now:null;
  const confidence=Number.isFinite(analysis.confidence)?analysis.confidence:zone.dataQuality?.confidence;
  return `<div class="analysis-score-strip"><span><small>TOTAL</small><b>${Math.round(total)}/100</b></span>${habitat!==null?`<span><small>HABITAT</small><b>${Math.round(habitat)}</b></span>`:''}${now!==null?`<span><small>NÅ</small><b>${Math.round(now)}</b></span>`:''}${Number.isFinite(confidence)?`<span><small>DATA</small><b>${Math.round(confidence)}%</b></span>`:''}</div>`;
}
function factorRowsHtml(factors=[]){
  if(!Array.isArray(factors)||!factors.length) return '<p class="muted">Ingen detaljer tilgjengelig for denne delen.</p>';
  return `<div class="analysis-factor-list">${factors.slice().sort((a,b)=>(b.weight||0)-(a.weight||0)).map(f=>`<div><span>${escapeHtml(f.label||f.key||'Faktor')}</span><i><em style="width:${Math.max(0,Math.min(100,Number(f.score)||0))}%"></em></i><b>${Math.round(Number(f.score)||0)}</b></div>`).join('')}</div>`;
}
function habitatDetailHtml(habitat={}){
  if(!habitat?.serviceAvailable) return '<p class="muted">Marine naturtypedata var ikke tilgjengelig i denne analysen. Sonen rangeres fortsatt på dybde, kyststruktur og liveforhold.</p>';
  const signals=Array.isArray(habitat.signals)?habitat.signals:[];
  return `<div class="habitat-pills">${signals.length?signals.map(x=>`<span>${escapeHtml(x)}</span>`).join(''):'<span>Ingen registrert naturtype akkurat på punktet</span>'}</div><p class="detail-caveat">Kildedekning ${Math.round(habitat.serviceCoveragePercent||0)} %. Manglende registrering betyr ikke at naturtypen ikke finnes fysisk.</p>`;
}
function legalDetailHtml(legal={}){
  const blocked=Boolean(legal.blocked);
  return `<div class="legal-status ${blocked?'blocked':'clear'}"><b>${blocked?'⛔ '+escapeHtml(legal.status||'Fiskeforbud'):'✓ '+escapeHtml(legal.status||'Ingen kjent hard sperre')}</b>${legal.name?`<span>${escapeHtml(legal.name)}</span>`:''}<p>${escapeHtml(legal.caveat||'Kontroller alltid lokale regler før fiske.')}</p>${legal.url?`<a href="${escapeHtml(legal.url)}" target="_blank" rel="noopener noreferrer">Åpne forskriften</a>`:''}</div>`;
}
function confidenceDetailHtml(zone={}){
  const quality=zone.dataQuality||{},components=quality.components||zone.analysis?.confidenceComponents||[];
  return `<p class="confidence-lead"><b>${Math.round(quality.confidence??zone.analysis?.confidence??0)} %</b> · ${escapeHtml(quality.level||'Begrenset')}</p>${factorRowsHtml(components.map(c=>({label:c.label,score:c.score,weight:c.weight})))}<p class="detail-caveat">Scoren og datadekningen er to forskjellige ting. Høy fiskescore med lav datadekning skal tolkes mer forsiktig.</p>`;
}
function quickStructureHtml(zone={}){
  const s=zone.structure||{},d=zone.depth||{};
  const depth=Number.isFinite(d.meters)?`${d.meters.toFixed(1).replace('.',',')} m`:'ukjent';
  const slope=Number.isFinite(s.slopeMPer100)?`${s.slopeMPer100.toFixed(1).replace('.',',')} m / 100 m`:'ikke beregnet';
  const nve=String(d.source||'').includes('NVE');return `<div class="structure-summary"><span><small>Dybde ved punkt</small><b>${depth}</b></span><span><small>Struktur</small><b>${escapeHtml(s.label||'Ikke beregnet')}</b></span><span><small>Helning</small><b>${slope}</b></span></div><div class="depth-profile-slot" data-depth-profile><p class="muted">${nve?'NVE-dybden brukes direkte i rangering, BiteGuide og 3D-bunn.':'Åpne menyen for å hente detaljert modellert tverrprofil.'}</p></div>`;
}
function depthProfileSvgHtml(data={}){
  const samples=(data.samples||[]).filter(s=>Number.isFinite(s.meters)&&Number.isFinite(s.distanceM));
  if(samples.length<2) return `<p class="muted">For få dybdedata til å lage profil.</p><p class="detail-caveat">${escapeHtml(data.caveat||'')}</p>`;
  const maxD=Math.max(1,...samples.map(s=>s.meters)),maxX=Math.max(1,...samples.map(s=>s.distanceM));
  const points=samples.map(s=>`${18+(s.distanceM/maxX)*304},${16+(s.meters/maxD)*66}`).join(' ');
  const labels=samples.map(s=>`<text x="${18+(s.distanceM/maxX)*304}" y="96" text-anchor="middle">${s.distanceM}m</text>`).join('');
  const dots=samples.map(s=>`<g><circle cx="${18+(s.distanceM/maxX)*304}" cy="${16+(s.meters/maxD)*66}" r="3"></circle><text x="${18+(s.distanceM/maxX)*304}" y="${Math.max(11,12+(s.meters/maxD)*66)}" text-anchor="middle">${s.meters.toFixed(1)}</text></g>`).join('');
  return `<div class="depth-profile"><div class="depth-profile-head"><b>${escapeHtml(data.label||'Dybdeprofil')}</b><span>${escapeHtml(data.kind||'Modellert')} · ca. ${Number(data.resolutionM)||125} m</span></div><svg viewBox="0 0 340 104" role="img" aria-label="Modellert dybdeprofil"><line x1="18" y1="16" x2="322" y2="16" class="profile-surface"></line><polyline points="${points}" class="profile-line"></polyline>${dots}${labels}</svg><p class="detail-caveat">${escapeHtml(data.caveat||'')}</p></div>`;
}
async function loadDepthProfileForZone(zone,slot){
  if(!slot||slot.dataset.loaded==='yes') return;
  if(!zone?.structure?.profileAvailable||!Number.isFinite(zone.structure.coastNormal)){const nve=String(zone?.depth?.source||'').includes('NVE');slot.innerHTML=`<p class="muted">${nve?'NVE-dybde og struktur er allerede beregnet for punktet. Se Fiskekart – NVE dybder eller 3D bunn for hele formen.':'Detaljert dybdeprofil er ikke tilgjengelig for dette punktet.'}</p>`;slot.dataset.loaded='yes';return;}
  slot.innerHTML='<p class="muted">Henter modellert dybdeprofil …</p>';
  const key=`${zone.marker.lat.toFixed(5)}:${zone.marker.lon.toFixed(5)}:${Math.round(zone.structure.coastNormal)}`;
  try{
    let data=depthProfileCache.get(key);
    if(!data){const params=new URLSearchParams({lat:String(zone.marker.lat),lon:String(zone.marker.lon),coastNormal:String(zone.structure.coastNormal)});const response=await fetch(`/api/depth-profile?${params}`,{cache:'no-store'});data=await response.json();if(!response.ok)throw new Error(data.error||'Profilen kunne ikke hentes');depthProfileCache.set(key,data);}
    slot.innerHTML=depthProfileSvgHtml(data);slot.dataset.loaded='yes';
  }catch(error){slot.innerHTML=`<p class="muted">Dybdeprofil utilgjengelig: ${escapeHtml(error.message||String(error))}</p>`;}
}
function compactReasonText(value=''){
  const parts=String(value||'').split(/(?<=[.!?])\s+/).filter(Boolean);return parts.slice(0,2).join(' ').trim()||String(value||'');
}
function biteGuideHtml(zone={}){
  const guide=zone.biteGuide||{},rec=guide.recommended||{},timeline=Array.isArray(guide.timeline)?guide.timeline.slice(0,10):[];
  const best=guide.bestTime?formatClock(guide.bestTime):'–',score=Math.round(Number(guide.score)||zone.score||0);
  const bars=timeline.length?`<div class="bite-time-strip">${timeline.map(item=>`<article title="${escapeHtml(item.label||'')}"><time>${formatClock(item.time)}</time><i><em style="height:${Math.max(10,Math.min(100,Number(item.score)||0))}%"></em></i><b>${Math.round(Number(item.score)||0)}</b></article>`).join('')}</div>`:'<p class="muted">Ingen timeprognose tilgjengelig akkurat nå.</p>';
  const sourceLabels=(rec.sources||[]).map(src=>src.label).filter(Boolean).slice(0,2).join(' · ');
  return `<details class="zone-detail bite-guide-detail"><summary><span>🎯 BiteGuide</span><small>${score}/100 · best ${best}</small></summary><div class="bite-score-card"><strong>${score}</strong><div><b>${escapeHtml(guide.label||'Huggforhold')}</b><small>Best neste timer: ${best}</small></div></div>${bars}<div class="bite-rec bite-rec-profile"><section><span>ANBEFALT PROFIL · UAVHENGIG AV DIN SLUKBOKS</span><b>${escapeHtml(rec.type||'Sluk/wobbler')}</b><p><strong>Farge:</strong> ${escapeHtml(rec.color||'–')}<br><strong>Størrelse/vekt:</strong> ${escapeHtml(rec.size||'–')}${rec.targetDepth?`<br><strong>Måldybde:</strong> ${escapeHtml(rec.targetDepth)}`:''}</p><small>${escapeHtml(rec.method||'')}</small>${rec.whyNow?`<p class="bite-why">${escapeHtml(rec.whyNow)}</p>`:''}${sourceLabels?`<em>Grunnlag: ${escapeHtml(sourceLabels)}</em>`:''}</section></div><p class="detail-caveat">${escapeHtml(guide.disclaimer||'Veiledende score – ingen garanti for fangst.')}</p></details>`;
}
function lureDetailsHtml(lure={},presentation={},fly={}){
  const match=(lure.matchReasons||[]).slice(0,3).join(' · ');
  const personal=lure.personalHistory?.reason||'';
  return `<details class="zone-detail lure-detail"><summary><span>🎣 Sluk fra min boks</span><small>${escapeHtml(lure.name||lure.type||'forslag')}</small></summary><div class="lean-lure"><img class="zoomable-lure" src="${escapeHtml(lure.image||'')}" alt="${escapeHtml(lure.name||lure.type||'Anbefalt sluk')}" tabindex="0"><div><span>FØRSTEVALG · MATCHET MOT BITEGUIDE</span><b>${escapeHtml(lure.name||lure.type||'Anbefalt agn')}</b><small>${escapeHtml([lure.color,lure.weight].filter(Boolean).join(' · '))}</small>${match?`<p><strong>Hvorfor:</strong> ${escapeHtml(match)}</p>`:''}${personal?`<p><strong>Egen logg:</strong> ${escapeHtml(personal)}</p>`:''}</div></div>${leanAlternativeLures(lure.alternatives)}<div class="quick-advice"><b>Fisk slik</b><p>${escapeHtml(presentation.method||presentation.band||'Fisk av sonen systematisk og varier tempo og dybde.')}</p>${fly.recommended?`<small>Opphengerflue: ${escapeHtml(fly.pattern||'Ja')}${fly.color?' · '+escapeHtml(fly.color):''}</small>`:''}</div></details>`;
}
function analysisDetailsHtml(zone={}){
  const analysis=zone.analysis||{},habitat=zone.habitat||{},legal=zone.legal||{};
  return `<div class="selected-detail-stack"><details class="zone-detail"><summary><span>📍 Hvorfor akkurat her</span><small>kort analyse</small></summary><div class="detail-columns"><section><b>Habitat/struktur</b>${factorRowsHtml(analysis.habitatFactors||[])}</section><section><b>Forhold nå</b>${factorRowsHtml(analysis.liveFactors||[])}</section></div></details><details class="zone-detail depth-detail"><summary><span>🌊 Dybde og struktur</span><small>${escapeHtml(zone.structure?.label||'profil')}</small></summary>${quickStructureHtml(zone)}</details><details class="zone-detail"><summary><span>⚠️ Regler</span><small>${legal.blocked?'SPERRET':'kontroll'}</small></summary>${legalDetailHtml(legal)}</details><details class="zone-detail"><summary><span>ℹ️ Mer analyse</span><small>${Math.round(zone.dataQuality?.confidence??analysis.confidence??0)} % data</small></summary><div class="detail-columns"><section><b>Habitatdata</b>${habitatDetailHtml(habitat)}</section><section><b>Datagrunnlag</b>${confidenceDetailHtml(zone)}</section></div></details></div>`;
}
function renderSelectedZone(zone){
  const holder=$('selectedZone');if(!holder)return;
  if(!zone){holder.innerHTML='<span class="card-label">VALGT PUNKT</span><h2>Ingen sikker sone i utsnittet</h2><p class="muted">Flytt kartet eller zoom litt ut.</p>';return;}
  const lure=zone.lure||{},presentation=lure.presentation||{},fly=lure.dropperFly||{};
  const fish=zone.fishType||$('fishType').value,fishLabel=zone.fishLabel||fishLabels[fish]||fish;
  const number=Math.max(1,latestZones.findIndex(x=>x.id===zone.id)+1);
  const distance=Number.isFinite(zone.distanceM)?formatDistance(zone.distanceM):'Ingen avstandsgrense';
  const summary=compactReasonText(zone.analysis?.summary||zone.reason||'');
  holder.innerHTML=`<div class="selected-title-row"><div><span class="card-label">#${number} · ${escapeHtml(fishLabel)}</span><h2>${escapeHtml(zone.waterName||zone.name||'Anbefalt sone')}</h2></div><strong class="score-badge">${Math.round(zone.score||0)}/100</strong></div><div class="selected-chips"><span>${escapeHtml(zone.name||'')}</span><span>${escapeHtml(distance)}</span></div><p class="selected-reason">${escapeHtml(summary)}</p>${biteGuideHtml(zone)}${lureDetailsHtml(lure,presentation,fly)}${analysisDetailsHtml(zone)}<button class="secondary selected-map-button" type="button" id="selectedGo">Vis punkt på kartet</button>`;
  $('selectedGo')?.addEventListener('click',()=>focusMapOnZone(zone,15));
  const depthDetails=holder.querySelector('.depth-detail');
  depthDetails?.addEventListener('toggle',()=>{if(depthDetails.open)loadDepthProfileForZone(zone,depthDetails.querySelector('[data-depth-profile]'));});
}
function selectZone(zoneId,{scroll=false}={}) {
  selectedZoneId=zoneId;
  document.querySelectorAll('.zone-row').forEach(row=>row.classList.toggle('selected',row.dataset.zone===zoneId));
  zoneLayer.eachLayer(layer=>{if(!layer._zoneId||typeof layer.setStyle!=='function')return;layer.setStyle({weight:layer._zoneId===zoneId?4:2,fillOpacity:(layer._zoneId===zoneId ? .48 : .24)});});
  const selected=latestZones.find(zone=>zone.id===zoneId);
  renderSelectedZone(selected||null);
  if(selected&&!$('catchPlace').value) $('catchPlace').value=selected?.waterName||selected?.name||'';
  if(selected&&!$('catchLure').value) $('catchLure').value=lureText(selected);
  if(selected?.fishType&&$('fishType').value==='all') $('catchFish').value=selected.fishType;
  sync3DZones();
  if(scroll){const target=$('selectedZoneCard');if(window.innerWidth<1000)target?.scrollIntoView({behavior:'smooth',block:'start'});else $('results')?.scrollTo({top:0,behavior:'smooth'});}
}
function renderZones(zones) {
  zones=filterZonesByAccess(zones);
  zones=applyPersonalRanking(zones).map(applyPersonalLureHistory).slice(0,10);latestZones=zones;renderWaterDirectory();zoneLayer.clearLayers();drawNavigation(zones);$('zoneCount').textContent=`${zones.length} soner`;
  if(!zones.length){renderSelectedZone(null);sync3DZones();const radius=Number($('baseRadius').value)||0,accessMode=accessFilterMode();$('zones').innerHTML=accessMode!=='all'?`<div class="empty"><b>Ingen soner med ${escapeHtml(accessFilterLabel(accessMode).toLowerCase())}</b><span>Velg Alle eller flytt kartet.</span></div>`:currentAnalysisBase()&&radius?`<div class="empty"><b>Ingen sone innen ${escapeHtml(formatDistance(radius))}</b><span>Klikk et nytt referansepunkt eller øk avstanden.</span></div>`:'<div class="empty"><b>Ingen sikre soner i utsnittet</b><span>Flytt kartet litt eller zoom nærmere vann.</span></div>';return;}
  const allMode=$('fishType').value==='all';
  $('zones').innerHTML=zones.map((zone,index)=>{const fish=zone.fishType||$('fishType').value,fishBadge=allMode?`<span class="species-badge species-badge-${fish}">${escapeHtml(zone.fishLabel||fishLabels[fish]||fish)}</span>`:'';return `<button type="button" class="zone-row lean-zone-row" data-zone="${zone.id}"><span class="zone-rank">${index+1}</span><span class="lean-zone-copy"><b>${escapeHtml(zone.waterName||`Sone ${index+1}`)}</b><small>${escapeHtml(zone.name||'')}</small>${fishBadge}</span><span class="lean-zone-lure">${zone.lure?.image?`<img src="${escapeHtml(zone.lure.image)}" alt="" loading="lazy">`:''}<small>${escapeHtml(zone.lure?.name||zone.lure?.type||'')}</small></span><strong>${Math.round(zone.score||0)}</strong></button>`;}).join('');
  zones.forEach((zone,index)=>{const fish=zone.fishType||$('fishType').value,mapColor=allMode?(speciesColors[fish]||scoreColor(zone.score)):scoreColor(zone.score);const marker=L.circleMarker([zone.marker.lat,zone.marker.lon],{radius:7,color:'#10251f',weight:2,fillColor:mapColor,fillOpacity:1,opacity:1}).bindTooltip(String(index+1),{permanent:true,direction:'center',className:`zone-number ${allMode?`zone-number-${fish}`:''}`});const layer=Array.isArray(zone.polygon)&&zone.polygon.length>=3?L.polygon(zone.polygon,{color:mapColor,weight:2,fillColor:mapColor,fillOpacity:.24,opacity:.96}):L.circleMarker([zone.marker.lat,zone.marker.lon],{radius:15,color:mapColor,weight:2,fillColor:mapColor,fillOpacity:.10,opacity:.96});layer._zoneId=zone.id;marker._zoneId=zone.id;layer.on('click',e=>{if(e.originalEvent)L.DomEvent.stopPropagation(e.originalEvent);selectZone(zone.id,{scroll:false});});marker.on('click',e=>{if(e.originalEvent)L.DomEvent.stopPropagation(e.originalEvent);selectZone(zone.id,{scroll:false});});layer.addTo(zoneLayer);marker.addTo(zoneLayer);document.querySelector(`[data-zone="${zone.id}"]`)?.addEventListener('click',()=>{selectZone(zone.id,{scroll:false});focusMapOnZone(zone,15);});});
  if(!zones.some(z=>z.id===selectedZoneId))selectedZoneId=zones[0].id;selectZone(selectedZoneId);sync3DZones();sync3DReferenceAndLive();
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
    const freshwater=freshwaterFishTypes.has($('fishType').value);
    setState('loading',allMode?'Analyserer ørret og abbor samtidig …':freshwater ? 'Analyserer vannkant, NVE-dybde, vind og ferskvannsforhold …' : 'Analyserer kyst, vind og sjøforhold …');
    $('zones').setAttribute('aria-busy','true');
    try {
      const searchParams = new URLSearchParams({ bbox, zoom:String(map.getZoom()), limit:'10' });
      searchParams.set('fish', $('fishType').value);
      searchParams.set('goal',$('fishGoal').value);
      const radius=Number($('baseRadius').value)||0;
      const analysisBase=currentAnalysisBase();
      if(analysisBase){searchParams.set('baseLat',String(analysisBase.lat));searchParams.set('baseLon',String(analysisBase.lon));if(radius)searchParams.set('radiusM',String(radius));}
      let response=null,data=null,lastError=null;
      for(let attempt=0;attempt<2;attempt++){
        try{response=await fetch(`/api/zones?${searchParams}`,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});data=await response.json();if(!response.ok)throw new Error(data.error||`API-feil ${response.status}`);lastError=null;break;}catch(error){if(error.name==='AbortError')throw error;lastError=error;if(attempt===0)await new Promise(resolve=>setTimeout(resolve,450));}
      }
      if(lastError)throw lastError;
      applyAnalysisData(data);cacheAnalysis(data);clearTransientWarnings();
      if(freshwater) loadHydrologyAtCenter(); else renderHydrology(null);
      setState('ready',`Oppdatert ${new Date().toLocaleTimeString('no-NO',{hour:'2-digit',minute:'2-digit'})} · ${(data.zones || []).length} soner`);
    } catch (error) {
      if (error.name === 'AbortError') return;
      const offline = navigator.onLine===false;
      const cached=readCachedAnalysis();
      if(cached){applyAnalysisData(cached.data,{cached:true,offline,errorMessage:error.message});setState('ready',offline?`Offline · sist lagret ${formatSourceTime(cached.savedAt)}`:`Midlertidig datafeil · viser sist lagret ${formatSourceTime(cached.savedAt)}`);}
      else{setWarning('analysis-error',offline?'Ingen nettforbindelse.':'Analysen kunne ikke oppdateres akkurat nå.');setState('error',offline ? 'Du er offline og har ingen lagret analyse for dette området.' : `Kunne ikke oppdatere: ${error.message}`);$('zones').innerHTML = `<div class="empty error"><b>${offline ? 'Ingen nettforbindelse' : 'Midlertidig analysefeil'}</b><span>Prøv igjen. Kartet kan fortsatt brukes.</span></div>`;}
    } finally { $('zones').setAttribute('aria-busy','false'); }
  }, immediate ? 0 : 550);
}
function updateFilterSummary(){
  const target=$('filterSummary');if(!target)return;
  const fish=$('fishType')?.selectedOptions?.[0]?.textContent?.trim()||'Fisk';
  const mapName=$('mapStyle')?.selectedOptions?.[0]?.textContent?.trim()||'Kart';
  target.textContent=`${fish} · ${mapName}`;
}
function configureMobilePanels(){
  const filter=$('filterPanel');
  if(filter&&window.matchMedia?.('(max-width: 850px)').matches) filter.open=false;
  updateFilterSummary();
}
// ResizeObserver/invalidateSize can emit moveend without user interaction.
// Listening to dragend instead prevents a render → resize → reload feedback loop.
map.on('click',event=>{setBasePoint(event.latlng,{label:'Kartklikk',focus:false});setState('ready','Kartklikk satt som referansepunkt. Oppdaterer 10 beste soner …');if(freshwaterFishTypes.has($('fishType').value)&&$('mapStyle').value==='fishing')loadFreshwaterDepthOverlay({force:true});});
map.on('dragend zoomend', () => {if(threeDSyncing)return;saveUiState();renderConditionVectors();if(showBoatRamps)loadBoatRamps();if(freshwaterFishTypes.has($('fishType').value)&&$('mapStyle').value==='fishing')loadFreshwaterDepthOverlay();loadZones();scheduleBathyRefresh(750);scheduleNative3DRefresh(750);});
$('locate').addEventListener('click', () => { setState('locating','Finner posisjonen din …'); map.locate({ setView:true, maxZoom:14, enableHighAccuracy:true }); });
$('live').addEventListener('click',startLiveMode);
$('retry').addEventListener('click', () => loadZones({immediate:true}));
$('fishType').addEventListener('change', () => { if($('fishType').value!=='all') $('catchFish').value=$('fishType').value; $('mapStyle').value='fishing'; updateFilterSummary(); renderFishingInsights(); updateWaterModeUI(); saveUiState(); loadZones({immediate:true}); });
$('fishGoal').addEventListener('change',()=>{saveUiState();renderWaterDirectory();loadZones({immediate:true});});
$('accessFilter').addEventListener('change',()=>{saveUiState();renderWaterDirectory();loadZones({immediate:true});});
$('baseRadius').addEventListener('change',()=>{saveUiState();updateBaseRadiusCircle();if(basePoint&&Number($('baseRadius').value)>0)focusBaseRadius();loadZones({immediate:true});});
$('setBase').addEventListener('click',()=>{if(basePoint)clearBasePoint();else setBasePoint(map.getCenter(),{label:'Valgt base'});});
$('mapStyle').addEventListener('change',()=>{updateFilterSummary();updateMapLegend();applyMapStyle();saveUiState();});
$('threeDTopView')?.addEventListener('click',()=>{if(threeDMap)threeDMap.easeTo({pitch:0,bearing:0,duration:450});else native3DCamera('top');});
$('bathyTopView')?.addEventListener('click',()=>bathyCamera('top'));
$('bathyPitchView')?.addEventListener('click',()=>bathyCamera('pitch'));
$('bathyResetView')?.addEventListener('click',()=>bathyResetView());
$('bathyRefresh')?.addEventListener('click',()=>refreshBathy3D());
$('bathyPanel')?.addEventListener('toggle',()=>{$('bathyPanel').open?enableBathy3D():disableBathy3D();});
$('threeDPitchView')?.addEventListener('click',()=>{if(threeDMap)threeDMap.easeTo({pitch:62,bearing:-18,duration:450});else native3DCamera('pitch');});
$('sourceSpotToggle').addEventListener('click',()=>{showSourceSpots=!showSourceSpots;$('sourceSpotToggle').setAttribute('aria-pressed',String(showSourceSpots));$('sourceSpotToggle').classList.toggle('layer-active',showSourceSpots);$('sourceSpotToggle').textContent=showSourceSpots?'Kirkøy-steder':'Vis Kirkøy-steder';renderReferenceLayers();});
$('restrictionToggle').addEventListener('click',()=>{showRestrictions=!showRestrictions;$('restrictionToggle').setAttribute('aria-pressed',String(showRestrictions));$('restrictionToggle').classList.toggle('restriction-active',showRestrictions);$('restrictionToggle').textContent=showRestrictions?'Fredningsgrenser':'Vis fredningsgrenser';renderReferenceLayers();});
$('conditionToggle').addEventListener('click',()=>{showConditionVectors=!showConditionVectors;$('conditionToggle').setAttribute('aria-pressed',String(showConditionVectors));$('conditionToggle').classList.toggle('layer-active',showConditionVectors);$('conditionToggle').textContent=showConditionVectors?'Skjul vind/strøm':'Vind/strøm';renderConditionVectors();});
$('boatRampToggle').addEventListener('click',()=>{showBoatRamps=!showBoatRamps;$('boatRampToggle').setAttribute('aria-pressed',String(showBoatRamps));$('boatRampToggle').classList.toggle('layer-active',showBoatRamps);$('boatRampToggle').textContent=showBoatRamps?'Skjul båtramper':'Båtramper';if(showBoatRamps)loadBoatRamps();else{boatRampLayer.clearLayers();clearWarning('ramps');}});
$('closeLureViewer').addEventListener('click', () => { lureViewer.close(); if(lureViewerHistoryActive){lureViewerHistoryActive=false;history.back();} });
lureViewer.addEventListener('click', event => { if (event.target === lureViewer){ lureViewer.close(); if(lureViewerHistoryActive){lureViewerHistoryActive=false;history.back();} } });
window.addEventListener('popstate',()=>{ if(lureViewer.open){lureViewerHistoryActive=false;lureViewer.close();} });
document.addEventListener('click', event => { const image=event.target.closest?.('.zoomable-lure'); if (!image) return; event.preventDefault(); event.stopPropagation(); openLureViewer(image.currentSrc || image.src, image.alt); }, true);
document.addEventListener('click', event => { const button=event.target.closest?.('[data-water-focus]'); if(!button) return; event.preventDefault(); selectedWaterDirectoryName=button.dataset.waterFocus; const item=waterDirectoryItems.find(w=>normalizeDirectoryName(w.name)===normalizeDirectoryName(selectedWaterDirectoryName)); if(item) renderWaterProfile(item); focusKnownWater(selectedWaterDirectoryName); });
document.addEventListener('click', event => { const button=event.target.closest?.('.popup-details'); if(!button) return; event.preventDefault(); const zoneId=button.dataset.zone; map.closePopup(); selectZone(zoneId,{scroll:false}); });
document.addEventListener('keydown', event => { const image=event.target.closest?.('.zoomable-lure'); if (image && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openLureViewer(image.currentSrc || image.src, image.alt); } });
map.on('locationfound', event => { if (locationMarker) locationMarker.remove(); locationMarker=L.circleMarker(event.latlng,{radius:7,color:'#fff',weight:2,fillColor:'#38d477',fillOpacity:1}).addTo(map).bindPopup('Din posisjon').openPopup(); setBasePoint(event.latlng,{label:'Base: din posisjon',focus:false}); if(is3DMode()&&threeDMap){threeDProgrammaticMove=true;threeDMap.easeTo({center:[event.latlng.lng,event.latlng.lat],zoom:Math.max(14,threeDMap.getZoom()),pitch:62,duration:500});} else if(is3DMode()) scheduleNative3DRefresh(120); sync3DReferenceAndLive(); $('setBase').textContent='✓ Base = GPS · fjern'; setState('ready','Posisjon funnet. Bruker den som base og oppdaterer soner …'); });
map.on('locationerror', () => setState('error','Kunne ikke hente posisjonen. Tillat posisjon eller flytt kartet manuelt.'));
window.addEventListener('online', () => loadZones({immediate:true}));
window.addEventListener('offline', () => {const cached=readCachedAnalysis();setState(cached?'ready':'error',cached?'Du er offline. Siste lagrede analyse er tilgjengelig.':'Du er offline. Kartskallet virker; lagret analyse vises når den finnes.');});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&liveActive) acquireLiveWakeLock();});
window.addEventListener('pagehide',()=>{if(liveWatchId!==null&&navigator.geolocation) navigator.geolocation.clearWatch(liveWatchId); releaseLiveWakeLock();});

// Vestfjella water directory and access filters.
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
function accessFilterMode(){ return $('accessFilter')?.value||'all'; }
function accessMatchesItem(item){
  const mode=accessFilterMode();
  const score=Number(item?.accessScore);
  if(mode==='all') return true;
  if(!Number.isFinite(score)) return false;
  if(mode==='easy') return score>=4;
  if(mode==='veryeasy') return score>=5;
  if(mode==='medium') return score===3;
  if(mode==='wild') return score<=2;
  return true;
}
function accessFilterLabel(mode=accessFilterMode()){
  return ({all:'Alle',easy:'Lett tilkomst',veryeasy:'Svært enkel',medium:'Middels',wild:'Mer naturpreg / usikker'})[mode]||'Alle';
}
function directoryItemForZone(zone){
  const key=normalizeDirectoryName(zone?.waterName||'');
  if(!key) return null;
  return waterDirectoryItems.find(item=>{
    const name=normalizeDirectoryName(item.name||'');
    return name&&(name===key||name.includes(key)||key.includes(name));
  })||null;
}
function filterZonesByAccess(zones=[]){
  const mode=accessFilterMode();
  if(mode==='all') return zones;
  return zones.filter(zone=>{
    const item=directoryItemForZone(zone);
    return item?accessMatchesItem(item):false;
  });
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
  const ranked=waterDirectoryItems.filter(accessMatchesItem).map(item=>{const scored=directoryScoreFor(item);return {...item,currentScore:scored.score,scoreLive:scored.live};}).sort((a,b)=>b.currentScore-a.currentScore||String(a.name).localeCompare(String(b.name),'no'));
  const liveCount=ranked.filter(item=>item.scoreLive).length;
  const officialTotal=Number(waterDirectoryMeta?.officialTotalWaterCount)||ranked.length;
  badge.textContent=`${ranked.length} vist · ${officialTotal} totalt · ${accessFilterMode()==='all'?'beste først':accessFilterLabel()}`;
  container.innerHTML=ranked.map((item,index)=>`<button type="button" class="water-directory-row${selectedWaterDirectoryName===item.name?' selected':''}" data-water-focus="${escapeHtml(item.name)}" title="Vis ${escapeHtml(item.name)} på kartet"><span class="water-directory-rank">${index+1}</span><span class="water-directory-name"><b>${escapeHtml(item.name)}</b>${item.flyOnly?'<small>KUN FLUE</small>':''}${item.accessiblePier?'<small>♿ fiskebrygge</small>':''}${item.hiddenGem?'<small>🎯 SMÅVANN</small>':''}${Array.isArray(item.species)&&item.species.length?`<small>${escapeHtml(speciesLabelFromItem(item))}</small>`:''}<small>Tilkomst: ${escapeHtml(item.access||'ukjent')}</small><small>${item.scoreLive?'LIVE I KARTUTSNITT':'KILDEJUSTERT GRUNNRANGERING'}</small></span><span class="water-directory-score has-score">${Math.round(item.currentScore)}/100</span></button>`).join('');
}
function drawWaterFocusMarker(lat, lon, label, bounds){
  waterFocusLayer.clearLayers();
  if(bounds&&[bounds.south,bounds.west,bounds.north,bounds.east].every(Number.isFinite)){
    const rect=L.latLngBounds([bounds.south,bounds.west],[bounds.north,bounds.east]);
    L.rectangle(rect,{color:'#38d477',weight:2,fillColor:'#38d477',fillOpacity:.03,dashArray:'6 6'}).addTo(waterFocusLayer);
  }
  L.circleMarker([lat,lon],{radius:16,color:'#38d477',weight:3,fillColor:'#38d477',fillOpacity:.1}).bindTooltip(label,{permanent:false}).addTo(waterFocusLayer);
}
async function focusKnownWater(name){
  const item=waterDirectoryItems.find(w=>normalizeDirectoryName(w.name)===normalizeDirectoryName(name));
  if(item) renderWaterProfile(item);
  const key=normalizeDirectoryName(name);
  const zone=latestZones.find(item=>{const z=normalizeDirectoryName(item.waterName||'');return z&&(z===key||z.includes(key)||key.includes(z));});
  if(zone&&zone.marker&&Number.isFinite(zone.marker.lat)&&Number.isFinite(zone.marker.lon)){
    drawWaterFocusMarker(zone.marker.lat,zone.marker.lon,name);
    map.flyTo([zone.marker.lat,zone.marker.lon],16,{duration:.55});
    selectZone(zone.id);
    renderWaterDirectory();
  }
  setState('loading',`Finner ${name} på kartet …`);
  try{
    const response=await fetch(`/api/water-locate?name=${encodeURIComponent(name)}`,{cache:'no-store'});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'Fant ikke vannet');
    const hasBounds=data.bounds&&[data.bounds.south,data.bounds.west,data.bounds.north,data.bounds.east].every(Number.isFinite);
    drawWaterFocusMarker(data.lat,data.lon,data.name||name,hasBounds?data.bounds:null);
    if(hasBounds){
      const bounds=L.latLngBounds([data.bounds.south,data.bounds.west],[data.bounds.north,data.bounds.east]);
      map.fitBounds(bounds.pad(.18),{padding:[35,35],maxZoom:17});
    } else map.flyTo([data.lat,data.lon],16,{duration:.65});
    if(item) renderWaterProfile(item,data);
    renderWaterDirectory();
    setState('ready',`${data.name||name} vises på kartet. Oppdaterer anbefalte soner …`);
    setTimeout(()=>loadZones({immediate:true}),150);
    return;
  }catch(error){ if(item) renderWaterProfile(item,null,error.message); if(!zone) setState('error',`${name}: ${error.message}`);}
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

async function loadOwnedLureNames(){try{const response=await fetch('/data/user-lures.json',{cache:'force-cache'});const data=await response.json();$('ownedLures').innerHTML=(data.lures||[]).map(item=>`<option value="${escapeHtml(item.name||item.type||'')}"></option>`).join('');}catch{}}
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js?v=1.7', { updateViaCache: 'none' }).catch(() => {}));
loadOwnedLureNames();
if(savedUiState.fishType&&Object.hasOwn(fishLabels,savedUiState.fishType)) $('fishType').value=savedUiState.fishType;
if(['numbers','big'].includes(savedUiState.fishGoal)) $('fishGoal').value=savedUiState.fishGoal;
if(['all','easy','veryeasy','medium','wild'].includes(savedUiState.accessFilter)) $('accessFilter').value=savedUiState.accessFilter;
if(['0','250','500','1000','2000'].includes(String(savedUiState.baseRadius))) $('baseRadius').value=String(savedUiState.baseRadius);
const legacyBathyMapStyle=savedUiState.mapStyle==='bathy3d';
if(savedUiState.mapStyle==='marine-depth') $('mapStyle').value='fishing';
else if(legacyBathyMapStyle) $('mapStyle').value='3d';
else if(['topo','satellite','fishing','3d'].includes(savedUiState.mapStyle)) $('mapStyle').value=savedUiState.mapStyle;
else $('mapStyle').value='fishing';
if(freshwaterFishTypes.has($('fishType').value)&&$('mapStyle').value==='chart')$('mapStyle').value='fishing';
configureMobilePanels();
if(basePoint){baseMarker=L.circleMarker([basePoint.lat,basePoint.lon],{radius:7,color:'#fff',weight:2,fillColor:'#f2c94c',fillOpacity:.95}).addTo(map).bindTooltip('Lagret referansepunkt',{direction:'top'});$('setBase').textContent='✓ Base satt · fjern';$('setBase').classList.add('base-active');$('setBase').setAttribute('aria-pressed','true');updateBaseRadiusCircle();}
initCatchLog();
$('exportGpx')?.addEventListener('click',exportCatchGpx);
$('exportJson')?.addEventListener('click',exportCatchJson);
setLiveButton();
renderLiveHud();
updateWaterModeUI();
loadWaterDirectory();
if(legacyBathyMapStyle&&$('bathyPanel')){$('bathyPanel').open=true;enableBathy3D();}
loadReferenceLayers();
loadZones({immediate:true});
