'use strict';
const fs=require('fs');const {wx,sendImage}=require('./wx-client');const {respond}=require('./xiaoyouyou-v3.3');
const CHAT='123456789@chatroom';
async function rows(){return JSON.parse(await wx(['messages','list',CHAT,'-l','15','-j']));}
(async()=>{
 const results=fs.existsSync('cache/wechat-send-results.json')?JSON.parse(fs.readFileSync('cache/wechat-send-results.json')):[];
 // A text send replaces the old test-group draft through the CLI's Ctrl+A path.
 for(const command of ['帮助','地图','打工','随机武器','祭典']){
   if(results.some(r=>r.command===command))continue;
   const before=await rows(),max=Math.max(-1,...before.map(x=>x.localId));
   const r=await respond(command);if(command!=='帮助'&&!r.image)throw Error(command+' missing rendered image');
   await wx(['chats','open',CHAT]);
   console.log(command,r.image?JSON.stringify(await sendImage(CHAT,r.image)):await wx(['messages','send',CHAT,'--text',r.text],45000));
   let sent=[];
   for(let attempt=0;attempt<5;attempt++){
     await new Promise(res=>setTimeout(res,1500));
     sent=(await rows()).filter(m=>m.localId>max&&m.isSelf===true&&m.type===(r.image?3:1));
     if(sent.length)break;
   }
   if(sent.length!==1)throw Error(command+' expected one confirmed outbound message; got '+sent.length);
   results.push({command,localId:sent[0].localId,type:sent[0].type,confirmedAt:new Date().toISOString()});
   fs.writeFileSync('cache/wechat-send-results.json',JSON.stringify(results,null,2));
 }
 console.log('已确认测试群五项输出发送并回读。');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
