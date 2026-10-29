'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures-festivals-live-20261015.json')));
function setup(t,load){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-festival-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  let time=1000,tick;const errors=[];const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'net.js'),'utf8'),{require,module,__dirname,process,Buffer,URL,setTimeout,clearTimeout,setInterval:fn=>{tick=fn;return {unref(){}};},console:{error:(...args)=>errors.push(args)}});
  const cache=module.exports.createDataCache({base,now:()=>time,loadJson:load});
  return {cache,errors,advance:async ms=>{time+=ms;tick();await new Promise(setImmediate);},base};
}
test('live API fixture is accepted and written without altering regional records',async t=>{
 const h=setup(t,async()=>fixture);assert.deepEqual(await h.cache.data('festivals'),fixture);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.base,'cache/schedules/festivals.json'))).data,fixture);
});
test('malformed festival payload never overwrites a valid cache',async t=>{
 let result=fixture;const h=setup(t,async()=>result);await h.cache.data('festivals');
 const file=path.join(h.base,'cache/schedules/festivals.json'),before=fs.readFileSync(file);
 for(const invalid of [{},{JP:{data:{festRecords:{nodes:{}}}}},null]){
  result=invalid;await assert.rejects(h.cache.refresh('festivals'),/数据源结构变化：festivals/);
  assert.deepEqual(fs.readFileSync(file),before);
 }
});
test('available non-JP region remains usable when JP is absent (derived live fixture)',async t=>{
 const regional={US:fixture.US};const h=setup(t,async()=>regional);
 assert.deepEqual(await h.cache.data('festivals'),regional);
});
test('festival structure failures back off instead of retrying every 20 seconds and recover',async t=>{
 let calls=0,bad=true;
 const h=setup(t,async url=>{
  if(url.endsWith('/festivals.json')){calls++;return bad?{JP:{data:{festRecords:{nodes:null}}}}:fixture;}
  return url.includes('/locale/')?{stages:{},weapons:{}}:{data:{vsStages:{nodes:[]}}};
 });
 h.cache.start();await new Promise(setImmediate);assert.equal(calls,1);assert.match(h.errors[0][2],/数据源结构变化：festivals/);
 await h.advance(20000);assert.equal(calls,1,'20-second warmer must not retry failed festivals');
 await h.advance(40000);assert.equal(calls,2);
 await h.advance(60000);assert.equal(calls,2,'second failure doubles the backoff');
 bad=false;await h.advance(60000);assert.equal(calls,3);assert.deepEqual(await h.cache.data('festivals'),fixture);
 await h.advance(20000);assert.equal(calls,3);
});
