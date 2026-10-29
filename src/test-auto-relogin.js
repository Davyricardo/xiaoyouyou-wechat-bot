'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decide,shouldRecycle,recycleReason,lastRecycleAttemptAt,settleAuth,skipLoginAfterRestart}=require('../tools/auto-relogin');
const GRACE=2*60*1000;
const blocked=ageMs=>({code:'XYY-1-01234567',phase:'blocked',ageMs});

test('gate blocked 且在扫码宽限内 → skip_gate（即使已掉线）',()=>{
 assert.equal(decide({auth:'logged_out',gate:blocked(60*1000),bridgeActive:true}),'skip_gate');
});

test('gate blocked 宽限内 + 已登录 → 仍然 skip_gate（让路给恢复流程）',()=>{
 assert.equal(decide({auth:'logged_in',gate:blocked(30*1000),bridgeActive:true}),'skip_gate');
});

test('gate ageMs 刚好等于宽限 → 不再跳过，掉线走 login',()=>{
 assert.equal(decide({auth:'logged_out',gate:blocked(GRACE),bridgeActive:true}),'login');
});

test('gate 超过宽限 + 已登录 → clear_gate（否则桥接永远空转）',()=>{
 assert.equal(decide({auth:'logged_in',gate:blocked(GRACE+1),bridgeActive:true}),'clear_gate');
});

test('gate 超过宽限 + 已掉线 → login（不因 gate 停摆）',()=>{
 assert.equal(decide({auth:'logged_out',gate:blocked(10*60*1000),bridgeActive:true}),'login');
});

test('gate 超过宽限 + 已登录 + 桥接停止 → 先 clear_gate，下一轮再重启',()=>{
 assert.equal(decide({auth:'logged_in',gate:blocked(5*60*1000),bridgeActive:false}),'clear_gate');
});

test('gate phase 是 resume 不算跳过 → logged_in 且桥接停止则 restart_bridge',()=>{
 assert.equal(decide({auth:'logged_in',gate:{phase:'resume',ageMs:1000},bridgeActive:false}),'restart_bridge');
});

test('已登录且桥接在跑 → noop',()=>{
 assert.equal(decide({auth:'logged_in',gate:null,bridgeActive:true}),'noop');
});

test('已登录但桥接停止 → restart_bridge',()=>{
 assert.equal(decide({auth:'logged_in',gate:null,bridgeActive:false}),'restart_bridge');
});

test('已掉线 → login',()=>{
 assert.equal(decide({auth:'logged_out',gate:null,bridgeActive:true}),'login');
});

test('auth 取不到 → noop（瞬时故障不折腾）',()=>{
 for(const auth of ['unknown',undefined,null,'']){
  assert.equal(decide({auth,gate:null,bridgeActive:false}),'noop');
 }
});

test('无参数 / 缺字段不抛异常',()=>{
 assert.equal(decide(),'noop');
 assert.equal(decide({}),'noop');
 assert.equal(decide({gate:{phase:'blocked'}}),'noop');   // 没有 ageMs 不拦也不清
});

test('状态连续读不到 1 次 → 仍然 noop（给它一次机会）',()=>{
 assert.equal(decide({auth:'unknown',gate:null,bridgeActive:true,unknownStreak:1}),'noop');
});

test('状态连续读不到 2 次 → 按掉线处理，走 login',()=>{
 assert.equal(decide({auth:'unknown',gate:null,bridgeActive:true,unknownStreak:2}),'login');
});

test('状态连续读不到多次 → 仍然 login（不放弃）',()=>{
 assert.equal(decide({auth:'unknown',gate:null,bridgeActive:false,unknownStreak:9}),'login');
});

test('gate 在扫码宽限内时，unknown 也不抢（让路优先）',()=>{
 assert.equal(decide({auth:'unknown',gate:blocked(30*1000),bridgeActive:true,unknownStreak:5}),'skip_gate');
});

test('logged_in / logged_out 的 streak 不参与判定',()=>{
 assert.equal(decide({auth:'logged_in',gate:null,bridgeActive:true,unknownStreak:99}),'noop');
 assert.equal(decide({auth:'logged_out',gate:null,bridgeActive:true,unknownStreak:99}),'login');
});

test('已登录 + 内存达阈值 → 主动回收',()=>{
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:700,gate:null,events:[],now:10*60*60*1000}),true);
});

test('内存差 1MB 未达阈值 → 不回收',()=>{
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:699,gate:null,events:[],now:10*60*60*1000}),false);
});

// 判据从 memory.current（含 page cache）改成 anon 之后，这条回归最重要：
// 线上 current 600-670MB 时 anon 只有 300 多，那大半是可回收的 page cache，
// 以前全被当成「卡死前兆」误杀（每误杀一次就多赌一次免扫码登录）。
// 现在调用方传进来的是 anon，300MB 就不该触发。
test('anon 300MB（同一时刻 current 可能到 900MB）→ 不回收',()=>{
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events:[],now:10*60*60*1000}),false);
});

