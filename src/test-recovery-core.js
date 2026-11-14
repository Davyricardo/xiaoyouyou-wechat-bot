'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const core=require('./recovery-core');

// ---- 登录判定 ----
test('登录：退出码 0 + stdout 命中 → 成功',()=>{
 assert.equal(core.loginSucceeded({code:0,stdout:'Login successful'}),true);
});
test('登录：成功标记落在 stderr 且退出码 0 → 仍算成功（16:42 的误判）',()=>{
 assert.equal(core.loginSucceeded({code:0,stdout:'',stderr:'warn\nLogin successful'}),true);
});
test('登录：退出码非 0 但有状态复核 logged_in → 成功（状态比输出权威）',()=>{
 assert.equal(core.loginSucceeded({code:1,stdout:'',stderr:'timeout',statusAfter:'logged_in'}),true);
});
test('登录：退出码 0 但没有任何成功标记且状态未登录 → 失败',()=>{
 assert.equal(core.loginSucceeded({code:0,stdout:'waiting for scan'}),false);
});
test('登录：非 0 且状态仍是 logged_out → 失败',()=>{
 assert.equal(core.loginSucceeded({code:2,stdout:'',stderr:'Login successful? no',statusAfter:'logged_out'}),false);
});
test('登录：成功标记大小写/多余输出不影响',()=>{
 assert.equal(core.loginSucceeded({code:0,stdout:'[ok] login SUCCESSFUL done'}),true);
});
test('登录：缺参数不抛异常且判失败',()=>{
 assert.equal(core.loginSucceeded({}),false);
 assert.equal(core.loginSucceeded({code:0}),false);
});

// ---- systemctl show 解析 ----
const PROPS='ActiveState=active\nSubState=running\nNRestarts=3\n';
test('systemctl：解析三个字段',()=>{
 assert.deepEqual(core.unitProps(PROPS),{activeState:'active',subState:'running',nRestarts:3});
});
test('systemctl：坏行/缺字段 → unknown，不抛',()=>{
 assert.deepEqual(core.unitProps('garbage\nActiveState=\n=x'),{activeState:'',subState:'unknown',nRestarts:null});
 assert.deepEqual(core.unitProps(null),{activeState:'unknown',subState:'unknown',nRestarts:null});
});
test('systemctl：NRestarts 非数字忽略',()=>{
 assert.equal(core.unitProps('NRestarts=abc').nRestarts,null);
});

// ---- 重启结果判定 ----
const p=(activeState,subState='x',nRestarts=0)=>({activeState,subState,nRestarts});
test('重启：active → ok',()=>assert.equal(core.restartVerdict(p('active'),p('active')),'ok'));
test('重启：activating → pending（继续等，不判失败）',()=>{
 assert.equal(core.restartVerdict(p('activating'),p('activating')),'pending');
});
test('重启：reloading → pending',()=>assert.equal(core.restartVerdict(p('active'),p('reloading')),'pending'));
test('重启：failed 且重启计数在涨 → flapping',()=>{
 assert.equal(core.restartVerdict(p('failed','failed',7),p('failed','failed',8)),'flapping');
});
test('重启：failed 且计数未涨 → failed',()=>{
 assert.equal(core.restartVerdict(p('failed','failed',8),p('failed','failed',8)),'failed');
});
test('重启：读不到状态 → unknown（不当成功也不当失败）',()=>{
 assert.equal(core.restartVerdict(p('active'),null),'unknown');
});
test('重启：计数从 null 到数字不算 flapping',()=>{
 assert.equal(core.restartVerdict(p('failed','failed',null),p('failed','failed',4)),'failed');
});

// ---- 指数退避 ----
test('退避：0 次失败不等待',()=>assert.equal(core.backoffMs(0),0));
test('退避：第 1 次失败 = base（与 timer 5 分钟一致，行为不变）',()=>{
 assert.equal(core.backoffMs(1,{base:300000,cap:1800000}),300000);
});
test('退避：逐次翻倍并封顶',()=>{
 const o={base:300000,cap:1800000};
 assert.deepEqual([2,3,4,5,9].map(n=>core.backoffMs(n,o)),[600000,1200000,1800000,1800000,1800000]);
});
test('退避：非法输入按 0 处理',()=>{
 for(const v of [undefined,null,NaN,-3,'x'])assert.equal(core.backoffMs(v),0);
});
test('失败 streak：只数最后一条成功之后的失败',()=>{
 const ev=[{type:'restart',ok:false,at:1},{type:'restart',ok:true,at:2},{type:'restart',ok:false,at:3},{type:'restart',ok:false,at:4}];
 assert.equal(core.failureStreak(ev),2);
});
test('失败 streak：其它类型事件不打断',()=>{
 const ev=[{type:'restart',ok:false,at:1},{type:'result',result:'needs_scan',at:2},{type:'restart',ok:false,at:3}];
 assert.equal(core.failureStreak(ev),2);
});
test('restartDue：没有记录 → 立刻可试',()=>{
 assert.equal(core.restartDue({events:[],now:1}),true);
});
test('restartDue：上次成功 → 立刻可试',()=>{
 assert.equal(core.restartDue({events:[{type:'restart',ok:true,at:1}],now:2}),true);
});
test('restartDue：连续失败按退避压住',()=>{
 const events=[{type:'restart',ok:false,at:0},{type:'restart',ok:false,at:1000}];
 assert.equal(core.restartDue({events,now:1000+600000-1}),false);
 assert.equal(core.restartDue({events,now:1000+600000}),true);
});
test('restartDue：成功一次后 streak 清零',()=>{
 const events=[{type:'restart',ok:false,at:0},{type:'restart',ok:true,at:1000},{type:'restart',ok:false,at:2000}];
 assert.equal(core.restartDue({events,now:2000+300000}),true);
});

