'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');const exec=promisify(execFile);
const c=require('./wx-client'),{CHAT,CHAT_NAME}=require('./bot-config'),{privateDirs}=require('./env-config');
const ROOT=process.env.SPLATOON_MONITOR_DIR||path.join(process.env.HOME||require('node:os').homedir(),'.local/state/splatoon-bridge');
// 期望账号：XYY_EXPECTED_USER → private/expected-user.txt（WebUI 首次登录成功后自动写入）。
// 全新部署没有这个文件时不校验账号（否则永远过不了 preflight），但第一次登录就会锁定，
// 之后换号会被 isExpectedUser 判成异常——安全性只在「首次」让步。
function expectedFile(){
 const dirs=privateDirs();
 for(const dir of dirs){const f=path.join(dir,'expected-user.txt');if(fs.existsSync(f))return f;}
 return path.join(dirs[0]||path.join(__dirname,'private'),'expected-user.txt');
}
function expectedUser(){
 const fromEnv=String(process.env.XYY_EXPECTED_USER||'').trim();if(fromEnv)return fromEnv;
 try{return fs.readFileSync(expectedFile(),'utf8').trim();}catch{return '';}
}
function isExpectedUser(value){
 if(typeof value!=='string'||!/^wxid_[a-zA-Z0-9]+(?:_[a-zA-Z0-9]+)?$/.test(value))return false;
 const expected=expectedUser();
 if(!expected)return true;
 return value.split('_').slice(0,2).join('_')===expected.split('_').slice(0,2).join('_');
}
function lockExpectedUser(value){
 if(!isExpectedUser(value))throw Error('账号格式非法');
 const file=expectedFile();fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 fs.writeFileSync(file,String(value).trim()+'\n',{mode:0o600});
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
 return {chatId:CHAT,draftEmpty:true,userId:expectedUser()||null,at:Date.now()};
}
module.exports={ROOT,expectedUser,lockExpectedUser,isExpectedUser,read,write,diagnose,ensureReady};
