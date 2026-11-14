#!/usr/bin/env node
'use strict';
// 小鱿鱿掉线自动恢复（部署主机侧）：判定 -> 自动登录 -> 重启桥接 -> 写结果事件供远端通知端消费。
// 由 xiaoyouyou-auto-relogin.timer 每 5 分钟拉起；XYY_DRY=1 只打印判定，不动服务和登录。
// 凭据只在 wx-client 子进程内使用：本文件绝不打印登录输出，日志里只有判定和布尔结果。
// 责任边界见 ARCHITECTURE.md：本文件是唯一判定者和执行者；bridge 只写检测事实，通知器只投递事件。
const fs=require('node:fs'),path=require('node:path'),{execFile,spawn}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile);
// 部署时 auto-relogin.js 与 recovery-core / ui-lock 同目录（都在 /opt/xiaoyouyou）；仓库内后者在 src/。
const mod=(name)=>{
  const local=path.join(__dirname,name);
  return require(fs.existsSync(local+'.js')?local:path.join(__dirname,'..','src',name));
};
const core=mod('recovery-core');
const {withUiLock}=mod('ui-lock');
const HOME=process.env.XYY_HOME||'/opt/xiaoyouyou';
const STATE=path.join(HOME,'private/.local/state/splatoon-bridge');
const EVENTS=process.env.XYY_EVENTS_FILE||path.join(STATE,'recovery-events.jsonl');  // 唯一状态：append-only 事件
const GATE=path.join(STATE,'login-gate.json');
const CONTAINER=process.env.XYY_WECHAT_CONTAINER||'splatoon-wechat-test';
const UNIT='xiaoyouyou-aliyun.service';
const GATE_GRACE=2*60*1000;     // 只给真实扫码留 2 分钟窗口：超过就自己接管，不再等审批
const UNKNOWN=path.join(STATE,'auto-relogin-unknown.json');   // 连续读不到状态的计数
const MEM=path.join(STATE,'memory-samples.log');             // 容器内存采样（查卡死根因）
const UNKNOWN_LIMIT=2;         // 连续 2 次（约 10 分钟）读不到就当掉线处理
// 容器内存阈值（MB）。⚠ 旧实现按 memory.current（含 page cache）判定，会把微信读库缓存误当泄漏，
// 触发无谓重启并白白消耗免扫码窗口。现在只按 anon（工作集）判定，并用 memory.events 的 oom_kill 兜底。
const MEM_LIMIT=Number(process.env.XYY_ANON_LIMIT_MB||900);
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
// 所以容器起来不足 3 分钟时，logged_out 先不动手。
const BOOT_SETTLE_MS=Number(process.env.XYY_BOOT_SETTLE_MS||3*60*1000);
const LOGIN_TIMEOUT_S=Math.max(15,Number(process.env.XYY_LOGIN_TIMEOUT_S||45));
// 连续启动失败退避：第 1 次失败与 timer 周期（5 分钟）一致，之后翻倍，封顶 30 分钟。
const BACKOFF_BASE=Number(process.env.XYY_BACKOFF_BASE_MS||5*60*1000);
const BACKOFF_CAP=Number(process.env.XYY_BACKOFF_CAP_MS||30*60*1000);
const DRY=process.env.XYY_DRY==='1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function wxClientPath(){
  if(fs.existsSync(path.join(HOME,'wx-client.js')))return path.join(HOME,'wx-client');
  if(fs.existsSync(path.join(__dirname,'wx-client.js')))return path.join(__dirname,'wx-client');
  return path.join(__dirname,'..','src','wx-client');
}

function parseAuthStatusView(logText){
  let last=null;
  const re=/\[auth_status\]\s+view=([A-Za-z0-9_]+)/g;
  for(const m of String(logText||'').matchAll(re))last=m[1];
  return last;
}

