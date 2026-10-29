'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');const exec=promisify(execFile);
const c=require('./wx-client'),{CHAT,CHAT_NAME}=require('./bot-config');
const ROOT=process.env.SPLATOON_MONITOR_DIR||path.join(process.env.HOME||require('node:os').homedir(),'.local/state/splatoon-bridge');
const EXPECTED='wxid_bot_account';
function isExpectedUser(value){
 if(typeof value!=='string'||!/^wxid_[a-zA-Z0-9]+(?:_[a-zA-Z0-9]+)?$/.test(value))return false;
 return value.split('_').slice(0,2).join('_')===EXPECTED.split('_').slice(0,2).join('_');
}
function read(name){try{return JSON.parse(fs.readFileSync(path.join(ROOT,name),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function write(name,value){fs.mkdirSync(ROOT,{recursive:true,mode:0o700});const f=path.join(ROOT,name),t=f+'.tmp';fs.writeFileSync(t,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(t,f);}
async function diagnose(s,p,now){
 const since=new Date(Math.max(now-15*60000,s.lastOnlineAt||now-15*60000)).toISOString();
 const [container,logs,processes]=await Promise.allSettled([
  exec('docker',['inspect','splatoon-wechat-test','--format','{{.State.Status}} {{.State.OOMKilled}}'],{timeout:8000}),
  exec('docker',['logs','--since',since,'--tail','150','splatoon-wechat-test'],{timeout:8000,maxBuffer:100000}),
  exec('docker',['exec','splatoon-wechat-test','ps','-e','-o','comm='],{timeout:8000,maxBuffer:50000})
 ]);
 const text=logs.status==='fulfilled'?logs.value.stdout+'\n'+logs.value.stderr:'';
 const crashed=/Segmentation fault|process disappeared/.test(text),restarted=/Spawned WeChat/.test(text);
 const running=container.status==='fulfilled'&&container.value.stdout.trim().startsWith('running ');
 const hasProcess=processes.status==='fulfilled'&&processes.value.stdout.split('\n').some(x=>x.trim()==='wechat');
 const reloginEligible=p.auth==='logged_out'&&p.bridge==='active/running'&&running&&hasProcess;
 return {crashed,restarted,containerRunning:running,wechatProcess:hasProcess,reloginEligible,
  summary:crashed?(restarted?'微信客户端崩溃后已自动重启，当前未登录':'微信客户端出现崩溃记录'):restarted?'微信客户端已重启，当前未登录':p.auth==='logged_out'?'微信登录状态失效':p.bridge!=='active/running'?'桥接服务异常，未确认微信需要重新登录':'微信接口异常，无法确认登录状态'};
}
async function ensureReady(){
 const auth=await c.status();if(auth.status!=='logged_in'||!isExpectedUser(auth.loggedInUser))throw Error('未确认原机器人账号登录');
 const chats=await c.apiGet('/api/chats/find?name='+encodeURIComponent(CHAT_NAME));const exact=chats.filter(x=>x.name===CHAT_NAME);
 if(exact.length!==1||(exact[0].chatId||exact[0].id)!==CHAT)throw Error('正式群身份校验失败');
 await c.wx(['chats','open',CHAT]);
 const e=require('./wx-fast').ready(await c.a11yTree(),c.editor);if(String(e.input.text||'').trim())throw Error('正式群输入框有草稿，未确认可回复');
 const rows=await c.rows(50);if(!Array.isArray(rows))throw Error('消息读取异常');
 return {chatId:CHAT,draftEmpty:true,userId:EXPECTED,at:Date.now()};
}
module.exports={ROOT,EXPECTED,isExpectedUser,read,write,diagnose,ensureReady};