// ---- 通知去重 ----
test('通知：recovered 永远通知',()=>{
 const events=[{type:'result',result:'recovered',notify:true,at:100}];
 assert.equal(core.notifyDecision({result:'recovered',events,now:101}),true);
});
test('通知：同结果 30 分钟冷却内只通知一次',()=>{
 const events=[{type:'result',result:'needs_scan',notify:true,at:1000}];
 assert.equal(core.notifyDecision({result:'needs_scan',events,now:1000+1800000-1}),false);
 assert.equal(core.notifyDecision({result:'needs_scan',events,now:1000+1800000}),true);
});
test('通知：被冷却拦下的事件 notify=false 不占用冷却',()=>{
 const events=[{type:'result',result:'needs_scan',notify:false,at:1000}];
 assert.equal(core.notifyDecision({result:'needs_scan',events,now:1001}),true);
});
test('通知：noop/skipped 永不通知',()=>{
 for(const r of ['noop','skipped','recycled'])assert.equal(core.notifyDecision({result:r,events:[],now:1}),r==='recycled');
});
test('通知：不同结果各自独立冷却',()=>{
 const events=[{type:'result',result:'recycled',notify:true,at:1000}];
 assert.equal(core.notifyDecision({result:'needs_scan',events,now:1001}),true);
});

// ---- 检测信号计数（回收请求/发送超时）----
test('countRecent：只数窗口内同类型事件',()=>{
 const now=1000000,ev=[
  {type:'recycle_request',at:now-1000},{type:'recycle_request',at:now-2000},
  {type:'recycle_request',at:now-999999},{type:'send_timeout',at:now-1000},{type:'recycle_request',at:now+5000}];
 assert.equal(core.countRecent(ev,'recycle_request',now,900000),2);
});
test('countRecent：坏输入不抛',()=>{
 assert.equal(core.countRecent(null,'x',1),0);
 assert.equal(core.countRecent([null,{type:'x',at:'x'}],'x',1),0);
});

// ---- 桥接轮询退避 ----
test('pollBackoff：无失败用基础间隔',()=>{
 assert.equal(core.pollBackoff({failures:0,intervalMs:250}),250);
});
test('pollBackoff：失败后不低 minMs（旧实现 250ms 打出卡死客户端）',()=>{
 assert.equal(core.pollBackoff({failures:1,intervalMs:250,minMs:2000}),2000);
});
test('pollBackoff：逐次翻倍并封顶',()=>{
 assert.deepEqual([1,2,3,4,5,9].map(n=>core.pollBackoff({failures:n,intervalMs:500,minMs:2000,maxMs:10000})),[2000,2000,4000,8000,10000,10000]);
});

// ---- JSONL 事件日志 ----
test('JSONL：append 后可读回，id 唯一且带时间戳',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-core-'));
 const file=path.join(dir,'events.jsonl');
 const a=core.appendEvent(file,{type:'check',at:1000});
 const b=core.appendEvent(file,{type:'check',at:1000});
 const list=core.readEvents(file);
 assert.equal(list.length,2);
 assert.notEqual(a.id,b.id);
 assert.equal(list[1].id,b.id);
 assert.deepEqual(list[0],{id:a.id,type:'check',at:1000});
});
test('JSONL：缺 at 自动补当前时间',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-core-'));
 const e=core.appendEvent(path.join(dir,'e.jsonl'),{type:'x'});
 assert.ok(Number.isFinite(e.at)&&e.at>0);
});
test('JSONL：半行/坏行被跳过，不拖垮整轮',()=>{
 assert.deepEqual(core.parseEvents('{"at":1,"type":"a"}\n{bad\n\n{"at":2,"type":"b"}\n{"type":"no-at"}\n'),[{at:1,type:'a'},{at:2,type:'b'}]);
});
test('JSONL：文件不存在 → 空数组，不抛',()=>{
 assert.deepEqual(core.readEvents(path.join(os.tmpdir(),'nope-'+process.pid+'.jsonl')),[]);
});
test('lastEvent：取最后一条匹配记录',()=>{
 const ev=[{type:'result',at:1},{type:'x',at:2},{type:'result',at:3}];
 assert.equal(core.lastEvent(ev,'result').at,3);
 assert.equal(core.lastEvent(ev,'nope'),null);
});

