'use strict';
process.env.HOME='/opt/xiaoyouyou/private';
const fs=require('node:fs'),path=require('node:path'),{execFileSync,execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile),infra=require('./recovery-infrastructure'),c=require('./wx-client');
const {qrImage,loginSocket}=require('./wechat-recovery-worker');
const code=process.argv[2],verifyOnly=process.argv[3]==='verify';
if(!/^XYY-\d+-[0-9a-f]{8}$/.test(code||''))process.exit(2);
const folder=path.join(infra.ROOT,'remote-recovery'),file=path.join(folder,code+'.json'),confirmation=path.join(folder,code+'.confirmed');
fs.mkdirSync(folder,{recursive:true,mode:0o700});
const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
const mark=(phase,extra={})=>{const s={...read(),phase,...extra,updatedAt:Date.now()};const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s),{mode:0o600});fs.renameSync(tmp,file);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  infra.write('login-gate.json',{code,phase:'blocked'});
  if(!verifyOnly){
    const auth=await c.status();
    if(auth.status==='logged_in'&&infra.isExpectedUser(auth.loggedInUser))mark('awaiting_confirmation');
    else{
      if(auth.status!=='logged_out'||auth.loggedInUser&&!infra.isExpectedUser(auth.loggedInUser))throw Error('登录状态或账号不符合恢复条件');
      const d=JSON.parse(execFileSync('docker',['inspect','splatoon-wechat-test'],{encoding:'utf8',timeout:8000}))[0];
      const token=d.Config.Env.find(x=>x.startsWith('AGENT_WECHAT_TOKEN='))?.slice('AGENT_WECHAT_TOKEN='.length);
      if(!token)throw Error('缺少微信接口认证');
      await loginSocket({timeoutMs:180000,
        connect:()=>new WebSocket('ws://127.0.0.1:6174/api/ws/login?'+new URLSearchParams({timeoutMs:'180000',newAccount:'false',token})),
        current:()=>read().code===code,
        qr:async data=>{const png=path.join(folder,code+'.png');await qrImage(data,png);mark('waiting_scan',{qrReady:true,qrExpiresAt:Date.now()+180000});},
        phone:async()=>mark('waiting_scan',{phoneConfirm:true}),
        success:async id=>{if(id&&!infra.isExpectedUser(id))throw Error('扫码账号不是原机器人账号');mark('awaiting_confirmation');}
      });
    }
    const until=Date.now()+600000;
    while(!fs.existsSync(confirmation)&&Date.now()<until)await delay(1000);
    if(!fs.existsSync(confirmation))throw Error('等待已登录回复超时');
  }
  mark('verifying');await infra.ensureReady();
  infra.write('login-gate.json',{code,phase:'resume'});
  await exec('systemctl',['start','xiaoyouyou-aliyun.service'],{timeout:40000});
  let ack;for(let i=0;i<60;i++){ack=infra.read('bridge-recovery-ack.json');if(ack?.code===code)break;await delay(500);}
  if(ack?.code!==code)throw Error('恢复后游标重置未确认');
  await infra.ensureReady();infra.write('login-gate.json',{code,phase:'finished'});
  mark('verified',{cursor:ack.lastId,verifiedAt:Date.now()});
})().catch(error=>{mark('failed',{reason:error.message});infra.write('login-gate.json',{code,phase:'blocked'});process.exitCode=1;});
