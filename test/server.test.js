const test=require('node:test');const assert=require('node:assert/strict');const {analysis,targetDate,troutScore,lureAdvice}=require('../server');
test('target +3',()=>{const d=new Date('2026-09-07T10:00:00Z');assert.equal((targetDate('+3',d)-d)/3600000,3)});
test('fly-only rejects sluk',()=>{const w={base:80,big:70,flyOnly:true,methods:['flue']};assert.equal(troutScore(w,{time:new Date().toISOString(),wind:2,cloud:60,temp:12,precip:0},{method:'sluk'}),null)});
test('own lure choice exists',()=>{const w={flyOnly:false};const a=lureAdvice(w,{time:'2026-09-07T19:00:00Z',wind:2,cloud:40,temp:12,precip:0},'orret');assert.ok(a.image.includes('/lures/'))});
test('analysis returns waters',async()=>{const old=global.fetch;global.fetch=async()=>({ok:true,json:async()=>({properties:{timeseries:Array.from({length:20},(_,i)=>({time:new Date(Date.now()+i*3600000).toISOString(),data:{instant:{details:{air_temperature:12,wind_speed:3,wind_from_direction:220,cloud_area_fraction:60,air_pressure_at_sea_level:1010}},next_1_hours:{details:{precipitation_amount:0},summary:{symbol_code:'cloudy'}}}}))}})});try{const q=new URLSearchParams('fish=orret&goal=numbers&method=all&access=all&time=now');const a=await analysis(q);assert.equal(a.waters.length,10);assert.ok(a.waters[0].score>=a.waters.at(-1).score)}finally{global.fetch=old}});


test('samme forhold gir variasjon i slukvalg mellom ulike vann',()=>{
  const weather={time:'2026-09-07T12:00:00Z',cloud:85,precip:0.6,wind:4};
  const waters=[
    {id:'a-vann',depth:3,size:20,flyOnly:false},
    {id:'b-vann',depth:6,size:80,flyOnly:false},
    {id:'c-vann',depth:10,size:200,flyOnly:false},
    {id:'d-vann',depth:4,size:60,flyOnly:false}
  ];
  const picked=new Set(waters.map(w=>lureAdvice(w,weather,'orret').image));
  assert.ok(picked.size>1);
});

test('ørret-råd bruker enkeltsluk-bilder fremfor samlebilde',()=>{
  const weather={time:'2026-09-07T12:00:00Z',cloud:50,precip:0,wind:2};
  const advice=lureAdvice({id:'test-vann',depth:5,size:60,flyOnly:false},weather,'orret');
  assert.notEqual(advice.image,'/lures/egne-fluer.jpg');
});
