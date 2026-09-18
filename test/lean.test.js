"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const root=path.join(__dirname,"..");const read=p=>fs.readFileSync(path.join(root,p),"utf8");
test("Lean Mistra-style layout is present",()=>{const h=read("public/index.html"),a=read("public/app.js");assert.match(h,/selectedZoneCard/);assert.match(h,/10 beste i kartutsnittet/);assert.match(h,/compact-panel/);assert.match(a,/map\.on\('click'/);assert.match(a,/selectedZoneId/);assert.match(a,/\.slice\(0,10\)/);});
test("Version is STABLE 1.5",()=>{assert.match(read("public/index.html"),/STABLE\ 1\.5/);});