// ---- 真实追加不丢内容（appendFileSync，非整文件重写）----
test('JSONL：并发追加不互相覆盖（整文件重写的竞态回归）',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-core-'));
 const file=path.join(dir,'e.jsonl');
 for(let i=0;i<50;i++)core.appendEvent(file,{type:'t',at:i});
 const list=core.readEvents(file,1000);
 assert.equal(list.length,50);
 assert.equal(new Set(list.map(e=>e.id)).size,50);
});

// ---- 登录失败退避 & phone_confirm/qr_required 通知去重 ----
test('loginFailureStreak 与 loginDue：前两次 5m 间隔，后续 15m/30m/60m 退避并在恢复后清零',()=>{
 const m=60*1000;
 assert.equal(core.loginFailureStreak([]),0);
 assert.equal(core.loginDue({events:[],now:1000}),true);

 const f1=[{type:'result',result:'needs_scan',reason:'login_failed',ok:false,at:0}];
 assert.equal(core.loginFailureStreak(f1),1);
 assert.equal(core.loginDue({events:f1,now:5*m-1}),false);
 assert.equal(core.loginDue({events:f1,now:5*m}),true);

 const f2=[...f1,{type:'result',result:'needs_scan',reason:'login_failed',ok:false,at:5*m}];
 assert.equal(core.loginFailureStreak(f2),2);
 assert.equal(core.loginDue({events:f2,now:5*m+15*m-1}),false);
 assert.equal(core.loginDue({events:f2,now:5*m+15*m}),true);

 const f3=[...f2,{type:'result',result:'login_failed',ok:false,at:20*m}];
 assert.equal(core.loginFailureStreak(f3),3);
 assert.equal(core.loginDue({events:f3,now:20*m+30*m-1}),false);
 assert.equal(core.loginDue({events:f3,now:20*m+30*m}),true);

 const f4=[...f3,{type:'result',result:'login_failed',ok:false,at:50*m}];
 assert.equal(core.loginFailureStreak(f4),4);
 assert.equal(core.loginDue({events:f4,now:50*m+60*m-1}),false);
 assert.equal(core.loginDue({events:f4,now:50*m+60*m}),true);

 // ok=true 或 qr_required/phone_confirm/noop 影响
 const withNoop=[...f2,{type:'result',result:'noop',ok:false,at:10*m}];
 assert.equal(core.loginFailureStreak(withNoop),2,'noop 不打断 streak');
 assert.equal(core.loginFailureStreak([...f3,{type:'result',result:'recovered',ok:true,at:30*m}]),0);
 assert.equal(core.loginFailureStreak([...f3,{type:'result',result:'needs_scan',reason:'phone_confirm',ok:false,at:30*m}]),0);
});

test('notifyDecision：phone_confirm 独立 5 分钟冷却，不被先前 needs_scan 冷却压住',()=>{
 const m=60*1000,t0=1000000;
 const prior=[
  {type:'result',result:'needs_scan',reason:'login_failed',notify:true,at:t0},
  {type:'result',result:'needs_scan',reason:'qr_required',notify:true,at:t0+m},
 ];
 // 刚发过 needs_scan(login_failed/qr_required) 2 分钟，此时 phone_confirm 仍应立刻通知
 assert.equal(core.notifyDecision({result:'needs_scan',reason:'phone_confirm',events:prior,now:t0+2*m}),true);
 const withPhone=[...prior,{type:'result',result:'needs_scan',reason:'phone_confirm',notify:true,at:t0+2*m}];
 assert.equal(core.notifyDecision({result:'needs_scan',reason:'phone_confirm',events:withPhone,now:t0+2*m+5*m-1}),false);
 assert.equal(core.notifyDecision({result:'needs_scan',reason:'phone_confirm',events:withPhone,now:t0+2*m+5*m}),true);
 // qr_required 按 2 小时去重
 assert.equal(core.notifyDecision({result:'needs_scan',reason:'qr_required',events:prior,now:t0+m+60*m}),false);
 assert.equal(core.notifyDecision({result:'needs_scan',reason:'qr_required',events:prior,now:t0+m+120*m}),true);
});
