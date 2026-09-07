const http=require('http');
const fs=require('fs');
const path=require('path');
const {URL}=require('url');
const PORT=Number(process.env.PORT||3000);
const PUBLIC=path.join(__dirname,'public');
const waters=JSON.parse(fs.readFileSync(path.join(PUBLIC,'data','waters.json'),'utf8'));
const UA=process.env.MET_USER_AGENT||'vestfjella-fiske/1.0 contact: local-app';
const cache=new Map();
function clamp(n,a,b){return Math.max(a,Math.min(b,n));}
function cached(key,ms,fn){const h=cache.get(key);if(h&&h.until>Date.now())return Promise.resolve(h.value);return Promise.resolve(fn()).then(v=>(cache.set(key,{until:Date.now()+ms,value:v}),v));}
async function fetchJson(url){const c=new AbortController(),t=setTimeout(()=>c.abort(),9000);try{const r=await fetch(url,{headers:{'User-Agent':UA,'Accept':'application/json'},signal:c.signal});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}finally{clearTimeout(t);}}
function targetDate(mode,now=new Date()){
 const d=new Date(now);
 if(mode==='+3') return new Date(d.getTime()+3*3600000);
 if(mode==='+6') return new Date(d.getTime()+6*3600000);
 if(mode==='evening'){const x=new Date(d);x.setHours(19,0,0,0);if(x<=d)x.setDate(x.getDate()+1);return x;}
 if(mode==='tomorrow'){const x=new Date(d);x.setDate(x.getDate()+1);x.setHours(7,30,0,0);return x;}
 return d;
}
async function forecast(lat,lon){
 const key=`met:${lat.toFixed(3)},${lon.toFixed(3)}`;
 return cached(key,10*60*1000,async()=>{
  const j=await fetchJson(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`);
  return j.properties.timeseries.slice(0,60).map(x=>{const d=x.data.instant.details||{},n=x.data.next_1_hours||x.data.next_6_hours||{};return {time:x.time,temp:d.air_temperature??null,wind:d.wind_speed??null,windDir:d.wind_from_direction??null,cloud:d.cloud_area_fraction??null,pressure:d.air_pressure_at_sea_level??null,precip:n.details?.precipitation_amount??0,symbol:n.summary?.symbol_code||''};});
 });
}
function nearest(series,target){let best=series[0],dist=Infinity;for(const x of series){const d=Math.abs(new Date(x.time)-target);if(d<dist){dist=d;best=x;}}return best;}
function pressureTrend(series,item){const i=series.indexOf(item);if(i<0)return null;const j=Math.min(series.length-1,i+3);const a=Number(item.pressure),b=Number(series[j]?.pressure);return Number.isFinite(a)&&Number.isFinite(b)?Number((b-a).toFixed(1)):null;}
function troutScore(w,wth,{goal='numbers',method='all'}={}){
 let s=goal==='big'?w.big:w.base; const hour=new Date(wth.time).getHours();
 if(hour<=9||hour>=17)s+=8;else if(hour<=12)s+=4;else s-=2;
 if(Number.isFinite(wth.wind)){if(w.flyOnly){s+=wth.wind>=0.4&&wth.wind<=4?8:wth.wind>7?-10:2;}else{s+=wth.wind>=1.5&&wth.wind<=6?8:wth.wind>10?-9:wth.wind<0.5?-3:2;}}
 if(Number.isFinite(wth.cloud))s+=wth.cloud>=35&&wth.cloud<=90?6:wth.cloud>90?4:-2;
 if(Number.isFinite(wth.temp)){if(wth.temp>=6&&wth.temp<=16)s+=5;else if(wth.temp>23)s-=7;else s+=1;}
 if(Number.isFinite(wth.precip)){if(wth.precip>0&&wth.precip<=2)s+=2;else if(wth.precip>5)s-=5;}
 if(method!=='all'&&!w.methods.includes(method))return null;
 return clamp(Math.round(s),20,99);
}
function perchScore(w,wth,{goal='numbers',method='all'}={}){
 if(method==='flue'&&w.flyOnly===false)return null;
 if(method!=='all'&&!w.methods.includes(method))return null;
 let s=64+(w.accessScore-3)*2; const hour=new Date(wth.time).getHours();
 if(hour>=7&&hour<=20)s+=5;if(Number.isFinite(wth.temp)&&wth.temp>=10)s+=7;if(Number.isFinite(wth.wind)&&wth.wind<=6)s+=4;if(Number.isFinite(wth.cloud)&&wth.cloud>=25&&wth.cloud<=85)s+=3;
 if(w.flyOnly)s-=5;if(goal==='big'&&['skibuvannet','laua'].includes(w.id))s+=7;return clamp(Math.round(s),20,96);
}
function lureAdvice(w,wth,fish='orret'){
 const hour=new Date(wth.time).getHours(),low=hour<=9||hour>=17,cloud=Number(wth.cloud)||0,wind=Number(wth.wind)||0,wet=Number(wth.precip)||0;
 if(w.flyOnly){
   if(low&&wind<=3)return {method:'Flue',name:'Streaking Caddis / maur / bibio',color:'Mørk eller natur',image:'/lures/egne-fluer.jpg',why:'Lavt lys og rolig vann: start i overflaten. Ser du ikke vak, gå ned med liten nymfe.',presentation:'Land mykt langs kantsoner. 3–5 kast per vinkel før du flytter.'};
   return {method:'Flue',name:'Liten mørk nymfe / Klinkhammer',color:'Mørk/natur',image:'/lures/egne-fluer.jpg',why:'Mer vind eller lite vak: nymfe er sikrere start. Ved vak bytter du til tørrflue.',presentation:'Fisk rolig, korte inntrekk og lange pauser.'};
 }
 if(fish==='abbor') return {method:'Spinner/sluk',name:'Liten spinner eller kompakt skjesluk',color:cloud>60?'Gull/rød kontrast':'Sølv/grønn natur',image:'/lures/rod-smal-prikket.jpg',why:'Søk aktivt langs vegetasjon, odder og kanter.',presentation:'Jevn innsveiving. Varier dybde hvert 5. kast.'};
 if(wet>0.3||cloud>=75)return {method:'Sluk',name:'Gul/oransje prikket',color:'Gul/oransje med sorte prikker',image:'/lures/gul-oransje-prikket.jpg',why:'Gråvær, lavt lys og etter regn – tydelig kontrast uten å bli for mørk.',presentation:'Middels fart med korte spinnstopp. Fisk 0,5–1,5 m under overflaten først.'};
 if(low)return {method:'Sluk',name:'Rød bred prikket',color:'Rød med sorte prikker',image:'/lures/rod-bred-prikket.jpg',why:'Morgen/kveld og krusning – bred profil og god synlighet.',presentation:'Rolig til middels fart. La sluken synke 1–3 sek før start.'};
 if(cloud<=30&&wind<2)return {method:'Sluk / mark',name:'Rød smal prikket',color:'Rød/oransje med sorte prikker',image:'/lures/rod-smal-prikket.jpg',why:'Klart og rolig: mindre påtrengende profil. På helt blankt vann er mark under dupp et sterkt alternativ.',presentation:'Rolig innsveiving langs land. Ingen respons etter 15–20 min: gå ned i fart eller bytt til mark.'};
 return {method:'Sluk',name:'Rosa/sølv prikket',color:'Rosa/sølv med sorte prikker',image:'/lures/rosa-solv-prikket.jpg',why:'Overskyet eller litt vind: mer flash og god søkeevne.',presentation:'Middels fart, korte pauser og fisk flere vannlag.'};
}
function bestMethod(w,wth,fish){if(w.flyOnly)return 'flue';if(fish==='abbor')return 'spinner';const hour=new Date(wth.time).getHours();if(hour>=11&&hour<=15&&(wth.cloud??50)<30&&(wth.wind??2)<2)return 'mark';return 'sluk';}
async function analysis(query){
 const mode=query.get('time')||'now',fish=query.get('fish')||'orret',goal=query.get('goal')||'numbers',method=query.get('method')||'all',access=query.get('access')||'all';
 const target=targetDate(mode);const center={lat:59.2700,lon:11.5890};const series=await forecast(center.lat,center.lon);const wth=nearest(series,target);wth.pressureTrend=pressureTrend(series,wth);
 let rows=waters.waters.map(w=>{let score=fish==='abbor'?perchScore(w,wth,{goal,method}):troutScore(w,wth,{goal,method});if(fish==='all'){const ts=troutScore(w,wth,{goal,method}),ps=perchScore(w,wth,{goal,method});if(ts===null&&ps===null)return null;const targetFish=(ts??0)>=(ps??0)?'orret':'abbor';score=Math.max(ts??0,ps??0);return {...w,score,targetFish,lure:lureAdvice(w,wth,targetFish),bestMethod:bestMethod(w,wth,targetFish)};}if(score===null)return null;return {...w,score,targetFish:fish,lure:lureAdvice(w,wth,fish),bestMethod:bestMethod(w,wth,fish)};}).filter(Boolean);
 if(access!=='all')rows=rows.filter(w=>access==='easy'?w.accessScore>=4:w.accessScore<=3);
 rows.sort((a,b)=>b.score-a.score||b.accessScore-a.accessScore);
 return {revision:'REV 1',generatedAt:new Date().toISOString(),targetTime:wth.time,weather:wth,fish,goal,method,access,rules:waters.official,waters:rows};
}
function mime(f){return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png'}[path.extname(f)]||'application/octet-stream');}
function serve(req,res){let p=new URL(req.url,'http://x').pathname;if(p==='/')p='/index.html';p=path.normalize(p).replace(/^([.][.][/\\])+/, '');const f=path.join(PUBLIC,p);if(!f.startsWith(PUBLIC)){res.writeHead(403);return res.end('Forbidden');}fs.readFile(f,(e,b)=>{if(e){res.writeHead(404);res.end('Not found');}else{res.writeHead(200,{'Content-Type':mime(f),'Cache-Control':p==='/index.html'?'no-store':'public, max-age=300'});res.end(b);}});}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');if(u.pathname==='/api/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,app:'Vestfjella Fiske',revision:'REV 1',waters:waters.waters.length}));}if(u.pathname==='/api/analysis'){const data=await analysis(u.searchParams);res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify(data));}serve(req,res);}catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message||String(e)}));}});
if(require.main===module)server.listen(PORT,'0.0.0.0',()=>console.log(`Vestfjella Fiske REV 1 på http://0.0.0.0:${PORT}`));
module.exports={server,analysis,targetDate,troutScore,lureAdvice};