test('cgroup 真发生 oom_kill → 立刻回收，不用等 anon 到线',()=>{
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,oomKilled:true,gate:null,events:[],now:10*60*60*1000}),true);
});

test('已掉线时不做回收（登录流程会处理）',()=>{
 assert.equal(shouldRecycle({auth:'logged_out',containerMB:900,gate:null,events:[],now:10*60*60*1000}),false);
});

test('距上次回收不足 45 分钟 → 不回收（防抖，依据事件日志里的 recycled）',()=>{
 const now=10*60*60*1000;
 const recent=[{type:'result',result:'recycled',at:now-30*60*1000}];
 const older=[{type:'result',result:'recycled',at:now-46*60*1000}];
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:900,gate:null,events:recent,now}),false);
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:900,gate:null,events:older,now}),true);
});

test('扫码宽限内的 blocked gate → 不回收（别打断恢复）',()=>{
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:900,gate:{phase:'blocked',ageMs:30*1000},events:[],now:10*60*60*1000}),false);
});

test('内存读不到（null/NaN）→ 不回收',()=>{
 for(const v of [null,undefined,NaN,'x']){
  assert.equal(shouldRecycle({auth:'logged_in',containerMB:v,gate:null,events:[],now:10*60*60*1000}),false);
 }
});

test('桥接写了一条发送超时事件 → 不等内存到线也回收',()=>{
 const now=10*60*60*1000;
 const events=[{type:'send_timeout',reason:'send timeout',at:now-60*1000}];
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events,now}),true);
});

test('发送超时事件过期（超过 30 分钟）→ 不回收',()=>{
 const now=10*60*60*1000;
 const events=[{type:'send_timeout',at:now-31*60*1000}];
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events,now}),false);
});

test('未知 auth + 15 分钟内 2 次超时 → 仍回收（卡死时状态接口先读不到）',()=>{
 const now=10*60*60*1000;
 const events=[{type:'send_timeout',at:now-60*1000},{type:'send_timeout',at:now-5*60*1000}];
 assert.equal(shouldRecycle({auth:'unknown',containerMB:null,gate:null,events,now}),true);
});

test('1 次超时 + unknown auth → 不回收（单次等下次采样）',()=>{
 const now=10*60*60*1000;
 const events=[{type:'send_timeout',at:now-60*1000}];
 assert.equal(shouldRecycle({auth:'unknown',containerMB:null,gate:null,events,now}),false);
});

test('超时触发的回收也有 15 分钟间隔',()=>{
 const now=10*60*60*1000;
 const hit=[{type:'send_timeout',at:now-60*1000}];
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events:[{type:'result',result:'recycled',at:now-10*60*1000},...hit],now}),false);
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events:[{type:'result',result:'recycled',at:now-16*60*1000},...hit],now}),true);
});

test('掉线时不因发送超时事件而动（登录流程优先）',()=>{
 const now=10*60*60*1000;
 const events=[{type:'send_timeout',at:now},{type:'send_timeout',at:now-1000}];
 assert.equal(shouldRecycle({auth:'logged_out',containerMB:900,gate:null,events,now}),false);
});

test('事件日志里的 restart 记录不影响回收判据',()=>{
 const now=10*60*60*1000;
 const events=[{type:'restart',ok:false,at:now-1000}];
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events,now}),false);
});

test('gate 宽度内 + 超时事件 → 仍不回收（恢复流程优先）',()=>{
 const now=10*60*60*1000;
 const events=[{type:'send_timeout',at:now-1000},{type:'send_timeout',at:now-2000}];
 assert.equal(shouldRecycle({auth:'unknown',containerMB:null,gate:{phase:'blocked',ageMs:30*1000},events,now}),false);
});

test('回收失败也算一次尝试：同一批旧超时不会再次触发回收',()=>{
 const now=10*60*60*1000;
 // needs_scan + recycle_login_failed = 上一次回收动过容器但没成功；
 // 那两条超时事件是回收「之前」写的，不该再把容器重启一遍。
 const events=[{type:'result',result:'needs_scan',reason:'recycle_login_failed',at:now-60*1000},
  {type:'send_timeout',at:now-2*60*1000},{type:'send_timeout',at:now-3*60*1000}];
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events,now}),false);
});

test('回收尝试之后新写入的超时才回收（旧事件被 since 过滤掉）',()=>{
 const now=10*60*60*1000;
 const events=[{type:'recycle_attempt',at:now-20*60*1000},{type:'send_timeout',at:now-60*1000}];
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events,now}),true);
});

test('recycle_attempt 计入 15 分钟最小间隔',()=>{
 const now=10*60*60*1000;
 const events=[{type:'recycle_attempt',at:now-60*1000},{type:'send_timeout',at:now-30*1000}];
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,events,now}),false);
 assert.equal(recycleReason({auth:'logged_in',containerMB:900,gate:null,events,now}),null,'内存超阈值也要等满 45 分钟');
});

