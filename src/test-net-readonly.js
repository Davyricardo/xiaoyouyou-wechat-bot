'use strict';
// 只读模式（XYY_REMOTE_REFRESH=0）：阿里云直连 splatoon3.ink 必然超时，数据靠香橙派推送。
// 这里锁住三条：① 不发任何远程请求 ② 后台预热不启动 ③ 新鲜缓存照常可用、过期仍拒绝。
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createDataCache,TTLS}=require('./net');
const schedule=id=>({data:{vsStages:{nodes:[{id}]}}});

function withReadOnly(fn){
  return async()=>{
    const old=process.env.XYY_REMOTE_REFRESH;
    process.env.XYY_REMOTE_REFRESH='0';
    try{await fn();}finally{
      if(old===undefined)delete process.env.XYY_REMOTE_REFRESH;else process.env.XYY_REMOTE_REFRESH=old;
    }
  };
}

test('只读模式：refresh 直接拒绝且不触发任何网络请求',withReadOnly(async()=>{
  let calls=0;
  const cache=createDataCache({base:fs.mkdtempSync(path.join(os.tmpdir(),'xyy-ro-')),loadJson:async()=>{calls++;return schedule('x');}});
  await assert.rejects(cache.refresh('schedules'),/远程刷新已关闭/);
  assert.equal(calls,0,'不应调用 loadJson');
}));

test('只读模式：start 不启动后台预热',withReadOnly(async()=>{
  let calls=0;
  const cache=createDataCache({base:fs.mkdtempSync(path.join(os.tmpdir(),'xyy-ro-')),loadJson:async()=>{calls++;return schedule('x');}});
  cache.start();
  await new Promise(r=>setTimeout(r,120));
  cache.stop();
  assert.equal(calls,0,'预热不应发起请求');
}));

test('只读模式：新鲜缓存可用，过期缓存拒绝而不联网',withReadOnly(async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-ro-'));
  let calls=0,time=1000;
  // 先用「可联网」的实例写一份缓存，模拟香橙派推来的文件
  process.env.XYY_REMOTE_REFRESH='1';
  const writer=createDataCache({base,now:()=>time,loadJson:async()=>{calls++;return schedule('pushed');}});
  await writer.data('schedules');
  process.env.XYY_REMOTE_REFRESH='0';
  const before=calls;
  const reader=createDataCache({base,now:()=>time,loadJson:async()=>{calls++;return schedule('net');}});
  assert.deepEqual(await reader.data('schedules'),schedule('pushed'));
  assert.equal(calls,before,'新鲜缓存不应联网');
  time+=TTLS.schedules+1;
  await assert.rejects(reader.data('schedules'),/远程刷新已关闭/);
  assert.equal(calls,before,'过期也不应联网');
}));
