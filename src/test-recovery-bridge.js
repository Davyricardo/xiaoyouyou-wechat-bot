'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
test('真实桥接循环暂停后只重置一次游标，忽略离线旧指令并处理新指令',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-gate-test-')),code='XYY-1-01234567';
 const script=`
 const fs=require('fs'),path=require('path');const dir=process.env.TEST_STATE_DIR;
 const {CHAT}=require('./bot-config');let list=[{chatId:CHAT,type:1,isMentioned:true,isSelf:false,localId:1,content:'@小鱿鱿 帮助',timestamp:new Date(Date.now()+50).toISOString()}],sends=0,reads=0;
 function cache(name,exports){const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};}
 cache('./wx-client',{rows:async()=>{reads++;return list;},sendText:async()=>{sends++;},sendImage:async()=>{sends++;}});
 cache('./xiaoyouyou-v3.3',{ALLOWED:new Set(['帮助']),respond:async()=>({text:'test'})});
 fs.writeFileSync(path.join(dir,'login-gate.json'),JSON.stringify({code:'${code}',phase:'paused',expiresAt:Date.now()+10000}));
 const run=require('./bridge-v3.3').main();
 setTimeout(()=>{
  if(reads!==0)throw Error('pause unexpectedly read rows');
  fs.writeFileSync(path.join(dir,'login-gate.json'),JSON.stringify({code:'${code}',phase:'resume'}));
 },150);
 const check=setInterval(()=>{
  const ack=path.join(dir,'bridge-recovery-ack.json');if(!fs.existsSync(ack))return;
  if(sends!==0)throw Error('old command was sent');
  clearInterval(check);list.push({...list[0],localId:2,timestamp:new Date().toISOString()});
  const finish=setInterval(()=>{if(sends!==1)return;clearInterval(finish);process.emit('SIGTERM');},30);
 },30);
 setTimeout(()=>{process.emit('SIGTERM');process.exitCode=2;},7000).unref();
 run.then(()=>{console.log('RESULT',JSON.stringify({sends,reads,ack:JSON.parse(fs.readFileSync(path.join(dir,'bridge-recovery-ack.json'))),state:JSON.parse(fs.readFileSync(path.join(dir,'state.json')))}));}).catch(e=>{console.error(e.message);process.exitCode=1;});
 `;
 const child=spawn(process.execPath,['-e',script],{cwd:__dirname,env:{...process.env,TEST_STATE_DIR:dir,SPLATOON_STATE_FILE:path.join(dir,'state.json'),POLL_MS:'1000'}});let out='',err='';
 child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const exit=await new Promise(resolve=>child.on('exit',resolve));assert.equal(exit,0,err+'\n'+out);
 const result=JSON.parse(out.split('\n').find(x=>x.startsWith('RESULT ')).slice(7));assert.equal(result.sends,1);assert.equal(result.ack.code,code);assert.equal(result.ack.lastId,1);assert.equal(result.state.lastId,2);
 for(const name of fs.readdirSync(dir))fs.unlinkSync(path.join(dir,name));fs.rmdirSync(dir);
});
