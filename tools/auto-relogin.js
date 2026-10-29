#!/usr/bin/env node
'use strict';
// 小鱿鱿掉线自动恢复（阿里云侧）：判定 -> 自动登录 -> 重启桥接 -> 写结果事件供香橙派通知。
// 由 xiaoyouyou-auto-relogin.timer 每 5 分钟拉起；XYY_DRY=1 只打印判定，不动服务和登录。
// 凭据只在 wx-client 子进程内使用：本文件绝不打印登录输出，日志里只有判定和布尔结果。
// 责任边界见 ARCHITECTURE.md：本文件是唯一判定者和执行者；bridge 只写检测事实，香橙派只投递事件。
const fs=require('node:fs'),path=require('node:path'),{execFile,spawn}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile);
// 部署时 auto-relogin.js 与 recovery-core.js 同目录（都在 /opt/xiaoyouyou）；仓库内后者在 src/。
const CORE=path.join(__dirname,'recovery-core');
const core=require(fs.existsSync(CORE+'.js')?CORE:path.join(__dirname,'..','src','recovery-core'));
const HOME=process.env.XYY_HOME||'/opt/xiaoyouyou';
const STATE=path.join(HOME,'private/.local/state/splatoon-bridge');
const EVENTS=process.env.XYY_EVENTS_FILE||path.join(STATE,'recovery-events.jsonl');  // 唯一状态：append-only 事件
const GATE=path.join(STATE,'login-gate.json');
const UNIT='xiaoyouyou-aliyun.service';
const GATE_GRACE=2*60*1000;     // 只给真实扫码留 2 分钟窗口：超过就自己接管，不再等审批
const UNKNOWN=path.join(STATE,'auto-relogin-unknown.json');   // 连续读不到状态的计数
const MEM=path.join(STATE,'memory-samples.log');             // 容器内存采样（查卡死根因）
const UNKNOWN_LIMIT=2;         // 连续 2 次（约 10 分钟）读不到就当掉线处理
// 容器内存阈值（MB）。⚠ v3.4 用的是 memory.current，它包含 page cache：
// 线上实测同一个时刻 anon=321MB、file=105MB、current=430MB，而微信读库同步消息时
// page cache 会冲到 600-670MB —— 于是「内存 ≥600MB」这条判据把正常的页缓存当成了卡死前兆，
// 每触发一次就 docker restart 一次，等于白白多赌一次免扫码登录（事件日志里
// 「内存 603MB / 637MB / 651MB / 671MB ≥ 阈值 600MB」都是这一类）。
// 现在只按 anon（真正的工作集）判定，并用 memory.events 的 oom_kill 兜底。
const MEM_LIMIT=Number(process.env.XYY_ANON_LIMIT_MB||700);
// 内存触发的两次回收最小间隔。默认 45 分钟：回收要重启+登录约 90 秒，太频繁反而增加卡死窗口。
const RECYCLE_GAP=Number(process.env.XYY_RECYCLE_GAP_MS||45*60*1000);
const REQUEST_GAP=Number(process.env.XYY_RECYCLE_REQUEST_GAP_MS||15*60*1000);  // 超时触发回收的最小间隔
const TIMEOUT_WINDOW=15*60*1000;   // 15 分钟内 2 次发送超时即视为卡死
const TIMEOUT_LIMIT=Number(process.env.XYY_TIMEOUT_LIMIT||2);
const REQUEST_WINDOW=30*60*1000;   // 单次发送超时在这段时间内都算是「刚刚卡住」
// 一次「上次回收尝试」的标记：成功的 recycled 和失败的回收都算。失败回收没记的话，
// 同一条旧超时事件会每隔 5 分钟又把容器重启一次（needs_scan 之后尤其常见）。
const RECYCLE_ATTEMPT_REASONS=new Set(['recycle_login_failed','bridge_not_active','container_not_running']);
// 桥接连续拉不到消息（poll_stuck）在这个窗口内出现过，就认为客户端已经卡住。
const POLL_STUCK_WINDOW=Number(process.env.XYY_POLL_STUCK_WINDOW_MS||15*60*1000);
const RESTART_WAIT_MS=Number(process.env.XYY_RESTART_WAIT_MS||90000);
// 容器刚启动的这段时间里，status 会先给 logged_out、几秒后才自己 attach 成 logged_in。
// 此时抢着 wx auth login 会打断客户端自己的免扫码登录（它会把正在进行的 attach 顶掉），
// 结果就是「本来能自己好，被我们按死了」。所以容器起来不足 3 分钟时，logged_out 先不动手。
const BOOT_SETTLE_MS=Number(process.env.XYY_BOOT_SETTLE_MS||3*60*1000);
// 连续启动失败退避：第 1 次失败与 timer 周期（5 分钟）一致，之后翻倍，封顶 30 分钟。
// 依据 REPORT-STABILITY.md 三.2：已知起不来的服务不该每轮重来。
const BACKOFF_BASE=Number(process.env.XYY_BACKOFF_BASE_MS||5*60*1000);
const BACKOFF_CAP=Number(process.env.XYY_BACKOFF_CAP_MS||30*60*1000);
const DRY=process.env.XYY_DRY==='1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function gateBlocks(gate){
  return Boolean(gate&&gate.phase==='blocked'&&Number.isFinite(gate.ageMs)&&gate.ageMs<GATE_GRACE);
}
// 纯函数：三份观测 -> 本轮动作。auth 取不到（undefined/'unknown'）时按 noop 处理，瞬时故障不折腾。
// blocked 的 gate 只在 2 分钟扫码宽限内让路；超过宽限就自己接管——否则审批式恢复流程一建 gate，
// 自动登录会永远 skip_gate，机器人一直哑着等一个不会来的批准。
function decide({auth,gate,bridgeActive,unknownStreak=0}={}){
  const blocked=Boolean(gate&&gate.phase==='blocked'&&Number.isFinite(gate.ageMs));
  if(blocked&&gate.ageMs<GATE_GRACE)return 'skip_gate';
  if(blocked&&auth==='logged_in')return 'clear_gate';
  if(auth==='logged_in')return bridgeActive?'noop':'restart_bridge';
  if(auth==='logged_out')return 'login';
  // 客户端卡死/重启中时状态接口读不到：连续读不到说明它不会自己好了，按掉线处理。
  if(Number.isFinite(unknownStreak)&&unknownStreak>=UNKNOWN_LIMIT)return 'login';
  return 'noop';
}
// 主动回收的判据顺序：内存 > 反复发送超时 > 单次发送超时请求。
// 关键点：卡死时容器的状态接口往往先读不到（实测 auth 会变成 unknown / app_not_running），
// 所以「超时」这条判据不能要求 auth=logged_in —— 否则它恰好在最需要的时候失效。
// 仍然排除 logged_out：那是正常掉线，走登录流程，重启容器只会白白丢掉会话。
// 全部输入来自事件日志（bridge 写的 send_timeout）和本轮采样，没有其它状态文件。
// 上次「尝试回收」的时刻。成功的 recycled 算，失败的也算（needs_scan + recycle_* 的 reason，
// 以及 recycle() 开头写的 recycle_attempt 事件）：只要动过一次容器，之后的检测事实才重新计数。
function lastRecycleAttemptAt(events){
  const list=Array.isArray(events)?events:[];
  let at=0;
  for(const e of list){
    if(!e||!Number.isFinite(e.at))continue;
    if(e.type==='recycle_attempt')at=Math.max(at,e.at);
    else if(e.type==='result'&&(e.result==='recycled'||e.result==='needs_scan'&&RECYCLE_ATTEMPT_REASONS.has(e.reason)))at=Math.max(at,e.at);
  }
  return at;
}
function recycleReason({auth,containerMB,oomKilled=false,gate,events=[],now=Date.now(),limit=MEM_LIMIT,gap=RECYCLE_GAP,
  requestGap=REQUEST_GAP,timeoutWindow=TIMEOUT_WINDOW,requestWindow=REQUEST_WINDOW,timeoutLimit=TIMEOUT_LIMIT,
  pollWindow=POLL_STUCK_WINDOW}={}){
  if(gateBlocks(gate))return null;
  const lastAttemptAt=lastRecycleAttemptAt(events);
  const gapOk=now-lastAttemptAt>=gap, reqGapOk=now-lastAttemptAt>=requestGap;
  // 只数上次回收「尝试」之后写入的检测事实：旧事件不再重复触发回收。
  const recentTimeouts=core.countRecent(events,'send_timeout',now,requestWindow,lastAttemptAt);
  const burstTimeouts=core.countRecent(events,'send_timeout',now,timeoutWindow,lastAttemptAt);
  const stuckPolls=core.countRecent(events,'poll_stuck',now,pollWindow,lastAttemptAt);
  // cgroup 真的 OOM 过：这条最硬，不需要等 anon 涨到线。
  const oomHit=oomKilled&&auth!=='logged_out'&&gapOk;
  const memHit=auth==='logged_in'&&Number.isFinite(containerMB)&&containerMB>=limit&&gapOk;
  // 短时间内 2 次发送超时说明客户端在没到内存阈值时就已经卡了。
  const timeoutHit=auth!=='logged_out'&&burstTimeouts>=timeoutLimit&&reqGapOk;
  // 桥接报告发送超时（客户端已卡住）时不必等内存到线。
  const reqHit=auth==='logged_in'&&recentTimeouts>0&&reqGapOk;
  // 桥接连续拉不到消息：这时 status 可能还是 logged_in、也可能压根没人 @，
  // 既有的三条判据一条都够不着，poll_stuck 是唯一的线索。
  const pollHit=auth!=='logged_out'&&stuckPolls>0&&reqGapOk;
  if(oomHit)return 'oom';if(memHit)return 'memory';
  if(pollHit)return 'poll_stuck';if(timeoutHit)return 'timeout';if(reqHit)return 'request';return null;
}
function shouldRecycle(opts){return recycleReason(opts)!==null;}
function readEvents(){return core.readEvents(EVENTS);}
// 连续读不到状态的计数：成功读到就清零，避免历史计数影响下一次判断。
function updateStreak(auth){
  let prev=0;
  try{prev=Number(JSON.parse(fs.readFileSync(UNKNOWN,'utf8')).streak)||0;}catch{}
  const streak=auth==='logged_in'||auth==='logged_out'?0:Math.min(prev+1,100);
  const tmp=UNKNOWN+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify({streak,at:Date.now()}),{mode:0o600});fs.renameSync(tmp,UNKNOWN);}catch{}
  return streak;
}
// 把 blocked 的 gate 放行成 resume：bridge 下一轮检测到就重置游标、忽略历史、恢复轮询。
function clearGate(gate){
  if(!gate||gate.phase!=='blocked'||typeof gate.code!=='string')return false;
  const tmp=GATE+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify({code:gate.code,phase:'resume'}),{mode:0o600});
  fs.renameSync(tmp,GATE);
  return true;
}
function readGate(){
  try{
    const gate=JSON.parse(fs.readFileSync(GATE,'utf8'));
    return {...gate,ageMs:Date.now()-fs.statSync(GATE).mtimeMs};
  }catch(e){return null;}   // 文件不存在或损坏都不拦恢复流程
}
async function readAuth(){
  try{
    const st=await require(path.join(HOME,'wx-client')).status();
    return {auth:String(st&&st.status||'unknown')};
  }catch(e){return {auth:'unknown',error:String(e&&e.message||e).slice(0,160)};}
}
// 唯一的服务状态来源：systemctl show 的 ActiveState/SubState/NRestarts。
// is-active 只给一个布尔，分不清「还在起」和「起不来」；restartVerdict 用计数区分 flapping。
async function unitState(){
  try{
    const {stdout}=await exec('systemctl',['show',UNIT,'-p','ActiveState','-p','SubState','-p','NRestarts'],{timeout:10000});
    return core.unitProps(stdout);
  }catch(e){return core.unitProps(e.stdout||'');}
}
async function isActive(){
  return (await unitState()).activeState==='active';
}
// 返回 {ok,verdict}：ok=起来了；flapping/failed 立即返回，不再干等。
// ⚠ v3.4 把 `systemctl restart` 的 40 秒超时直接当成「重启失败」返回，而线上 stop 要 60 秒
// （SIGTERM 后事件循环不空 → TimeoutStopSec 到点 SIGKILL），所以每一次重启都会判 failed：
// 事件日志里 8 条 restart 有 5 条 ok:false，每条后面跟一条「已登录但桥接未 active（failed）」
// 的假 needs_scan，再触发 5 分钟退避。现在命令超时只记录，不终止等待；结论只看 systemd 状态。
async function restartAndWait(){
  const before=await unitState();
  let cmdError=null;
  try{await exec('systemctl',['restart',UNIT],{timeout:90000});}
  catch(e){cmdError=String(e&&e.message||e).slice(0,80);}
  const until=Date.now()+RESTART_WAIT_MS;
  let after=before,fails=0;
  while(Date.now()<until){
    after=await unitState();
    const verdict=core.restartVerdict(before,after);
    if(verdict==='ok')return {ok:true,verdict};
    if(verdict==='flapping')return {ok:false,verdict,state:after};
    // 停服务途中也会短暂出现非 active 状态，failed 要连续两次才认。
    fails=verdict==='failed'?fails+1:0;
    if(fails>=2)return {ok:false,verdict,state:after};
    await sleep(1000);
  }
  return {ok:false,verdict:'timeout',state:after,...(cmdError?{cmdError}:{})};
}
function recordRestart(result){
  if(DRY)return;
  try{core.appendEvent(EVENTS,{type:'restart',ok:result.ok===true,verdict:result.verdict,host:'aliyun'});}catch{}
}
// 登录失败时 stderr 是唯一能归因的线索（超时 / 接口报错 / 扫码被拒），但可能夹带令牌和二维码。
// 只保留尾部、先按字段名脱敏、再把长 base64/hex 串整体打码，最后截断；纯函数便于测试。
const STDERR_TAIL=400;
function sanitizeStderr(text){
  let s=String(text||'').replace(/\u001b\[[0-9;]*m/g,'');
  s=s.replace(/Bearer\s+[^\s,;]+/gi,'Bearer [redacted]');
  s=s.replace(/(token|authorization|auth|code|ticket|uuid|session|secret|password|key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1=[redacted]');
  s=s.replace(/([?&](?:token|code|ticket|uuid|session|auth)=)[^&\s]+/gi,'$1[redacted]');
  s=s.replace(/[A-Za-z0-9+/=_-]{24,}/g,'[redacted]');
  s=s.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim();
  return s.length>STDERR_TAIL?'…'+s.slice(-STDERR_TAIL):s;
}
// 登录放到子进程：wx 的会话/令牌都留在那边，本进程只拿判定结果和脱敏后的失败线索。
// 成功判据见 core.loginSucceeded：退出码 + stdout/stderr 任一命中，再用状态接口复核。
function runLoginOnce(){
  const script=`require(${JSON.stringify(path.join(HOME,'wx-client'))})`
    +`.wx(['auth','login','--timeout','120'],130000)`
    +`.then(o=>process.stdout.write(String(o)),e=>{process.stderr.write(String(e&&e.message||e));process.exitCode=1;});`;
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['-e',script],{
      env:{...process.env,HOME:path.join(HOME,'private')},
      stdio:['ignore','pipe','pipe'],timeout:150000,killSignal:'SIGKILL'
    });
    let out='',err='';child.stdout.on('data',b=>{if(out.length<64*1024)out+=b;});
    child.stderr.on('data',b=>{if(err.length<16*1024)err+=b;});
    child.on('error',e=>resolve({ok:false,stderr:String(e&&e.message||e),code:null}));
    child.on('close',async code=>{
      // 客户端 attach 需要几秒：子进程一关闭立刻读状态会读到登录前的旧值，
      // 线上 exit=0/0 stderr=空 的假 needs_scan 就是这么来的。等 3 秒再复核。
      await sleep(3000);
      let statusAfter=null;
      try{const st=await require(path.join(HOME,'wx-client')).status();statusAfter=String(st&&st.status||'');}catch{}
      resolve({ok:core.loginSucceeded({code,stdout:out,stderr:err,statusAfter}),stderr:err,code,statusAfter});
    });
  });
}
// 一次失败在 16:42 这类场景里无法归因（容器刚重启、接口还没就绪），同一轮再试一次通常就过；
// 只有两次都失败才需要扫码。返回结构而不是布尔，调用方把脱敏后的线索写进 needs_scan 详情。
async function wxLogin(run=runLoginOnce,wait=sleep,recheck=readAuth){
  const first=await run();
  if(first.ok)return {ok:true,attempts:1};
  await wait(10000);
  const second=await run();
  const detail={attempts:2,code1:first.code??null,code2:second.code??null,
    stderr1:sanitizeStderr(first.stderr),stderr2:sanitizeStderr(second.stderr)};
  if(second.ok)return {ok:true,...detail};
  // 终极复核：wx CLI 偶尔 exit 0 却不打成功标记（客户端正在自己 attach），
  // 两次都「失败」后再等 15 秒问一次状态接口，logged_in 就算成功。
  // 没有这一步，exit=0/0 stderr=空 会被误报成 needs_scan，白推一张二维码。
  await wait(15000);
  let final='';
  try{final=String((await recheck()).auth||'');}catch{}
  if(final==='logged_in')return {ok:true,...detail,confirmedBy:'status_recheck'};
  return {ok:false,...detail,statusAfterFinal:final||'unknown'};
}
function loginDetail(r){
  const tail=r.stderr2||r.stderr1||'空';
  return `两次尝试均失败（exit=${r.code1}/${r.code2}）stderr=${tail}`;
}
// 容器内存采样：分别取 anon（工作集，判据用它）、file（page cache，会自己回收）、
// memory.current（两者之和，仅用于和旧日志对齐）以及 memory.events 里的 oom_kill。
async function sampleMemory(auth){
  try{
    const {stdout:id}=await exec('docker',['inspect','-f','{{.Id}}','splatoon-wechat-test'],{timeout:8000});
    const base=path.join('/sys/fs/cgroup/system.slice','docker-'+id.trim()+'.scope');
    const cur=Number(fs.readFileSync(path.join(base,'memory.current'),'utf8'));
    const stat={};
    try{
      for(const line of fs.readFileSync(path.join(base,'memory.stat'),'utf8').split('\n')){
        const i=line.indexOf(' ');if(i<=0)continue;
        stat[line.slice(0,i)]=Number(line.slice(i+1));
      }
    }catch{}
    let oomKill=null;
    try{
      const m=/^oom_kill\s+(\d+)/m.exec(fs.readFileSync(path.join(base,'memory.events'),'utf8'));
      if(m)oomKill=Number(m[1]);
    }catch{}
    let peak=null;
    try{peak=Number(fs.readFileSync(path.join(base,'memory.peak'),'utf8'));}catch{}
    const info=fs.readFileSync('/proc/meminfo','utf8');
    const avail=/MemAvailable:\s+(\d+)/.exec(info);
    const mb=n=>n===null||n===undefined||!Number.isFinite(n)?null:Math.round(n/1048576);
    const entry={at:Date.now(),containerMB:mb(cur),
      anonMB:mb(stat.anon),fileMB:mb(stat.file),oomKill,
      peakMB:mb(peak),
      hostAvailMB:avail?Math.round(Number(avail[1])/1024):null,auth};
    let lines=[];
    try{lines=fs.readFileSync(MEM,'utf8').split('\n').filter(Boolean);}catch(e){if(e.code!=='ENOENT')throw e;}
    lines.push(JSON.stringify(entry));
    const tmp=MEM+'.tmp';
    fs.writeFileSync(tmp,lines.slice(-500).join('\n')+'\n',{mode:0o600});
    fs.renameSync(tmp,MEM);
    return entry;
  }catch(e){return null;/* 采样失败不影响主流程 */}
}
// 每轮的结论只写事件日志：恢复结果 + 是否该通知（通知端不做判断）。DRY 不落盘，避免污染真实状态。
const OK_RESULTS=new Set(['recovered','recycled','restarted','gate_cleared']);
function finish(result,detail,reason){
  const at=Date.now();
  const entry={type:'result',at,result,ok:OK_RESULTS.has(result),detail,...(reason?{reason}:{})};
  if(DRY){console.log('DRY',JSON.stringify(entry));return entry;}
  let notify=false;
  try{notify=core.notifyDecision({result,events:core.readEvents(EVENTS),now:at});}catch{}
  let full=entry;
  try{full=core.appendEvent(EVENTS,{...entry,notify,host:'aliyun'});}catch(e){console.error('event write failed',e.message);}
  console.log(new Date(at).toISOString(),'auto-relogin',result,detail);
  return full;
}
async function containerRunning(){
  try{
    const {stdout}=await exec('docker',['inspect','-f','{{.State.Running}}','splatoon-wechat-test'],{timeout:10000});
    return stdout.trim()==='true';
  }catch{return false;}
}
// 容器已运行多久（毫秒）。取不到返回 null，此时不改变原有判定。
async function containerUptimeMs(){
  try{
    const {stdout}=await exec('docker',['inspect','-f','{{.State.StartedAt}}','splatoon-wechat-test'],{timeout:10000});
    const at=Date.parse(stdout.trim());
    return Number.isFinite(at)?Date.now()-at:null;
  }catch{return null;}
}
// 容器重启后等状态「稳定」而不是「不是 unknown」：客户端刚起时会先给一次 logged_out 再自己
// attach 成 logged_in，这时抢着 wx auth login 会打断它自己的免扫码登录（v3.4 的 needs_scan
// 有一部分来自这里）。连续读到 3 次相同的非 unknown 值才认账。read/wait 可注入，测试里不必真等。
async function settleAuth(read=readAuth,wait=sleep,rounds=20,intervalMs=2000){
  let prev=null,stable=0,last='unknown';
  for(let i=0;i<rounds;i++){
    let auth='unknown';
    try{auth=String((await read()).auth||'unknown');}catch{}
    last=auth;
    stable=(auth!=='unknown'&&auth===prev)?stable+1:0;
    prev=auth;
    if(stable>=2)break;
    await wait(intervalMs);
  }
  return {auth:last,stable:stable>=2};
}
// 纯函数：只有「稳定」且已登录才跳过 wx auth login。logged_out / unknown / 来回跳的都不跳，
// 仍然走原来的登录流程——漏掉一次登录（机器人继续哑着）比多赌一次登录代价更大。
function skipLoginAfterRestart(settled){
  return Boolean(settled&&settled.stable&&settled.auth==='logged_in');
}
// 主动回收：重启容器 -> 等接口 -> 登录 -> 放行 gate -> 重启桥接。全程约 60-90 秒。
async function recycle(mem,reason='mem'){
  // 「这一轮已经动手回收了」先落一条事件：它既给超时/轮询计数一个新的起点，
  // 也让失败的回收（needs_scan）算进最小间隔——否则同一批旧事件会每 5 分钟重启一次容器。
  if(!DRY)try{core.appendEvent(EVENTS,{type:'recycle_attempt',reason:String(reason).slice(0,80),host:'aliyun'});}
  catch(e){console.error('recycle attempt event failed',e.message);}
  // 容器根本不在跑时后面所有步骤都白做，先确认它活着（被 OOM/被停都会走到这里）。
  if(!(await containerRunning())){
    try{await exec('docker',['start','splatoon-wechat-test'],{timeout:60000});}catch{}
  }
  try{await exec('docker',['restart','splatoon-wechat-test'],{timeout:180000});}
  catch(e){return finish('noop','容器重启失败：'+String(e&&e.message||e).slice(0,80));}
  if(!(await containerRunning()))return finish('needs_scan','容器重启后未运行，需要人工检查','container_not_running');
  const settled=await settleAuth();
  // 容器重启后客户端常常自己 attach 成 logged_in。这时再跑 wx auth login 就是去抢登录（坑 2）：
  // 它会打断刚建立好的会话，甚至给人推一张根本不需要扫的二维码。已经稳定登录就直接放行 gate
  // 并重启桥接，本次回收到此为止。
  if(skipLoginAfterRestart(settled)){
    const g=readGate();if(g)clearGate(g);
    const restart=await restartAndWait();recordRestart(restart);
    return restart.ok?finish('recycled',reason+'；容器重启后已自行登录（跳过 wx auth login），anon '+(mem&&mem.anonMB)+'MB；桥接已重启')
      :finish('needs_scan','已登录但桥接未 active（'+restart.verdict+'）','bridge_not_active');
  }
  const login=await wxLogin();
  if(!login.ok)return finish('needs_scan','容器已回收但自动登录未成功；'+loginDetail(login),'recycle_login_failed');
  const g=readGate();if(g)clearGate(g);
  const restart=await restartAndWait();recordRestart(restart);
  if(!restart.ok)return finish('needs_scan',`已登录但桥接未 active（${restart.verdict}）`,'bridge_not_active');
  return finish('recycled',reason+'；容器 anon '+(mem&&mem.anonMB)+'MB（阈值 '+MEM_LIMIT+'MB），已重启并恢复');
}
async function main(){
  // 恢复流程进行中：先跳过，连 status 都不查，避免和应用内的扫码/重置抢状态。
  const gate=readGate();
  if(gateBlocks(gate))return finish('skipped','登录恢复流程进行中 ageMs='+Math.round(gate.ageMs));
  const events=readEvents();
  const {auth,error}=await readAuth();
  if(error)console.error(new Date().toISOString(),'AUTH_UNKNOWN',error);
  const unknownStreak=updateStreak(auth);
  const bridgeActive=await isActive();
  const mem=await sampleMemory(auth);
  // 判内存只看 anon（工作集）；oomKilled 来自 memory.events，是比阈值更硬的证据。
  const recycleOpts={auth,containerMB:mem&&mem.anonMB,oomKilled:Boolean(mem&&Number(mem.oomKill)>0),gate,events};
  // 内存采样失败（mem=null）时仍允许超时路径触发：那条判据不依赖内存。
  if(shouldRecycle(recycleOpts)){
    const timeouts=core.countRecent(events,'send_timeout',Date.now(),REQUEST_WINDOW,lastRecycleAttemptAt(events));
    const reason=recycleReason(recycleOpts);
    const why=reason==='oom'?'cgroup 已发生 oom_kill'
      :reason==='memory'?'容器 anon '+(mem&&mem.anonMB)+'MB ≥ 阈值 '+MEM_LIMIT+'MB（含 page cache 共 '+(mem&&mem.containerMB)+'MB）'
      :reason==='poll_stuck'?'15 分钟内 '+core.countRecent(events,'poll_stuck',Date.now(),POLL_STUCK_WINDOW,lastRecycleAttemptAt(events))+' 次拉取消息失败'
      :'30 分钟内 '+timeouts+' 次发送超时';
    if(DRY)return finish('recycled','[dry] docker restart splatoon-wechat-test（'+why+'）');
    return await recycle(mem,why);
  }
  const action0=decide({auth,gate,bridgeActive,unknownStreak});
  // 容器刚起来时的 logged_out 不算掉线：先让客户端自己 attach，别抢。
  const uptime=action0==='login'?await containerUptimeMs():null;
  const settling=uptime!==null&&uptime<BOOT_SETTLE_MS;
  const action=settling?'noop':action0;
  console.log(new Date().toISOString(),'decision',action,'auth='+auth,'bridge='+(bridgeActive?'active':'inactive')
    +(settling?' (容器刚启动 '+Math.round(uptime/1000)+'s，等它自己 attach)':''));
  if(action==='noop')return finish('noop','auth='+auth+' bridge='+(bridgeActive?'active':'inactive')
    +(settling?'；容器刚启动 '+Math.round(uptime/1000)+'s，等待自动 attach':''));
  if(action==='clear_gate'){
    if(DRY)return finish('gate_cleared','[dry] gate '+gate.code+' -> resume');
    return clearGate(gate)?finish('gate_cleared','gate '+gate.code+' 已放行（已登录，无需登录）')
      :finish('noop','gate 放行失败');
  }
  if(action==='restart_bridge'){
    // 连续起不来就退避，不再每 5 分钟整轮重来（旧实现把 restart counter 推到 8）。
    const due=core.restartDue({events,base:BACKOFF_BASE,cap:BACKOFF_CAP});
    if(!due)return finish('noop','连续重启失败，退避中（下次不早于 '+new Date(core.backoffMs(core.failureStreak(events),{base:BACKOFF_BASE,cap:BACKOFF_CAP})+core.lastEvent(events,'restart').at).toISOString()+'）');
    if(DRY)return finish('restarted','[dry] systemctl restart '+UNIT);
    const restart=await restartAndWait();recordRestart(restart);
    return restart.ok?finish('restarted','桥接未运行，已重启')
      :finish('needs_scan','桥接重启失败（'+restart.verdict+'），已进入退避','bridge_restart_failed');
  }
  if(DRY)return finish('recovered','[dry] wx auth login --timeout 120（失败自动重试一次）后重启 '+UNIT);
  const login=await wxLogin();
  if(!login.ok)return finish('needs_scan','自动登录未确认成功；'+loginDetail(login),'login_failed');
  if(gate)clearGate(gate);   // 登录已成功，残留的 blocked gate 必须放行，否则桥接会继续空转
  const restart=await restartAndWait();recordRestart(restart);
  if(!restart.ok)return finish('needs_scan',`已登录但桥接未 active（${restart.verdict}）`);
  const after=await readAuth();
  return after.auth==='logged_in'?finish('recovered','自动登录成功，桥接已重启')
    :finish('needs_scan','登录后复检未确认 logged_in','login_unconfirmed');
}
if(require.main===module)main().catch(e=>{
  console.error(new Date().toISOString(),'auto-relogin failed',String(e&&e.message||e).slice(0,160));
  process.exitCode=1;
});
module.exports={decide,gateBlocks,clearGate,shouldRecycle,recycleReason,lastRecycleAttemptAt,POLL_STUCK_WINDOW,
  updateStreak,sampleMemory,main,sanitizeStderr,wxLogin,restartAndWait,TIMEOUT_WINDOW,TIMEOUT_LIMIT,
  settleAuth,skipLoginAfterRestart};
