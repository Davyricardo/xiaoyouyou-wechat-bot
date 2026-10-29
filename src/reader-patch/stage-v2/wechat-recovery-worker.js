#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const infra=require('./recovery-infrastructure'),{validRequest}=require('./recovery-flow');
const {sendViaHermes}=require('./wechat-health-monitor'),c=require('./wx-client');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function qrImage(data,file){
 const QR=require('qrcode-terminal/vendor/QRCode'),level=require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
 if(typeof data!=='string'||!data||data.length>8000)throw Error('登录二维码数据无效');
 const qr=new QR(-1,level.M);qr.addData(data);qr.make();const count=qr.getModuleCount(),size=(count+8)*8;let pixels='';
 for(let y=0;y<count;y++)for(let x=0;x<count;x++)if(qr.isDark(y,x))pixels+=`M${x+4} ${y+4}h1v1h-1z`;
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${count+8} ${count+8}"><rect width="100%" height="100%" fill="white"/><path d="${pixels}" fill="black" shape-rendering="crispEdges"/></svg>`;
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 await require('sharp')(Buffer.from(svg)).png().toFile(file);fs.chmodSync(file,0o600);
}
async function loginSocket(io){
 let qrSent=false,phoneSent=false,chain=Promise.resolve();
 let socket,timer;
 try{
  await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('扫码登录超时')),io.timeoutMs||180000);
   socket=io.connect();
   socket.addEventListener('error',()=>reject(Error('登录连接失败')));
   socket.addEventListener('close',()=>reject(Error('登录连接结束，未确认成功')));
   socket.addEventListener('message',event=>{
    let value;try{value=JSON.parse(typeof event.data==='string'?event.data:String(event.data));}catch{return;}
    chain=chain.then(async()=>{
     if(!await io.current())throw Error('当前登录事件已结束');
     if(value.type==='qr'&&!qrSent){
      qrSent=true;const data=value.qrBinaryData?Buffer.from(value.qrBinaryData).toString('utf8'):value.qrData;
      await io.qr(data);
     }else if(value.type==='phone_confirm'&&!phoneSent){phoneSent=true;await io.phone();}
     else if(value.type==='login_success'){if(io.success)await io.success(value.userId);resolve();}
     else if(value.type==='login_timeout')throw Error('扫码登录超时');
     else if(value.type==='error')throw Error('微信登录接口返回错误');
    }).catch(reject);
   });
  });
 }finally{clearTimeout(timer);socket?.close();await chain.catch(()=>{});}
}
function token(){
 const d=JSON.parse(execFileSync('docker',['inspect','splatoon-wechat-test'],{encoding:'utf8',timeout:8000}))[0];
 const row=d.Config.Env.find(x=>x.startsWith('AGENT_WECHAT_TOKEN='));if(!row)throw Error('微信认证信息不可用');return row.slice(row.indexOf('=')+1);
}
async function processRequest(s,request){
 if(!validRequest(s,request,Date.now()))return;
 const r=s.recovery,old=infra.read('recovery-result.json');if(old?.code===r.code)return;
 const result={code:r.code,incident:r.incident,phase:request.action==='decline'?'declined':'starting',approvedAt:request.at,startedAt:Date.now()};
 infra.write('recovery-result.json',result);if(request.action==='decline')return;
 const qrFile=path.join(infra.ROOT,'recovery-qr',r.code+'.png');
 let gated=false;
 const mark=(phase,extra={})=>{Object.assign(result,{phase,updatedAt:Date.now()},extra);infra.write('recovery-result.json',result);};
 try{
  const auth=await c.status();
  if(auth.status==='logged_in'&&infra.isExpectedUser(auth.loggedInUser)){mark('verified',{ready:await infra.ensureReady(),verifiedAt:Date.now()});return;}
  if(auth.status!=='logged_out')throw Error('登录状态已变化，本次不发起登录');
  if(auth.loggedInUser&&!infra.isExpectedUser(auth.loggedInUser))throw Error('当前记忆账号不一致，需要人工检查');
  infra.write('login-gate.json',{code:r.code,phase:'paused',expiresAt:Date.now()+360000});
  gated=true;
  const wsToken=token();
  await loginSocket({
   connect:()=>new WebSocket('ws://127.0.0.1:6174/api/ws/login?'+new URLSearchParams({timeoutMs:'180000',newAccount:'true',token:wsToken})),
   current:()=>infra.read('health-monitor.json')?.recovery?.code===r.code,
   success:async userId=>{if(userId&&!infra.isExpectedUser(userId))throw Error('扫码账号与原机器人账号不一致');},
   qr:async data=>{
    await qrImage(data,qrFile);mark('waiting_scan',{qrCreatedAt:Date.now(),qrExpiresAt:Date.now()+180000});
    const sent=await sendViaHermes(`已收到你同意重新登录。\n请使用原机器人账号扫描下方二维码，并在手机确认。二维码有时效；本次只发送一次，过期后不会自动刷屏。\n事件：${r.code}\nMEDIA:${qrFile}`);
    if(sent.delivery!=='sent')throw Error('二维码发送未确认成功，请人工检查');
    result.qrDelivery='sent';result.qrMessageId=sent.messageId;mark('waiting_scan');
   },
   phone:async()=>{
    const sent=await sendViaHermes(`请在机器人账号的手机微信上确认本次桌面登录。\n事件：${r.code}`);
    result.phoneDelivery=sent.delivery;mark('waiting_scan');
   }
  });
  mark('verifying');await infra.ensureReady();
  // Allow message synchronization to settle, then ignore accumulated offline history.
  await delay(8000);infra.write('login-gate.json',{code:r.code,phase:'resume'});
  let ack;for(let i=0;i<10;i++){ack=infra.read('bridge-recovery-ack.json');if(ack?.code===r.code)break;await delay(2000);}
  if(ack?.code!==r.code)throw Error('桥接恢复游标未确认');
  const ready=await infra.ensureReady();mark('verified',{verifiedAt:Date.now(),ready,cursor:ack.lastId});
  infra.write('login-gate.json',{code:r.code,phase:'finished'});
 }catch(e){
  mark('failed',{reason:e.message});
  // Release the gate with a history reset; send guards still reject an unready login/UI.
  if(gated){
   let wrongAccount=/扫码账号/.test(e.message);try{const auth=await c.status();wrongAccount=wrongAccount||auth.status==='logged_in'&&!infra.isExpectedUser(auth.loggedInUser);}catch{}
   infra.write('login-gate.json',{code:r.code,phase:wrongAccount?'blocked':'resume'});
  }
 }finally{
  try{fs.unlinkSync(qrFile);}catch(e){if(e.code!=='ENOENT')console.error('QR cleanup failed');}
 }
}
async function main(){
 fs.mkdirSync(infra.ROOT,{recursive:true,mode:0o700});
 let running=true;process.on('SIGTERM',()=>{running=false;});process.on('SIGINT',()=>{running=false;});
 while(running){try{
  const s=infra.read('health-monitor.json'),code=s?.recovery?.code;
  const old=infra.read('recovery-result.json');
  if(old&&['starting','waiting_scan','verifying'].includes(old.phase)&&Date.now()-(old.updatedAt||old.startedAt)>360000){
   infra.write('recovery-result.json',{...old,phase:'failed',reason:'恢复进程中断或超时，需要人工检查',updatedAt:Date.now()});
   let wrongAccount=false;try{const auth=await c.status();wrongAccount=auth.status==='logged_in'&&!infra.isExpectedUser(auth.loggedInUser);}catch{}
   infra.write('login-gate.json',{code:old.code,phase:wrongAccount?'blocked':'resume'});
  }
  if(code&&/^XYY-\d+-[0-9a-f]{8}$/.test(code)){
   const retry=infra.read('recovery-requests/'+code+'-reoffer.json');
   if(['declined','failed','expired'].includes(s.recovery.phase)&&s.status!=='online'&&retry?.action==='reoffer'&&retry.code===code&&retry.incident===s.recovery.incident&&retry.platform==='weixin'&&retry.userId==='user@im.wechat'&&Date.now()-retry.at>=0&&Date.now()-retry.at<900000){
    infra.write('recovery-result.json',{code,incident:s.recovery.incident,phase:'reoffer',requestedAt:retry.at});
   }else await processRequest(s,infra.read('recovery-requests/'+code+'.json'));
  }
 }catch{console.error('WECHAT_RECOVERY check failed; no automatic login retry');}
  if(running)await delay(5000);
 }
}
if(require.main===module)main().catch(()=>{console.error('WECHAT_RECOVERY worker failed');process.exitCode=1;});
module.exports={qrImage,loginSocket,processRequest};