async function detectContainerView(containerName=CONTAINER){
  try{
    const {stdout,stderr}=await exec('docker',['logs','--since','15s','--tail','30',containerName],{encoding:'utf8',timeout:3000,maxBuffer:256*1024});
    return parseAuthStatusView(String(stdout||'')+'\n'+String(stderr||''));
  }catch{return null;}
}

function gateBlocks(gate){
  return Boolean(gate&&gate.phase==='blocked'&&Number.isFinite(gate.ageMs)&&gate.ageMs<GATE_GRACE);
}
// 纯函数：观测（auth / view / gate / bridgeActive / unknownStreak）→ 本轮动作。
// 关键：当微信已经停在 LoginQr 或 LoginPhoneConfirm 界面时，绝不重复触发 `wx auth login`
// （后者会取消/重建当前二维码或手机确认会话）。LoginLoading 表示客户端正在自动恢复，保持 noop。
function decide({auth,view,gate,bridgeActive,unknownStreak=0}={}){
  const blocked=Boolean(gate&&gate.phase==='blocked'&&Number.isFinite(gate.ageMs));
  if(blocked&&gate.ageMs<GATE_GRACE)return 'skip_gate';
  if(blocked&&auth==='logged_in')return 'clear_gate';
  if(auth==='logged_in')return bridgeActive?'noop':'restart_bridge';
  if(auth==='logged_out'){
    if(view==='LoginQr')return 'wait_qr';
    if(view==='LoginPhoneConfirm')return 'wait_phone';
    if(view==='LoginLoading')return 'noop';
    return 'login';
  }
  // 客户端卡死/重启中时状态接口读不到：连续读不到说明它不会自己好了，按掉线处理。
  if(Number.isFinite(unknownStreak)&&unknownStreak>=UNKNOWN_LIMIT)return 'login';
  return 'noop';
}
// 主动回收的判据顺序：内存 > poll_stuck > 反复发送超时 > 单次发送超时请求。
// 卡死时状态接口常返回 unknown / app_not_running，因此超时和 poll_stuck 不要求 auth=logged_in。
// 仍然排除 logged_out：那是正常掉线，走登录流程，重启容器只会白白丢掉会话。
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
  const oomHit=oomKilled&&auth!=='logged_out'&&gapOk;
  const memHit=auth==='logged_in'&&Number.isFinite(containerMB)&&containerMB>=limit&&gapOk;
  const timeoutHit=auth!=='logged_out'&&burstTimeouts>=timeoutLimit&&reqGapOk;
  const reqHit=auth==='logged_in'&&recentTimeouts>0&&reqGapOk;
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
  }catch{return null;}   // 文件不存在或损坏都不拦恢复流程
}
async function readAuth(){
  try{
    const st=await require(wxClientPath()).status();
    const auth=String(st&&st.status||'unknown');
    const view=(st&&st.view)||await detectContainerView();
    return {auth,...(view?{view}:{})};
  }catch(e){return {auth:'unknown',error:String(e&&e.message||e).slice(0,160)};}
}
// 唯一的服务状态来源：systemctl show 的 ActiveState/SubState/NRestarts。
async function unitState(){
  try{
    const {stdout}=await exec('systemctl',['show',UNIT,'-p','ActiveState','-p','SubState','-p','NRestarts'],{timeout:10000});
    return core.unitProps(stdout);
  }catch(e){return core.unitProps(e.stdout||'');}
}
async function isActive(){
  return (await unitState()).activeState==='active';
}
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
    fails=verdict==='failed'?fails+1:0;
    if(fails>=2)return {ok:false,verdict,state:after};
    await sleep(1000);
  }
  return {ok:false,verdict:'timeout',state:after,...(cmdError?{cmdError}:{})};
}
function recordRestart(result){
  if(DRY)return;
  try{core.appendEvent(EVENTS,{type:'restart',ok:result.ok===true,verdict:result.verdict,host:'bot'});}catch{}
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
// 登录放到子进程：实时监听 stdout，一旦出现二维码或手机端确认提示立刻停手并归因，
// 不白等满超时、也不会因为 wx auth login 超时退出码仍为 0 而留下「stderr=空」。
function runLoginOnce(){
  const cliTimeoutMs=(LOGIN_TIMEOUT_S+10)*1000;
  const script=`require(${JSON.stringify(wxClientPath())})`
    +`.wx(['auth','login','--timeout',${JSON.stringify(String(LOGIN_TIMEOUT_S))}],${cliTimeoutMs})`
    +`.then(o=>process.stdout.write(String(o)),e=>{process.stderr.write(String(e&&e.message||e));process.exitCode=1;});`;
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['-e',script],{
      env:{...process.env,HOME:path.join(HOME,'private')},
      stdio:['ignore','pipe','pipe'],timeout:(LOGIN_TIMEOUT_S+30)*1000,killSignal:'SIGKILL'
    });
    let out='',err='',earlyOutcome=null,killTimer=null;
    const stopFor=(outcome)=>{
      if(earlyOutcome)return;
      earlyOutcome=outcome;
      try{child.kill('SIGTERM');}catch{}
      killTimer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},1500);
      killTimer.unref();
    };
    child.stdout.on('data',b=>{
      if(out.length<64*1024)out+=b;
      if(/Scan this QR code with WeChat:/i.test(out))stopFor('qr_required');
      else if(/confirm login on your phone/i.test(out))stopFor('phone_confirm');
    });
    child.stderr.on('data',b=>{if(err.length<16*1024)err+=b;});
    child.on('error',e=>resolve({ok:false,outcome:'error',stderr:String(e&&e.message||e),code:null}));
    child.on('close',async code=>{
      if(killTimer)clearTimeout(killTimer);
      await sleep(earlyOutcome?500:3000);
      let statusAfter=null;
      try{const st=await require(wxClientPath()).status();statusAfter=String(st&&st.status||'');}catch{}
      const ok=core.loginSucceeded({code,stdout:out,stderr:err,statusAfter});
      if(ok)return resolve({ok:true,outcome:'login_success',stderr:err,code,statusAfter});
      if(earlyOutcome)return resolve({ok:false,outcome:earlyOutcome,stderr:err||('wx stdout: '+earlyOutcome),code:code??0,statusAfter});
      if(/Scan this QR code with WeChat:/i.test(out))return resolve({ok:false,outcome:'qr_required',stderr:err||'wx stdout: qr_required',code,statusAfter});
      if(/confirm login on your phone/i.test(out))return resolve({ok:false,outcome:'phone_confirm',stderr:err||'wx stdout: phone_confirm',code,statusAfter});
      if(/Login timed out/i.test(out)){
        const msg=(err?err+'; ':'')+'wx stdout: Login timed out';
        return resolve({ok:false,outcome:'timeout',stderr:msg,code,statusAfter});
      }
      resolve({ok:false,outcome:'failed',stderr:err,code,statusAfter});
    });
  });
}
// 第一次失败先快速复检状态：一旦已出现 phone_confirm / qr_required 就立刻停手，不再重复跑第二次；
// 只有真正瞬间失败/超时才等 5 秒重跑一次，再做状态复核。
async function wxLogin(run=runLoginOnce,wait=sleep,recheck=readAuth){
  const first=await run();
  if(first.ok)return {ok:true,attempts:1};
  let mid={};
  try{mid=await recheck();}catch{}
  if(mid.auth==='logged_in')return {ok:true,attempts:1,confirmedBy:'status_recheck'};
  if(first.outcome==='phone_confirm'||mid.view==='LoginPhoneConfirm'){
    return {ok:false,outcome:'phone_confirm',reason:'phone_confirm',attempts:1,code1:first.code??null,
      stderr1:sanitizeStderr(first.stderr),detail:'请在 3 分钟内打开手机微信点击「确认登录」（免扫码）'};
  }
  if(first.outcome==='qr_required'||mid.view==='LoginQr'){
    return {ok:false,outcome:'qr_required',reason:'qr_required',attempts:1,code1:first.code??null,
      stderr1:sanitizeStderr(first.stderr),detail:'需要扫码登录（LoginQr），已停止重复重试'};
  }
  await wait(5000);
  const second=await run();
  const detail={attempts:2,code1:first.code??null,code2:second.code??null,
    stderr1:sanitizeStderr(first.stderr),stderr2:sanitizeStderr(second.stderr)};
  if(second.ok)return {ok:true,...detail};
  if(second.outcome==='phone_confirm'){
    let chk={};try{chk=await recheck();}catch{}
    if(chk.auth==='logged_in')return {ok:true,...detail,confirmedBy:'status_recheck'};
    return {ok:false,...detail,outcome:'phone_confirm',reason:'phone_confirm',
      detail:'请在 3 分钟内打开手机微信点击「确认登录」（免扫码）'};
  }
  if(second.outcome==='qr_required'){
    return {ok:false,...detail,outcome:'qr_required',reason:'qr_required',
      detail:'需要扫码登录（LoginQr），已停止重复重试'};
  }
  await wait(15000);
  let finalRes={};
  try{finalRes=await recheck();}catch{}
  const finalAuth=String(finalRes&&finalRes.auth||'');
  if(finalAuth==='logged_in')return {ok:true,...detail,confirmedBy:'status_recheck'};
  if(finalRes.view==='LoginPhoneConfirm'){
    return {ok:false,...detail,outcome:'phone_confirm',reason:'phone_confirm',statusAfterFinal:finalAuth||'logged_out',
      detail:'请在 3 分钟内打开手机微信点击「确认登录」（免扫码）'};
  }
  if(finalRes.view==='LoginQr'){
    return {ok:false,...detail,outcome:'qr_required',reason:'qr_required',statusAfterFinal:finalAuth||'logged_out',
      detail:'需要扫码登录（LoginQr），已停止重复重试'};
  }
  return {ok:false,...detail,statusAfterFinal:finalAuth||'unknown'};
}
function loginDetail(r){
  const tail=r.stderr2||r.stderr1||'空';
  return `两次尝试均失败（exit=${r.code1}/${r.code2}）stderr=${tail}`;
}
// 容器内存采样：分别取 anon（工作集，判据用它）、file（page cache，会自己回收）、
// memory.current（两者之和）以及 memory.events 里的 oom_kill。
async function sampleMemory(auth){
  try{
    const {stdout:id}=await exec('docker',['inspect','-f','{{.Id}}',CONTAINER],{timeout:8000});
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
  }catch{return null;/* 采样失败不影响主流程 */}
}
// 每轮的结论只写事件日志：恢复结果 + 是否该通知（通知端不做判断）。DRY 不落盘，避免污染真实状态。
const OK_RESULTS=new Set(['recovered','recycled','restarted','gate_cleared']);
function finish(result,detail,reason){
  const at=Date.now();
  const entry={type:'result',at,result,ok:OK_RESULTS.has(result),detail,...(reason?{reason}:{})};
  if(DRY){console.log('DRY',JSON.stringify(entry));return entry;}
  let notify=false;
  try{notify=core.notifyDecision({result,reason,events:core.readEvents(EVENTS),now:at});}catch{}
  let full=entry;
  try{full=core.appendEvent(EVENTS,{...entry,notify,host:'bot'});}catch(e){console.error('event write failed',e.message);}
  console.log(new Date(at).toISOString(),'auto-relogin',result,detail);
  return full;
}
async function containerRunning(){
  try{
    const {stdout}=await exec('docker',['inspect','-f','{{.State.Running}}',CONTAINER],{timeout:10000});
    return stdout.trim()==='true';
  }catch{return false;}
}
// 容器已运行多久（毫秒）。取不到返回 null，此时不改变原有判定。
async function containerUptimeMs(){
  try{
    const {stdout}=await exec('docker',['inspect','-f','{{.State.StartedAt}}',CONTAINER],{timeout:10000});
    const at=Date.parse(stdout.trim());
    return Number.isFinite(at)?Date.now()-at:null;
  }catch{return null;}
}
// 容器重启后等状态「稳定」：连续读到 3 次相同的非 unknown 值才认账。
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
function skipLoginAfterRestart(settled){
  return Boolean(settled&&settled.stable&&settled.auth==='logged_in');
}
// 主动回收：重启容器 -> 等接口 -> 登录 -> 放行 gate -> 重启桥接。全程约 60-90 秒。
async function recycle(mem,reason='mem'){
  if(!DRY)try{core.appendEvent(EVENTS,{type:'recycle_attempt',reason:String(reason).slice(0,80),host:'bot'});}
  catch(e){console.error('recycle attempt event failed',e.message);}
  if(!(await containerRunning())){
    try{await exec('docker',['start',CONTAINER],{timeout:60000});}catch{}
  }
  try{await exec('docker',['restart',CONTAINER],{timeout:180000});}
  catch(e){return finish('noop','容器重启失败：'+String(e&&e.message||e).slice(0,80));}
  if(!(await containerRunning()))return finish('needs_scan','容器重启后未运行，需要人工检查','container_not_running');
  const settled=await settleAuth();
  if(skipLoginAfterRestart(settled)){
    const g=readGate();if(g)clearGate(g);
    const restart=await restartAndWait();recordRestart(restart);
    return restart.ok?finish('recycled',reason+'；容器重启后已自行登录（跳过 wx auth login），anon '+(mem&&mem.anonMB)+'MB；桥接已重启')
      :finish('needs_scan','已登录但桥接未 active（'+restart.verdict+'）','bridge_not_active');
  }
  const login=await withUiLock('auto-relogin-recycle',()=>wxLogin(),{waitMs:10000,ttlMs:120000,proceedOnTimeout:true});
  if(!login.ok){
    if(login.reason==='phone_confirm'||login.reason==='qr_required'){
      return finish('needs_scan','容器已回收；'+(login.detail||loginDetail(login)),login.reason);
    }
    return finish('needs_scan','容器已回收但自动登录未成功；'+loginDetail(login),'recycle_login_failed');
  }
  const g=readGate();if(g)clearGate(g);
  const restart=await restartAndWait();recordRestart(restart);
  if(!restart.ok)return finish('needs_scan',`已登录但桥接未 active（${restart.verdict}）`,'bridge_not_active');
  return finish('recycled',reason+'；容器 anon '+(mem&&mem.anonMB)+'MB（阈值 '+MEM_LIMIT+'MB），已重启并恢复');
}
async function main(){
  const gate=readGate();
  if(gateBlocks(gate))return finish('skipped','登录恢复流程进行中 ageMs='+Math.round(gate.ageMs));
  const events=readEvents();
  const {auth,view,error}=await readAuth();
  if(error)console.error(new Date().toISOString(),'AUTH_UNKNOWN',error);
  const unknownStreak=updateStreak(auth);
  const bridgeActive=await isActive();
  const mem=await sampleMemory(auth);
  const recycleOpts={auth,containerMB:mem&&mem.anonMB,oomKilled:Boolean(mem&&Number(mem.oomKill)>0),gate,events};
  if(shouldRecycle(recycleOpts)){
    const timeouts=core.countRecent(events,'send_timeout',Date.now(),REQUEST_WINDOW,lastRecycleAttemptAt(events));
    const reason=recycleReason(recycleOpts);
    const why=reason==='oom'?'cgroup 已发生 oom_kill'
      :reason==='memory'?'容器 anon '+(mem&&mem.anonMB)+'MB ≥ 阈值 '+MEM_LIMIT+'MB（含 page cache 共 '+(mem&&mem.containerMB)+'MB）'
      :reason==='poll_stuck'?'15 分钟内 '+core.countRecent(events,'poll_stuck',Date.now(),POLL_STUCK_WINDOW,lastRecycleAttemptAt(events))+' 次拉取消息失败'
      :'30 分钟内 '+timeouts+' 次发送超时';
    if(DRY)return finish('recycled','[dry] docker restart '+CONTAINER+'（'+why+'）');
    return await recycle(mem,why);
  }
  const action0=decide({auth,view,gate,bridgeActive,unknownStreak});
  // 容器刚起来时的 logged_out 不算掉线：先让客户端自己 attach，别抢。
  const uptime=action0==='login'?await containerUptimeMs():null;
  const settling=uptime!==null&&uptime<BOOT_SETTLE_MS;
  const action=settling?'noop':action0;
  console.log(new Date().toISOString(),'decision',action,'auth='+auth+(view?' view='+view:''),'bridge='+(bridgeActive?'active':'inactive')
    +(settling?' (容器刚启动 '+Math.round(uptime/1000)+'s，等它自己 attach)':''));
  if(action==='noop')return finish('noop','auth='+auth+(view?' view='+view:'')+' bridge='+(bridgeActive?'active':'inactive')
    +(settling?'；容器刚启动 '+Math.round(uptime/1000)+'s，等待自动 attach':''));
  if(action==='wait_qr')return finish('needs_scan','当前处于扫码登录界面（LoginQr），已暂停自动登录等待扫码','qr_required');
  if(action==='wait_phone')return finish('needs_scan','请在 3 分钟内打开手机微信点击「确认登录」（免扫码）','phone_confirm');
  if(action==='clear_gate'){
    if(DRY)return finish('gate_cleared','[dry] gate '+gate.code+' -> resume');
    return clearGate(gate)?finish('gate_cleared','gate '+gate.code+' 已放行（已登录，无需登录）')
      :finish('noop','gate 放行失败');
  }
  if(action==='restart_bridge'){
    const due=core.restartDue({events,base:BACKOFF_BASE,cap:BACKOFF_CAP});
    if(!due)return finish('noop','连续重启失败，退避中（下次不早于 '+new Date(core.backoffMs(core.failureStreak(events),{base:BACKOFF_BASE,cap:BACKOFF_CAP})+core.lastEvent(events,'restart').at).toISOString()+'）');
    if(DRY)return finish('restarted','[dry] systemctl restart '+UNIT);
    const restart=await restartAndWait();recordRestart(restart);
    return restart.ok?finish('restarted','桥接未运行，已重启')
      :finish('needs_scan','桥接重启失败（'+restart.verdict+'），已进入退避','bridge_restart_failed');
  }
  if(!DRY&&!core.loginDue({events,now:Date.now()})){
    return finish('noop','自动登录连续失败，退避等待中');
  }
  if(DRY)return finish('recovered','[dry] wx auth login --timeout '+LOGIN_TIMEOUT_S+'（遇 QR/手机确认立即停手）后重启 '+UNIT);
  const login=await withUiLock('auto-relogin',()=>wxLogin(),{waitMs:5000,ttlMs:120000,proceedOnTimeout:false});
  if(login&&login.skipped)return finish('noop','UI 锁占用中，延后本轮自动登录');
  if(!login.ok){
    if(login.reason==='phone_confirm'||login.reason==='qr_required'){
      return finish('needs_scan',login.detail||loginDetail(login),login.reason);
    }
    return finish('needs_scan','自动登录未确认成功；'+loginDetail(login),'login_failed');
  }
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
module.exports={decide,parseAuthStatusView,gateBlocks,clearGate,shouldRecycle,recycleReason,lastRecycleAttemptAt,POLL_STUCK_WINDOW,
  updateStreak,sampleMemory,main,sanitizeStderr,wxLogin,restartAndWait,TIMEOUT_WINDOW,TIMEOUT_LIMIT,
  settleAuth,skipLoginAfterRestart};