test('只有回收相关的失败算「尝试」：登录失败、桥接重启失败都不算',()=>{
 const now=10*60*60*1000;
 assert.equal(lastRecycleAttemptAt([]),0);
 assert.equal(lastRecycleAttemptAt([{type:'result',result:'needs_scan',reason:'login_failed',at:now}]),0);
 assert.equal(lastRecycleAttemptAt([{type:'restart',ok:false,at:now}]),0);
 assert.equal(lastRecycleAttemptAt([{type:'result',result:'recycled',at:now}]),now);
 assert.equal(lastRecycleAttemptAt([{type:'result',result:'needs_scan',reason:'container_not_running',at:now}]),now);
 assert.equal(lastRecycleAttemptAt([{type:'recycle_attempt',at:now-500},{type:'result',result:'recycled',at:now}]),now);
});

test('桥接连续拉不到消息（poll_stuck）→ 回收，不要求已退出登录',()=>{
 const now=10*60*60*1000;
 const events=[{type:'poll_stuck',streak:10,at:now-60*1000}];
 assert.equal(recycleReason({auth:'logged_in',containerMB:300,gate:null,events,now}),'poll_stuck');
 assert.equal(recycleReason({auth:'unknown',containerMB:null,gate:null,events,now}),'poll_stuck');
});

test('poll_stuck 过期或已处理过 → 不回收',()=>{
 const now=10*60*60*1000;
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,
   events:[{type:'poll_stuck',at:now-31*60*1000}],now}),false,'超过 15 分钟窗口');
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,
   events:[{type:'recycle_attempt',at:now-60*1000},{type:'poll_stuck',at:now-30*1000}],now}),false,'15 分钟最小间隔');
 assert.equal(shouldRecycle({auth:'logged_in',containerMB:300,gate:null,
   events:[{type:'poll_stuck',at:now-60*1000},{type:'recycle_attempt',at:now-30*1000}],now}),false,'已在回收之后再拉不起来也先等着');
});

test('正常掉线时不因 poll_stuck 重启容器（走登录流程）',()=>{
 const now=10*60*60*1000;
 assert.equal(shouldRecycle({auth:'logged_out',containerMB:900,gate:null,
   events:[{type:'poll_stuck',at:now-1000}],now}),false);
});

// —— 第 5 项：容器重启后已稳定 logged_in 时跳过 wx auth login（坑 2 的抢登录）——
const noWait=async()=>{};
const seq=list=>{let i=0;return async()=>({auth:list[Math.min(i++,list.length-1)]});};

test('重启后一直是 logged_in → 稳定，跳过登录',async()=>{
 const r=await settleAuth(seq(['logged_in']),noWait);
 assert.deepEqual(r,{auth:'logged_in',stable:true});
 assert.equal(skipLoginAfterRestart(r),true);
});

test('先给 logged_out 再自己 attach 成 logged_in → 等到稳定后跳过登录',async()=>{
 // 这正是线上「本来能自己好，被我们按死了」的场景：抢在 attach 之前登录会把它顶掉。
 const r=await settleAuth(seq(['logged_out','logged_out','logged_in','logged_in','logged_in']),noWait);
 assert.deepEqual(r,{auth:'logged_in',stable:true});
 assert.equal(skipLoginAfterRestart(r),true);
});

test('一直是 logged_out → 不稳定也不跳过，仍走登录流程',async()=>{
 const r=await settleAuth(seq(['logged_out']),noWait);
 assert.deepEqual(r,{auth:'logged_out',stable:true});
 assert.equal(skipLoginAfterRestart(r),false,'稳定但未登录 → 照旧登录');
});

test('状态一直是 unknown（接口还没起来）→ 不跳过',async()=>{
 const r=await settleAuth(seq(['unknown']),noWait);
 assert.deepEqual(r,{auth:'unknown',stable:false});
 assert.equal(skipLoginAfterRestart(r),false);
});

test('logged_in 与 unknown 来回跳 → 不算稳定，不跳过（宁可多赌一次登录）',async()=>{
 const r=await settleAuth(seq(['logged_in','unknown','logged_in','unknown','logged_in','unknown']),noWait,6,0);
 assert.equal(r.stable,false);
 assert.equal(skipLoginAfterRestart(r),false,'即使最后一次是 logged_in');
});

test('状态接口抛异常 → 不跳过也不抛出',async()=>{
 const r=await settleAuth(async()=>{throw new Error('connect ECONNREFUSED');},noWait,3,0);
 assert.deepEqual(r,{auth:'unknown',stable:false});
 assert.equal(skipLoginAfterRestart(r),false);
});

test('settleAuth 最多读 rounds 次就返回（不会一直等）',async()=>{
 let calls=0;
 const r=await settleAuth(async()=>{calls++;return {auth:'unknown'};},noWait,4,0);
 assert.equal(calls,4);
 assert.equal(r.stable,false);
});

test('skipLoginAfterRestart 的边界输入',()=>{
 for(const v of [undefined,null,{},null,{auth:null},{auth:'logged_in'},{stable:true},{auth:'logged_in',stable:false}]){
  assert.equal(skipLoginAfterRestart(v),false,String(JSON.stringify(v)));
 }
 assert.equal(skipLoginAfterRestart({auth:'logged_in',stable:true}),true);
});
