const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const app=require('../server');
const pkg=require('../package.json');
const root=path.join(__dirname,'..','public');

test('stable app is built on Fiste freshwater core',()=>{
  for(const name of ['computeScore','environmentalScoreAdjustments','validateZoneRequest','freshwaterCandidateGrid','freshwaterAtPoint','recommendLure','createServer']) assert.equal(typeof app[name],'function',name);
  assert.equal(pkg.name,'vestfjella-fiske-stable');
  assert.equal(pkg.version,'1.0.0');
});

test('Vestfjella UI starts in the correct area and contains only freshwater choices',()=>{
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'app.js'),'utf8');
  assert.match(html,/Vestfjella Fiske/);
  assert.match(html,/STABLE 1\.0/);
  assert.match(html,/value="orret" selected/);
  assert.match(html,/value="abbor"/);
  assert.match(html,/Ingen – vis ørret \+ abbor/);
  assert.doesNotMatch(html,/value="sjoorret"/);
  assert.doesNotMatch(html,/value="makrell"/);
  assert.match(js,/\[59\.2700,11\.5890\]/);
  assert.match(js,/Analyserer ørret og abbor samtidig i faktiske vannflater/);
});

test('freshwater candidate points are always inside the real polygon',()=>{
  const area={name:'Testvann',ring:[
    {lat:59.25,lon:11.57},{lat:59.25,lon:11.61},{lat:59.29,lon:11.61},{lat:59.29,lon:11.57},{lat:59.25,lon:11.57}
  ],holes:[],restricted:false};
  const points=app.freshwaterCandidateGrid([area],{west:11.56,south:59.24,east:11.62,north:59.30});
  assert.ok(points.length>0);
  for(const point of points) assert.equal(app.freshwaterAtPoint(point.lat,point.lon,[area]),area);
});

test('water registry contains the known Vestfjella list but no guessed map coordinates',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(root,'data','vestfjella-waters.json'),'utf8'));
  assert.equal(data.count,92);
  assert.equal(data.waters.length,92);
  assert.ok(data.waters.some(w=>w.name==='Kutjern'));
  assert.ok(data.waters.some(w=>w.name==='Midtre Ormtjern'&&w.flyOnly));
  assert.ok(data.waters.every(w=>!Object.hasOwn(w,'lat')&&!Object.hasOwn(w,'lon')));
});

test('fly-only waters are recognized and use a single fly image',()=>{
  assert.equal(app.isVestfjellaFlyOnly('Sætertjern'),true);
  assert.equal(app.isVestfjellaFlyOnly('Setertjern'),true);
  assert.equal(app.isVestfjellaFlyOnly('Midtre Ormtjern'),true);
  assert.equal(app.isVestfjellaFlyOnly('Kutjern'),false);
  const lure=app.flyOnlyLureAdvice({hour:19,cloud:60,wind:2,lat:59.26,lon:11.59});
  assert.match(lure.image,/^\/lures\/vestfjella\/fly_/);
  assert.ok(Array.isArray(lure.alternatives)&&lure.alternatives.length>=2);
});

test('personal freshwater lure box contains individual cropped images',()=>{
  const data=JSON.parse(fs.readFileSync(path.join(root,'data','user-lures.json'),'utf8'));
  assert.ok(data.lures.length>=25);
  assert.ok(data.lures.every(item=>item.waterTypes.includes('freshwater')));
  assert.ok(data.lures.every(item=>item.image.startsWith('/lures/vestfjella/')));
  for(const item of data.lures){
    const file=path.join(root,item.image.replace(/^\//,''));
    assert.ok(fs.existsSync(file),item.image);
  }
});

test('trout lure recommendations vary between locations instead of one repeated winner',()=>{
  const choices=[];
  for(let i=0;i<14;i++){
    const rec=app.recommendLure({fishType:'orret',hour:17,cloud:55,wind:3,temp:12,exposure:.45,coastQuality:.72,depthMeters:null,lat:59.245+i*.003,lon:11.57+i*.002,goal:'numbers'});
    choices.push(rec.image);
    assert.match(rec.image,/^\/lures\/vestfjella\//);
    assert.ok(rec.alternatives.length>=3);
  }
  assert.ok(new Set(choices).size>=4,`only ${new Set(choices).size} unique primary lures`);
});

test('perch uses the photographed freshwater inventory',()=>{
  const rec=app.recommendLure({fishType:'abbor',hour:13,cloud:70,wind:2,temp:16,exposure:.3,coastQuality:.7,depthMeters:null,lat:59.26,lon:11.59,goal:'numbers'});
  assert.match(rec.image,/^\/lures\/vestfjella\//);
  assert.ok(rec.alternatives.length>=2);
});

test('base radius search remains centered and reliable',()=>{
  const b=app.searchBoundsForBase(59.27,11.589,500,13);
  assert.equal(b.zoom,15);
  assert.ok(b.west<11.589&&b.east>11.589&&b.south<59.27&&b.north>59.27);
});

test('health and water-directory endpoints identify the stable freshwater build',async t=>{
  const server=app.createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>server.close());
  const port=server.address().port;
  const health=await fetch(`http://127.0.0.1:${port}/api/health`).then(r=>r.json());
  assert.equal(health.ok,true);
  assert.equal(health.app,'Vestfjella Fiske');
  assert.equal(health.version,'stable-1.0');
  assert.equal(health.waterDirectory,92);
  const dir=await fetch(`http://127.0.0.1:${port}/api/water-directory`).then(r=>r.json());
  assert.equal(dir.count,92);
});

test('all mode is freshwater trout plus perch, not the old sea multi-mode',()=>{
  const serverSource=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.match(serverSource,/const freshTypes=\['orret','abbor'\]/);
  assert.match(serverSource,/Alle ferskvannsarter/);
  assert.doesNotMatch(serverSource,/for\(const type of seaTypes\)/);
});

test('service worker caches the stable shell and real cropped lure images',()=>{
  const sw=fs.readFileSync(path.join(root,'sw.js'),'utf8');
  assert.match(sw,/vestfjella-fiste-stable-1/);
  assert.match(sw,/\/lures\/vestfjella\/rosa-solv-prikket\.jpg/);
  assert.match(sw,/\/data\/vestfjella-waters\.json/);
  assert.doesNotMatch(sw,/\/lures\/user\//);
});
