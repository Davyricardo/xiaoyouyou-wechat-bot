#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile);
const ROOT=process.env.SPLATOON_MONITOR_DIR||path.join(process.env.HOME||__dirname,'.local/state/splatoon-bridge');
const STATE=path.join(ROOT,'health-monitor.json');
const HERMES='/home/user/.hermes/hermes-agent/.hermes/bin/hermes';
const TARGET='weixin:user@im.wechat';
const REASONS={online:'正常',logged_out:'桌面微信未登录，需要在手机确认登录',api_error:'微信认证接口不可用',bridge_down:'小鱿鱿桥接服务未运行'};
function classify(probe){
 if(probe.recovering)return 'recovering';
 if(probe.bridge!=='active/running')return 'bridge_down';
 if(probe.apiError||typeof probe.auth!=='string'||!probe.auth)return 'api_error';
 return probe.auth==='logged_in'?'online':'logged_out';
}
function observe(previous,probe,now=Date.now()){
 const s=structuredClone(previous||{schema:1,status:'initializing',sequence:0,incidents:0,notifications:[]});
 s.checkedAt=now;s.probe={bridge:probe.bridge,auth:probe.auth||null,apiError:probe.apiError||null};
 const next=classify(probe),candidate=next==='online'?'online':'offline';s.candidate=candidate;
 s.streak=previous?.candidate===candidate?Math.min(2,(previous.streak||0)+1):1;
 if(next==='online')s.lastOnlineAt=now;
 let event=null;
 // Healthy startup is recorded silently. Down and recovery need two consecutive checks.
 if(s.status==='initializing'&&next==='online'){s.status='online';s.changedAt=now;}
 else if(s.streak>=2&&next!==s.status){
  const wasDown=s.status!=='online'&&s.status!=='initializing';
  s.status=next;s.changedAt=now;
  if(next!=='online'&&!wasDown){s.incidents++;s.downSince=now;}
  // Switching between failure reasons stays in the same incident and does not notify again.
  if(next==='online'||!wasDown){
   const id=++s.sequence;event={id,kind:next==='online'?'recovered':'down',status:next,at:now,incident:s.incidents,downSince:s.downSince||now};
   s.lastEvent=event;s.notifications.push({...event,delivery:'pending',attempts:0});
  }
  if(next==='online')delete s.downSince;
 }
 // Keep recent diagnostic history while retaining any unfinished deliveries.
 s.notifications=s.notifications.filter((n,i,a)=>i>=a.length-50||['pending','failed'].includes(n.delivery));
 return {state:s,event};
}
function atomic(file,value){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);}
function load(){try{return JSON.parse(fs.readFileSync(STATE,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function formatAlert(n){
 const when=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date(n.at));
 if(n.kind==='login_offer')return `是否重新登录小鱿鱿的桌面微信？\n两次提醒后仍未恢复。分析：${n.diagnosis.summary}。\n同意请回复：同意重新登录 ${n.code}\n暂不登录请回复：暂不重新登录 ${n.code}\n确认有效期 15 分钟。收到同意后才发起登录并发送二维码。\n过期后如需重新询问，请回复：重新询问登录 ${n.code}`;
 if(n.kind==='login_declined')return `已保留离线状态，不发起登录。监测继续，正常恢复时会通知。\n以后如需重新询问，请回复：重新询问登录 ${n.code}`;
 if(n.kind==='login_failed')return `小鱿鱿重新登录未完成：${n.reason}。\n未确认恢复正常，不会自动反复发二维码。\n如需重新询问，请回复：重新询问登录 ${n.code}`;
 if(n.kind==='manual_check')return `小鱿鱿已提醒两次。分析：${n.diagnosis.summary}。\n目前不具备确认可重新登录的条件，需要检查服务或接口；不会贸然发起登录。`;
 if(n.kind==='reminder2')return `小鱿鱿掉线提醒（2/2）\n时间：${when}（北京时间）\n分析：${n.diagnosis.summary}。\n仍未恢复；接下来将单独询问是否重新登录。`;
 if(n.kind==='recovered')return `小鱿鱿已恢复正常，可以继续使用\n时间：${when}（北京时间）\n原机器人账号登录、正式群界面和消息读取已核对，桥接服务连续两次检查正常。离线约 ${Math.max(1,Math.round((n.at-n.downSince)/60000))} 分钟。\n事件：${n.incident}；通知：${n.id}`;
 return `小鱿鱿掉线提醒（1/2）\n时间：${when}（北京时间）\n原因：${n.diagnosis?.summary||REASONS[n.status]}。\n机器人可能暂时无法回复。若仍未恢复，约两分钟后提醒第二次。\n事件：${n.incident}；通知：${n.id}`;
}
async function probe(){
 const [service,auth]=await Promise.allSettled([
  exec('systemctl',['show','xiaoyouyou-bridge.service','-p','ActiveState','-p','SubState'],{timeout:8000}),
  require('./wx-client').status()
 ]);
 const properties=service.status==='fulfilled'?Object.fromEntries(service.value.stdout.trim().split('\n').map(x=>x.split('='))):{};
 const infra=require('./recovery-infrastructure'),s=infra.read('health-monitor.json'),result=infra.read('recovery-result.json');
 const gate=infra.read('login-gate.json'),active=gate?.phase==='blocked'||gate?.phase==='paused'&&Date.now()<gate.expiresAt||
  result?.code===s?.recovery?.code&&['starting','waiting_scan','verifying'].includes(result?.phase)&&Date.now()-(result.updatedAt||result.startedAt)<360000;
 const p={bridge:properties.ActiveState&&properties.SubState?properties.ActiveState+'/'+properties.SubState:'unknown',
  auth:auth.status==='fulfilled'?auth.value.status:null,apiError:auth.status==='rejected'?'认证接口请求失败':null,recovering:!!active};
 if(p.auth==='logged_in'&&!infra.isExpectedUser(auth.value.loggedInUser)){p.auth=null;p.apiError='登录账号不是原机器人账号';}
 if(s?.status!=='online'&&p.auth==='logged_in'&&!active){
  if(!(result?.code===s?.recovery?.code&&result?.phase==='verified')){
   try{await infra.ensureReady();}catch{p.auth=null;p.apiError='登录后的正式群或输入框未通过校验';}
  }
 }
 return p;
}
async function sendViaHermes(message){
 try{
  const {stdout}=await exec(HERMES,['send','--to',TARGET,'--json',message],{cwd:'/home/user/.hermes',env:{...process.env,HERMES_HOME:'/home/user/.hermes'},timeout:60000,maxBuffer:1024*1024});
  let result;try{result=JSON.parse(stdout.trim());}catch{
   const lines=stdout.trim().split('\n');for(let i=lines.length-1;i>=0;i--){try{result=JSON.parse(lines[i]);break;}catch{}}
  }
  if(!result||result.success!==true)return {delivery:'uncertain',error:'Hermes 未返回明确成功，停止自动重发'};
  return {delivery:'sent',messageId:result.message_id||null};
 }catch(e){
  if(e.killed||e.code==='ETIMEDOUT')return {delivery:'uncertain',error:'Hermes 发送超时，停止自动重发'};
  // Backend errors can include an uncertain network outcome; do not repeat a potentially delivered alert.
  return {delivery:'failed',error:'Hermes 返回发送失败；详见 Hermes 日志，未自动重发'};
 }
}
const notify=n=>sendViaHermes(formatAlert(n));
async function runCheck(io){
 const previous=await io.load(),p=await io.probe();const {state:s,event}=observe(previous,p,io.now());
 if(io.recovery){
  const flow=require('./recovery-flow');
  if(event?.kind==='down')flow.begin(s,await io.recovery.diagnose(previous||s,p,io.now()),io.now());
  const result=await io.recovery.result();
  const second=s.notifications.find(n=>n.kind==='reminder2'&&n.incident===s.incidents);
  if(s.recovery&&(s.recovery.phase==='second_reminder'&&second?.delivery==='sent'||result?.code===s.recovery.code&&result.phase==='reoffer'))s.recovery.diagnosis=await io.recovery.diagnose(previous||s,p,io.now());
  if(classify(p)!=='online'||s.status==='online')flow.advance(s,io.now(),result);
  if(s.status==='online')for(const n of s.notifications)if(n.delivery==='pending'&&['down','reminder2','login_offer'].includes(n.kind))n.delivery='cancelled';
 }
 // A previous process interrupted during delivery may already have sent it.
 for(const n of s.notifications)if(n.delivery==='sending'){n.delivery='uncertain';n.error='发送进程中断，停止自动重发';}
 await io.save(s);
 if(event)await io.log(event);
 for(const n of s.notifications){
  if(n.delivery!=='pending')continue;
  n.delivery='sending';n.attempts++;n.attemptedAt=io.now();await io.save(s);
  Object.assign(n,await io.notify(n),{finishedAt:io.now()});await io.save(s);
  await io.log({kind:'notification',id:n.id,delivery:n.delivery,error:n.error||null});
 }
 return s;
}
async function main(){
 if(process.argv.includes('--test-notification')){
  const result=await sendViaHermes('小鱿鱿掉线监测已启用（测试通知）\n每 30 秒检查微信真实登录状态和桥接服务；连续两次异常提醒，连续两次恢复后通知。\n此消息用于确认 Hermes 微信私聊提醒通道，不代表发生掉线。');
  console.log(JSON.stringify(result));if(result.delivery!=='sent')process.exitCode=1;return;
 }
 fs.mkdirSync(ROOT,{recursive:true,mode:0o700});
 const infra=require('./recovery-infrastructure');
 await runCheck({load,probe,now:Date.now,recovery:{diagnose:infra.diagnose,result:()=>infra.read('recovery-result.json')},save:s=>atomic(STATE,s),notify,log:e=>{
  const line=JSON.stringify(e);fs.appendFileSync(path.join(ROOT,'health-events.jsonl'),line+'\n',{mode:0o600});console.log('WECHAT_HEALTH',line);
 }});
}
if(require.main===module)main().catch(e=>{console.error('WECHAT_HEALTH monitor failed:',e.message);process.exitCode=1;});
module.exports={classify,observe,formatAlert,runCheck,sendViaHermes};
