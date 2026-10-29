#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');const {rows,sendImage,sendText}=require('./wx-client');
const {respond,ALLOWED}=require('./xiaoyouyou-v3.3');
const {CHAT,NICK}=require('./bot-config');
const STATE=process.env.SPLATOON_STATE_FILE||path.join(process.env.HOME,'.local/state/splatoon-bridge/state.json');
const LOCK=path.join(path.dirname(STATE),'bridge-v3.3.lock');
const GATE=path.join(path.dirname(STATE),'login-gate.json'),ACK=path.join(path.dirname(STATE),'bridge-recovery-ack.json');
function readOptional(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
function command(m,startedAt=0){
  if(!m||m.chatId!==CHAT||m.type!==1||m.isMentioned!==true||m.isSelf!==false||!Number.isSafeInteger(m.localId)||m.localId<0)return null;
  const ts=Date.parse(m.timestamp);if(!Number.isFinite(ts)||ts<startedAt)return null;
  const text=String(m.content||'').trim(),prefix='@'+NICK;
  if(!text.startsWith(prefix))return null;
  const cmd=text.slice(prefix.length).trim();return ALLOWED.has(cmd)?cmd:null;
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
function save(s){const tmp=STATE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s),{mode:0o600});fs.renameSync(tmp,STATE);}
async function processBatch(msgs,state,startedAt,handlers){
  for(const m of msgs){
    if(handlers.running&& !handlers.running())break;
    if(m.localId<=state.lastId)continue;
    state.lastId=m.localId;handlers.save(state);
    const cmd=command(m,startedAt);if(!cmd)continue;
    await handlers.reply(cmd,m);
  }
}
async function main(){
  acquire();let running=true;const startedAt=Date.now(),interval=Math.max(1000,Number(process.env.POLL_MS)||2000);
  process.on('SIGINT',()=>running=false);process.on('SIGTERM',()=>running=false);
  let state;console.log('小鱿鱿 v3.3 started; chat='+CHAT+'; history ignored; poll='+interval+'ms.');
  while(running){try{
    const gate=readOptional(GATE),gateAction=require('./recovery-gate').action(gate,readOptional(ACK),Date.now());
    if(gateAction==='wait'){await new Promise(r=>setTimeout(r,interval));continue;}
    const list=await rows(50);if(!Array.isArray(list))throw Error('消息列表格式变化');
    const msgs=list.filter(m=>m.chatId===CHAT&&Number.isSafeInteger(m.localId)).sort((a,b)=>a.localId-b.localId);
    if(gateAction==='reset'){
      state={chatId:CHAT,lastId:msgs.reduce((n,m)=>Math.max(n,m.localId),-1),startedAt};save(state);
      const tmp=ACK+'.tmp';fs.writeFileSync(tmp,JSON.stringify({code:gate.code,chatId:CHAT,lastId:state.lastId,at:Date.now()}),{mode:0o600});fs.renameSync(tmp,ACK);
      console.log('Login recovery cursor initialized; history ignored',gate.code,state.lastId);
    }
    else if(!state){state={chatId:CHAT,lastId:msgs.reduce((n,m)=>Math.max(n,m.localId),-1),startedAt};save(state);console.log('Cursor initialized',state.lastId);}
    else await processBatch(msgs,state,startedAt,{save,running:()=>running,reply:async(cmd,m)=>{
      const began=performance.now(),ageMs=Date.now()-Date.parse(m.timestamp);const result=await respond(cmd,NICK);if(!result)return;
      const renderMs=Math.round(performance.now()-began);let delivery;
      if(result.image){try{delivery=await sendImage(CHAT,result.image);}catch(e){
        console.error('Image send failed',e.message);if(!e.uncertain&&result.fallbackText)delivery=await sendText(CHAT,result.fallbackText);else throw e;
      }}else if(result.text)delivery=await sendText(CHAT,result.text);
      console.log(new Date().toISOString(),'Replied',m.localId,cmd,JSON.stringify({ageMs,renderMs,totalMs:Math.round(performance.now()-began),...delivery}));
    }});
  }catch(e){console.error(new Date().toISOString(),e.message);}
    if(running)await new Promise(r=>setTimeout(r,interval));
  }console.log('Stopped');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={command,CHAT,acquire,main,processBatch};
