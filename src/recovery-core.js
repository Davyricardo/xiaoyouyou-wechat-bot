'use strict';
// 恢复链路的共享判定与事件日志。本文件只有两类东西：
//   1) 纯函数判定（不碰 I/O，node --test 直接覆盖）；
//   2) 一个 append-only JSONL 的薄封装（appendEvent / readEvents）。
// 责任边界见 ARCHITECTURE.md：bridge 只检测（追加事件），auto-relogin 判定+执行，
// 香橙派通知器只投递 notify=true 的事件。判定逻辑只允许出现在这里或 auto-relogin.js。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');

// ---- 事件日志：唯一状态，两个主机都读 ----
function eventId(at,rand){return at+'-'+String(rand);}
function appendEvent(file,event){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const at=Number.isFinite(event&&event.at)?event.at:Date.now();
  const full={id:eventId(at,crypto.randomBytes(4).toString('hex')),...event,at};
  fs.appendFileSync(file,JSON.stringify(full)+'\n',{mode:0o600});
  return full;
}
// 容忍半行/坏行：通知端和判定端都靠它读同一个文件，一行损坏不能拖垮整轮。
function parseEvents(text){
  const out=[];
  for(const line of String(text||'').split('\n')){
    if(!line.trim())continue;
    try{const e=JSON.parse(line);if(e&&typeof e==='object'&&Number.isFinite(e.at))out.push(e);}catch{}
  }
  return out;
}
function readEvents(file,limit=400){
  let text='';
  try{text=fs.readFileSync(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  return parseEvents(text).slice(-limit);
}
function lastEvent(events,type,pred=()=>true){
  const list=Array.isArray(events)?events:[];
  for(let i=list.length-1;i>=0;i--){const e=list[i];if(e&&e.type===type&&pred(e))return e;}
  return null;
}
function latestAt(events,type){const e=lastEvent(events,type);return e?e.at:0;}

// ---- 登录判定 ----
// 成功 = 退出码 0 且 stdout/stderr 任一出现成功标记（16:42 的误判是标记落在 stderr）。
// 命令自报失败时，调用方可用状态接口复核并把结果放进 statusAfter：
// 「已经登录」是目标本身，比任何一行输出都权威。
function loginSucceeded({code,stdout='',stderr='',statusAfter}={}){
  if(code===0&&/Login successful/i.test(String(stdout)+'\n'+String(stderr)))return true;
  return statusAfter==='logged_in';
}

// ---- 服务重启判定 ----
// systemctl show -p ActiveState -p SubState -p NRestarts 的输出 → 结构化状态；坏行忽略。
function unitProps(stdout){
  const out={activeState:'unknown',subState:'unknown',nRestarts:null};
  for(const line of String(stdout||'').split('\n')){
    const i=line.indexOf('=');if(i<=0)continue;
    const k=line.slice(0,i).trim(),v=line.slice(i+1).trim();
    if(k==='ActiveState')out.activeState=v;
    else if(k==='SubState')out.subState=v;
    else if(k==='NRestarts'&&/^\d+$/.test(v))out.nRestarts=Number(v);
  }
  return out;
}
// ok=起来了；pending=还在起/还在停，继续等；failed/flapping=终态失败，立即返回。
// flapping：非 active 且 NRestarts 在涨 —— 正是 systemd 每 30 秒硬重启起不来的循环。
// deactivating 必须算 pending：TimeoutStopSec 期间旧进程还在停，判 failed 就是假失败
// （线上 5/8 条 restart 事件 ok:false 的另一半原因）。
function restartVerdict(before,after){
  if(!after||after.activeState==='unknown'||!after.activeState)return 'unknown';
  if(after.activeState==='active')return 'ok';
  if(after.activeState==='activating'||after.activeState==='reloading'||after.activeState==='deactivating')return 'pending';
  const a=after.nRestarts,b=before?before.nRestarts:null;
  if(Number.isFinite(a)&&Number.isFinite(b)&&a>b)return 'flapping';
  return 'failed';
}

// ---- 连续失败退避 ----
// 第 n 次连续失败后至少等 base*2^(n-1)，封顶 cap。base 默认 5 分钟与 timer 周期一致，
// 即第一次失败的行为和旧版相同；之后拉长，避免每 5 分钟整轮重来（REPORT-STABILITY.md 二.3）。
function backoffMs(failures,{base=5*60*1000,cap=30*60*1000}={}){
  const n=Math.max(0,Math.floor(Number(failures)||0));
  if(n<=0)return 0;
  return Math.min(cap,base*Math.pow(2,n-1));
}
function failureStreak(events,type='restart'){
  let n=0;
  const list=Array.isArray(events)?events:[];
  for(let i=list.length-1;i>=0;i--){
    const e=list[i];if(!e||e.type!==type)continue;
    if(e.ok===true)break;
    n++;
  }
  return n;
}
function restartDue({events=[],now=Date.now(),type='restart',base,cap}={}){
  const last=lastEvent(events,type);
  if(!last||last.ok===true)return true;
  return now-last.at>=backoffMs(failureStreak(events,type),{base,cap});
}

// ---- 通知判定 ----
// 判定端把结论写进事件（notify 布尔），通知端不再看原始观测。
// 同一种结果 30 分钟内只通知一次：持续失败时每轮都写一条 needs_scan，旧实现每次都推送
// （30 条连续提醒就是这个来源），cooldown 把它压成每半小时一条；恢复永远通知。
const NOTIFY_RESULTS=new Set(['recovered','needs_scan','restarted','gate_cleared','recycled']);
function notifyDecision({result,events=[],now=Date.now(),cooldownMs=30*60*1000}={}){
  if(!NOTIFY_RESULTS.has(result))return false;
  if(result==='recovered')return true;
  const last=lastEvent(events,'result',e=>e.result===result&&e.notify===true);
  return !last||now-last.at>=cooldownMs;
}
// 窗口内同类型事件的条数（回收请求、发送超时等检测信号）。
// sinceAt：只统计严格晚于这个时刻的事件——上一次回收「尝试」之前的检测事实不该再算数，
// 否则回收之后同一条旧事件会反复触发下一次回收（失败回收时尤其明显）。
function countRecent(events,type,now=Date.now(),windowMs=30*60*1000,sinceAt=0){
  const since=Number.isFinite(sinceAt)?sinceAt:0;
  return (Array.isArray(events)?events:[]).filter(e=>e&&e.type===type&&Number.isFinite(e.at)
    &&e.at<=now&&now-e.at<=windowMs&&e.at>since).length;
}

// ---- 桥接轮询退避 ----
// 连续失败时按 interval*2^n 退避，下限 minMs（默认 2s）：客户端已经卡住时不要继续高频打
// rows 请求（REPORT-STABILITY.md 三.2），上限 maxMs。
function pollBackoff({failures=0,intervalMs=250,minMs=2000,maxMs=10000}={}){
  const n=Math.max(0,Math.floor(Number(failures)||0));
  if(n<=0)return intervalMs;
  return Math.min(maxMs,Math.max(minMs,intervalMs*Math.pow(2,n)));
}

module.exports={eventId,appendEvent,parseEvents,readEvents,lastEvent,latestAt,
  loginSucceeded,unitProps,restartVerdict,backoffMs,failureStreak,restartDue,
  notifyDecision,countRecent,pollBackoff,NOTIFY_RESULTS};
