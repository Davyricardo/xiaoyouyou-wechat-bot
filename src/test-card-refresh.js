'use strict';
// 补渲染（就地重跑 salmon-schedule.js / battle-schedule.js）原来是 execFileSync：
// 会把事件循环整段堵住，期间轮询停摆、SIGTERM 也没人处理。这里守的是「异步 + 超时」两件事。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
// 用临时目录当 BASE，测试不往源码树里写文件
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-card-test-'));
process.env.XYY_HOME=TMP;
// 预生成脚本的桩：退出 0 但不产出新图（模拟「补渲染跑完却没刷新成功」）
fs.writeFileSync(path.join(TMP,'salmon-schedule.js'),'process.exit(0);');
const {refreshCard,usePrerendered,render}=require('./xiaoyouyou-v3.3');
test.after(()=>fs.rmSync(TMP,{recursive:true,force:true}));

test('等待补渲染期间事件循环仍然在跑（不再整段阻塞）',async()=>{
  fs.writeFileSync(path.join(TMP,'slow.js'),'setTimeout(()=>{},300);');
  let ticks=0;const timer=setInterval(()=>ticks++,5);
  const ok=await refreshCard('slow.js',5000);
  clearInterval(timer);
  assert.equal(ok,true);
  assert.ok(ticks>0,'300ms 的等待里定时器应被调度到');
});

test('补渲染卡住时按超时返回 false，不无限期占用主线程',async()=>{
  fs.writeFileSync(path.join(TMP,'hang.js'),'setTimeout(()=>{},60000);');
  const began=Date.now();
  const ok=await refreshCard('hang.js',300);
  assert.equal(ok,false);
  assert.ok(Date.now()-began<3000,'超时后应立即返回（300ms 超时 + 余量）');
});

test('脚本不存在 → 返回 false 而不是抛出（调用方决定降级还是拒绝）',async()=>{
  assert.equal(await refreshCard('no-such-script.js',2000),false);
});
// 预渲染图的有效期看起来 algorithmic：约定由 callers 提供 read()，
// 这里用假数据守「过期图绝不外发」这条策略（坑 14 / 坑 20）。
const pic=valid=>({path:'/tmp/fake.png',valid});

test('缓存图没过期 → 直接发，不触发补渲染',async()=>{
  let refreshed=0;
  const hit=await usePrerendered(()=>pic(true),'x.js',async()=>{refreshed++;return true;});
  assert.equal(hit.image,'/tmp/fake.png');assert.equal(hit.cached,true);assert.equal(refreshed,0);
});

test('缓存图过期但补渲染成功 → 发新图',async()=>{
  let calls=0;
  const read=()=>++calls===1?pic(false):pic(true);
  const hit=await usePrerendered(read,'x.js',async()=>true);
  assert.equal(hit.image,'/tmp/fake.png');assert.equal(calls,2);
});

test('缓存图过期且补渲染没救回来 → 抛 E_STALE_CARD（绝不退回旧图）',async()=>{
  await assert.rejects(()=>usePrerendered(()=>pic(false),'x.js',async()=>true),e=>e.code==='E_STALE_CARD');
  // 补渲染本身失败也是同一个结果
  await assert.rejects(()=>usePrerendered(()=>pic(false),'x.js',async()=>false),e=>e.code==='E_STALE_CARD');
});

test('从来没有缓存图 → 返回 null，交给现渲染（不是过期，不必拒绝）',async()=>{
  assert.equal(await usePrerendered(()=>null,'x.js',async()=>false),null);
});

test('render() 拿到过期的打工排班图时拒绝出图',async()=>{
  const dir=path.join(TMP,'cache','salmon-schedule');fs.mkdirSync(dir,{recursive:true});
  // meta 里第一段已经结束 + 一张足够大的图（salmonCardPath 要求 >10000 字节）
  fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify({rows:[{endISO:new Date(Date.now()-3600000).toISOString()}]}));
  fs.writeFileSync(path.join(dir,'current.png'),Buffer.alloc(20000,1));
  await assert.rejects(()=>render({kind:'salmon',title:'x',rounds:[]}),e=>e.code==='E_STALE_CARD');
});
