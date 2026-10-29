#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');const {rows,sendImage,sendText}=require('./wx-client');
const {respond,ALLOWED}=require('./xiaoyouyou-v3.3');
const {chatText,createChat}=require('./llm-chat');
const {CHAT,NICK}=require('./bot-config');
const STATE=process.env.SPLATOON_STATE_FILE||path.join(process.env.HOME,'.local/state/splatoon-bridge/state.json');
const LOCK=path.join(path.dirname(STATE),'bridge-v3.3.lock');
const GATE=path.join(path.dirname(STATE),'login-gate.json'),ACK=path.join(path.dirname(STATE),'bridge-recovery-ack.json');
// 事件日志目录默认跟着 STATE，测试可以用 SPLATOON_EVENTS_FILE 指到临时目录，避免污染真实事件流。
const EVENTS=process.env.SPLATOON_EVENTS_FILE||process.env.XYY_EVENTS_FILE||path.join(path.dirname(STATE),'recovery-events.jsonl');
function readOptional(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
// 启动宽限：只把 GRACE 毫秒以前的消息当历史。旧行为是「全部忽略」，
// 于是重启前后发出的指令必然被吃掉（实测 21:43 的「@小鱿鱿 打工」就是这样丢的）。
const GRACE_MS=Math.max(0,Number(process.env.XYY_STARTUP_GRACE_MS)||30000);
// 连续拉消息失败到这个次数就写一条 poll_stuck 事件（每再失败一轮补一条）：
// 客户端「status 正常但消息接口卡死」且没人 @ 时，这是唯一能让 auto-relogin 知道的线索。
const POLL_STUCK_LIMIT=Math.max(1,Number(process.env.XYY_POLL_STUCK_LIMIT)||10);
// 重启后最多补处理多久的积压（默认 30 分钟）。v3.4 的问题：state.json 只写不读，
// 每次重启游标都退回 now-30s，停机 90 秒里超过 30 秒的指令全部当历史丢掉。
const BACKLOG_MS=Math.max(0,Number(process.env.XYY_BACKLOG_MS)||30*60*1000);
// 读回上次持久化的游标。超过 BACKLOG_MS 的旧游标不采用：宁可漏也不要把一小时前的
// 指令重新回一遍（微信里那会变成刷屏）。文件损坏/不存在都退回旧行为。
function loadState(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE,'utf8'));
    if(!s||s.chatId!==CHAT||!Number.isSafeInteger(s.lastId))return null;
    const age=Date.now()-Number(s.savedAt);
    if(!Number.isFinite(age)||age>BACKLOG_MS)return null;
    return {chatId:CHAT,lastId:s.lastId,startedAt:Date.now(),savedAt:s.savedAt,restored:true,backlogMs:Math.max(0,age)};
  }catch(e){if(e.code!=='ENOENT')console.error('state read failed',e.message);return null;}
}
// 返回应视为已读的最大 localId：时间戳早于 since 的消息才算历史。
function resumeCursor(msgs,since){
  let last=-1;
  for(const m of msgs){
    const ts=Date.parse(m&&m.timestamp);
    if(Number.isFinite(ts)&&ts<since&&Number.isSafeInteger(m.localId))last=Math.max(last,m.localId);
  }
  return last;
}
// 本轮要处理的消息时间下限：默认「启动时刻 - GRACE」。游标是从 state.json 恢复时，
// 下限再往下拉到 savedAt（停机那一刻）——否则停机期间发来的指令会因为早于
// 「启动 - 30 秒」被 command() 当历史丢掉，恢复出来的游标等于没用（BACKLOG_MS 形同虚设）。
function backlogFloor(startedAt,graceMs=GRACE_MS,savedAt){
  const base=startedAt-Math.max(0,Number(graceMs)||0);
  return Number.isFinite(savedAt)&&savedAt<base?savedAt:base;
}
function command(m,startedAt=0){
  if(!m||m.chatId!==CHAT||m.type!==1||m.isMentioned!==true||m.isSelf!==false||!Number.isSafeInteger(m.localId)||m.localId<0)return null;
  const ts=Date.parse(m.timestamp);if(!Number.isFinite(ts)||ts<startedAt)return null;
  const text=String(m.content||'').trim(),prefix='@'+NICK;
  if(!text.startsWith(prefix))return null;
  const cmd=text.slice(prefix.length).trim();
  // 按第一个空白切出指令名；带参数的指令（如「配装 斯普拉射击枪」）整段返回，由 respond 解析。
  const head=/^(\S+)/.exec(cmd);
  return head&&ALLOWED.has(head[1])?cmd:null;
}
function acquire(){
  fs.mkdirSync(path.dirname(LOCK),{recursive:true,mode:0o700});
  try{fs.writeFileSync(LOCK,String(process.pid),{flag:'wx',mode:0o600});}catch(e){
    if(e.code!=='EEXIST')throw e;const old=Number(fs.readFileSync(LOCK,'utf8'));
    if(!Number.isSafeInteger(old)||old<=1)throw Error('锁文件异常，需人工检查');
    try{process.kill(old,0);throw Error('已有桥接实例 PID '+old);}catch(err){if(err.code!=='ESRCH')throw err;}
    fs.unlinkSync(LOCK);fs.writeFileSync(LOCK,String(process.pid),{flag:'wx',mode:0o600});
  }
  process.on('exit',()=>{try{if(fs.readFileSync(LOCK,'utf8')===String(process.pid))fs.unlinkSync(LOCK);}catch{}});
}
function save(s){const tmp=STATE+'.tmp';s.savedAt=Date.now();fs.writeFileSync(tmp,JSON.stringify(s),{mode:0o600});fs.renameSync(tmp,STATE);}
// 发送超时说明客户端已经卡住：往事件日志写一条检测事实，交给 auto-relogin 立刻重启容器，
// 不必等内存涨到阈值（那条路径要等更久，而且卡死和内存无关时永远等不到）。
// 桥接只检测、不判定：这里不决定要不要回收，也不自己重启。
function writeRecoveryEvent(event){
  try{
    const {appendEvent}=require('./recovery-core');
    return appendEvent(EVENTS,{host:'aliyun',...event});
  }catch(e){console.error('recovery event write failed',e.message);return null;}
}
function requestRecycle(reason){return writeRecoveryEvent({type:'send_timeout',reason:String(reason||'').slice(0,80)});}
const replyFailures=new Map();   // localId -> 连续失败次数
// 图片回复成功后追发的卖萌语；判定抽成纯函数便于测试。
const CUTE='小鱿鱿要亲亲～';
function cuteLine(cmd,result){
  const head=/^(\S+)/.exec(String(cmd||'').trim());
  if(!head||head[1]==='帮助')return null;   // 帮助是纯文字，显式排除
  return result&&result.image?CUTE:null;
}
async function processBatch(msgs,state,since,handlers){
  let dirty=false;
  // 回复完立刻落盘：崩溃/被 SIGKILL 时最多重发一条，而不是整批。
  const commit=()=>{if(!dirty)return;handlers.save(state);dirty=false;};
  for(const m of msgs){
    if(handlers.running&& !handlers.running())break;
    if(m.localId<=state.lastId)continue;
    // 群聊上下文：所有新文字消息（含小鱿鱿自己的）都交给闲聊模块看一眼，只存内存。
    if(handlers.observe&&Date.parse(m.timestamp)>=since){try{handlers.observe(m);}catch{}}
    const cmd=command(m,since);
    if(!cmd){
      // 闲聊支路：不是有效指令才走；失败只会「不回」，游标照常推进，不重试、不写恢复事件。
      const talk=handlers.chat&&chatText(m,since,NICK);
      state.lastId=m.localId;dirty=true;
      if(talk){commit();try{await handlers.chat(talk,m);}catch(e){console.error(new Date().toISOString(),'LLM chat failed',m.localId,String(e&&e.message||e).slice(0,120));}}
      continue;
    }
    try{await handlers.reply(cmd,m);}
    catch(e){
      // uncertain = 「结果不明，可能已经发出去了」（贴图后发送按钮点没点中、粘贴异常等）。
      // 这种失败绝不能重试：再发一次就是群里出现两张一样的图。这里把它当终态——
      // 直接推进游标，并把事实写进事件日志，由 auto-relogin 决定是否回收容器。
      if(e&&e.uncertain){
        replyFailures.delete(m.localId);
        state.lastId=m.localId;dirty=true;commit();
        writeRecoveryEvent({type:'send_uncertain',localId:m.localId,cmd:String(cmd).slice(0,40),
          reason:String(e&&e.message||e).slice(0,120)});
        console.error(new Date().toISOString(),'UNCERTAIN skip',m.localId,e&&e.message||e);
        continue;
      }
      const n=(replyFailures.get(m.localId)||0)+1;
      if(n<3){replyFailures.set(m.localId,n);throw e;}
      replyFailures.delete(m.localId);
      state.lastId=m.localId;dirty=true;commit();
      console.error(new Date().toISOString(),'SKIP',m.localId,e&&e.message||e);
      continue;
    }
    replyFailures.delete(m.localId);
    state.lastId=m.localId;dirty=true;commit();
  }
  commit();
  // 主动插话：整批处理完再判断，失败只会「不插话」。
  if(handlers.chime&&(!handlers.running||handlers.running())){try{await handlers.chime();}catch(e){console.error(new Date().toISOString(),'LLM chime failed',String(e&&e.message||e).slice(0,120));}}
}
// gate 过期放行只有一个主人：auto-relogin 的 decide()（2 分钟扫码宽限）。桥接不再自己判一遍。
// 轮询节奏：默认 250ms（现状不变）。POLL_MS 与失败退避参数都可配置，供 REPORT-STABILITY.md
// 的 A/B 验证使用；把 POLL_MS 设成 500 即实验组，改回 250 重启即回滚。
function pollConfig(env=process.env){
  const num=(v,def)=>Number.isFinite(Number(v))&&Number(v)>0?Number(v):def;
  return {interval:Math.max(250,num(env.POLL_MS,250)),
    backoffMin:Math.max(0,num(env.POLL_BACKOFF_MIN_MS,0)),      // 0 = 保持旧行为
    backoffMax:Math.max(250,num(env.POLL_BACKOFF_MAX_MS,5000))};
}
async function main(){
  acquire();let running=true;const startedAt=Date.now(),cfg=pollConfig(),interval=cfg.interval;
  let failures=0;
  require('./net').startDataRefresh();
  let state=loadState();
  // 闲聊模块：XYY_LLM=0（默认）时整个支路不挂，行为与旧版完全一致。
  const llm=(()=>{try{const c=createChat();if(c.config.mode==='off')return null;console.log('LLM chat enabled: mode='+c.config.mode+' model='+c.config.model+' users='+c.config.users.size);return c;}catch(e){console.error('LLM init failed',e.message);return null;}})();
  const since=backlogFloor(startedAt,GRACE_MS,state&&state.savedAt);
  // 收到 SIGTERM 必须尽快退出。net.js 的后台刷新循环一直持有 https socket，
  // 只把 running 置 false 不会让事件循环空掉，systemd 要等满 TimeoutStopSec=60 再 SIGKILL
  // （线上实测 21:49 / 21:54 / 21:57 / 22:09 / 22:18 每次都是 60 秒，日志里是
  //  "State 'stop-sigterm' timed out. Killing."），这段时间里在途回复和游标都可能丢。
  const shutdown=()=>{
    if(!running)return;
    running=false;
    // 退出前把游标落一次：state.json 的 savedAt 只有在处理消息时才刷新，
    // 空闲几小时后重启会显得「很久没存过」，loadState 就会因为超龄而放弃恢复。
    // 在停机点存一次，age 就等于真实停机时长，游标恢复才准。
    try{if(state&&Number.isSafeInteger(state.lastId))save(state);}catch(e){console.error('final save failed',e.message);}
    setTimeout(()=>{console.log('Stopped');process.exit(0);},3000);
  };
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
  console.log('小鱿鱿 v3.3 started; chat='+CHAT+'; poll='+interval+'ms; '+
    (state?'cursor restored '+state.lastId+' (backlog '+Math.round(state.backlogMs/1000)+'s)':'history ignored'));
  while(running){let pollFailed=false;try{
    const gate=readOptional(GATE),gateAction=require('./recovery-gate').action(gate,readOptional(ACK),Date.now());
    if(gateAction==='wait'){await new Promise(r=>setTimeout(r,interval));continue;}
    // 只有「拉消息」本身失败才算轮询卡死；回复失败走上面的重试/跳过路径，不混进来。
    const list=await rows(50).catch(e=>{pollFailed=true;throw e;});if(!Array.isArray(list))throw Error('消息列表格式变化');
    const msgs=list.filter(m=>m.chatId===CHAT&&Number.isSafeInteger(m.localId)).sort((a,b)=>a.localId-b.localId);
    if(gateAction==='reset'){
      state={chatId:CHAT,lastId:resumeCursor(msgs,since),startedAt};save(state);
      const tmp=ACK+'.tmp';fs.writeFileSync(tmp,JSON.stringify({code:gate.code,chatId:CHAT,lastId:state.lastId,at:Date.now()}),{mode:0o600});fs.renameSync(tmp,ACK);
      console.log('Login recovery cursor initialized; history ignored',gate.code,state.lastId);
    }
    else if(!state){state={chatId:CHAT,lastId:resumeCursor(msgs,since),startedAt};save(state);console.log('Cursor initialized',state.lastId,'(grace '+GRACE_MS+'ms)');}
    else await processBatch(msgs,state,since,{save,running:()=>running,chat:llm&&(async(talk,m)=>{
      const r=await llm.reply(talk,m);
      if(r.text){const d=await sendText(CHAT,r.text);console.log(new Date().toISOString(),'LLM replied',m.localId,JSON.stringify(d||{}));}
      else if(r.skip!=='off')console.log(new Date().toISOString(),'LLM skip',m.localId,r.skip);
    }),observe:llm&&(m=>llm.observe(m,NICK)),chime:llm&&llm.config.chime&&(async()=>{
      const r=await llm.chime();
      if(r.text){const d=await sendText(CHAT,r.text);console.log(new Date().toISOString(),'LLM chimed',JSON.stringify(d||{}));}
      else if(!['not_enough','cooldown','eval_gap','off','quiet_hours'].includes(r.skip))console.log(new Date().toISOString(),'LLM chime skip',r.skip);
    }),reply:async(cmd,m)=>{
      const began=performance.now(),ageMs=Date.now()-Date.parse(m.timestamp);const result=await respond(cmd,NICK);if(!result)return;
      const renderMs=Math.round(performance.now()-began);let delivery;
      if(result.image){try{delivery=await sendImage(CHAT,result.image);}catch(e){
        console.error('Image send failed',e.message);
        if(/aborted|timeout/i.test(String(e.message)))requestRecycle('send timeout: '+e.message);
        if(e.uncertain){throw e;}
        try{await new Promise(r=>setTimeout(r,300));delivery=await sendImage(CHAT,result.image);console.log('Image send retry ok');}
        catch(e2){console.error('Image send retry failed',e2.message);
          if(/aborted|timeout/i.test(String(e2.message)))requestRecycle('send retry timeout: '+e2.message);if(result.fallbackText)delivery=await sendText(CHAT,result.fallbackText);else throw e2;}
      }}else if(result.text)delivery=await sendText(CHAT,result.text);
      console.log(new Date().toISOString(),'Replied',m.localId,cmd,JSON.stringify({ageMs,renderMs,totalMs:Math.round(performance.now()-began),...delivery}));
      // 放在 Replied 之后：主回复耗时口径不变；await 避免同批下一条消息在 a11y 层并发。
      const cute=(llm&&llm.commandHint&&llm.commandHint(m,cmd,result))||cuteLine(cmd,result);
      if(cute){try{await sendText(CHAT,cute);}catch(e){console.error('Cute line failed',e.message);}}
    }});
  }catch(e){
    failures++;const wait=require('./recovery-core').pollBackoff({failures,intervalMs:interval,minMs:cfg.backoffMin,maxMs:cfg.backoffMax});
    // 持续拉不到消息 = 客户端卡死的前兆，但这时候可能既没人 @、authed 也还是 logged_in，
    // 只有事件日志能把这条事实送到判定端。写成事件而不是自己重启容器（桥接只检测）。
    if(pollFailed&&failures%POLL_STUCK_LIMIT===0)
      writeRecoveryEvent({type:'poll_stuck',streak:failures,reason:String(e&&e.message||e).slice(0,120)});
    console.error(new Date().toISOString(),e.message,'(backoff '+wait+'ms, 连续失败 '+failures+')');
    if(running)await new Promise(r=>setTimeout(r,wait));
    continue;
  }
    failures=0;
    if(running)await new Promise(r=>setTimeout(r,interval));
  }
  // 主循环正常结束：先把 'Stopped' 打出来，再用一个 unref 的定时器兜底退出。
  // 不能在这里直接 process.exit()——调用方（测试/内嵌）拿到的 Promise 还没 resolve，
  // 会连 .then 都跑不到；unref 的定时器不阻止事件循环自然结束，但事件循环被后台
  // socket 挂住时它仍然会触发，保证不会又变成「等 systemd 60 秒 SIGKILL」。
  console.log('Stopped');
  setTimeout(()=>process.exit(0),500).unref();
}
// 兜底：异步异常不要让整个桥接直接死掉（systemd 会重启，但会丢当条回复）
process.on('unhandledRejection',e=>console.error(new Date().toISOString(),'unhandledRejection',e&&e.message||e));
process.on('uncaughtException',e=>console.error(new Date().toISOString(),'uncaughtException',e&&e.stack||e));
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={command,CHAT,cuteLine,resumeCursor,loadState,acquire,main,processBatch,pollConfig,GRACE_MS,BACKLOG_MS,EVENTS,backlogFloor,POLL_STUCK_LIMIT};
