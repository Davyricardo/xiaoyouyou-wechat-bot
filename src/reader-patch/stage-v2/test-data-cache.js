'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createDataCache}=require('./net');
const schedule=id=>({data:{vsStages:{nodes:[{id}]}}});
test('Concurrent expired reads share one request; fresh cache remains usable during proactive refresh',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-data-'));let time=1000,calls=0,release;
  const cache=createDataCache({base,now:()=>time,loadJson:async()=>{calls++;return new Promise(resolve=>release=resolve);}});
  const a=cache.data('schedules'),b=cache.data('schedules');assert.equal(calls,1);
  release(schedule('first'));assert.deepEqual(await a,await b);
  time+=70000;const refresh=cache.refresh('schedules');assert.equal(calls,2);
  assert.deepEqual(await cache.data('schedules'),schedule('first'));
  release(schedule('second'));await refresh;assert.deepEqual(await cache.data('schedules'),schedule('second'));
});
test('Invalid refresh does not overwrite cache; expired data is not served on a network failure',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-data-'));let time=1000,result=schedule('valid');
  const cache=createDataCache({base,now:()=>time,loadJson:async()=>{if(result instanceof Error)throw result;return result;}});
  await cache.data('schedules');const filename=path.join(base,'cache/schedules/schedules.json'),before=fs.readFileSync(filename);
  result={wrong:true};await assert.rejects(cache.refresh('schedules'));assert.deepEqual(fs.readFileSync(filename),before);
  assert.deepEqual(await cache.data('schedules'),schedule('valid'));
  time+=120001;result=Error('offline');await assert.rejects(cache.data('schedules'),/offline/);
  assert.deepEqual(fs.readFileSync(filename),before);
});
