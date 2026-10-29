'use strict';
process.env.HOME='/opt/xiaoyouyou/private';
const fs=require('node:fs'),path=require('node:path'),{execFileSync,spawn}=require('node:child_process');
const infra=require('./recovery-infrastructure'),c=require('./wx-client');
const folder=path.join(infra.ROOT,'remote-recovery');
function valid(code){if(!/^XYY-\d+-[0-9a-f]{8}$/.test(code||''))throw Error('Invalid incident code');return code;}
function result(code){
  try{
    const file=path.join(folder,valid(code)+'.json'),s=JSON.parse(fs.readFileSync(file,'utf8'));
    const limits={starting:240000,waiting_scan:240000,awaiting_confirmation:660000,verifying:180000};
    if(limits[s.phase]&&Date.now()-(s.updatedAt||s.startedAt)>limits[s.phase]){
      Object.assign(s,{phase:'failed',reason:'恢复任务中断或超时，需要重新确认',updatedAt:Date.now()});
      const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(s),{mode:0o600});fs.renameSync(temp,file);
      infra.write('login-gate.json',{code,phase:'blocked'});
    }
    return s;
  }catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function launch(code,mode){const child=spawn('/usr/bin/node',['/opt/xiaoyouyou/aliyun-recovery-job.js',code,...(mode?[mode]:[])],{detached:true,stdio:'ignore',env:{...process.env,HOME:'/opt/xiaoyouyou/private'}});child.unref();}
(async()=>{
  const raw=fs.readFileSync(0,'utf8');if(raw.length>4096)throw Error('Request too large');const q=JSON.parse(raw);
  if(q.action==='status'){
    const auth=await c.status();const props=Object.fromEntries(execFileSync('systemctl',['show','xiaoyouyou-aliyun.service','-p','ActiveState','-p','SubState'],{encoding:'utf8',timeout:8000}).trim().split('\n').map(s=>s.split('=')));
    const running=execFileSync('docker',['inspect','splatoon-wechat-test','--format','{{.State.Running}}'],{encoding:'utf8',timeout:8000}).trim()==='true';
    const gate=infra.read('login-gate.json');const gated=require('./recovery-gate').action(gate,infra.read('bridge-recovery-ack.json'),Date.now())==='wait';
    console.log(JSON.stringify({ok:true,auth:auth.status,expected:infra.isExpectedUser(auth.loggedInUser),bridge:props.ActiveState+'/'+props.SubState,gated,canLogin:auth.status==='logged_out'&&running&&(!auth.loggedInUser||infra.isExpectedUser(auth.loggedInUser))}));return;
  }
  const code=valid(q.code);fs.mkdirSync(folder,{recursive:true,mode:0o700});let s=result(code);
  if(q.action==='pause'){
    infra.write('login-gate.json',{code,phase:'blocked'});
  }else if(q.action==='begin'){
    if(s){console.log(JSON.stringify({ok:true,result:s}));return;}
    if(!Number.isFinite(q.approvedAt)||Date.now()-q.approvedAt<0||Date.now()-q.approvedAt>900000)throw Error('Expired approval');
    s={code,phase:'starting',approvedAt:q.approvedAt,startedAt:Date.now()};fs.writeFileSync(path.join(folder,code+'.json'),JSON.stringify(s),{flag:'wx',mode:0o600});launch(code);
  }else if(q.action==='confirm'){
    if(!s){s={code,phase:'verifying',startedAt:Date.now()};fs.writeFileSync(path.join(folder,code+'.json'),JSON.stringify(s),{flag:'wx',mode:0o600});launch(code,'verify');}
    else if(s.phase==='failed')launch(code,'verify');
    fs.writeFileSync(path.join(folder,code+'.confirmed'),String(Date.now()),{mode:0o600});
  }else if(q.action==='qr'){
    if(!s?.qrReady||Date.now()>s.qrExpiresAt)throw Error('QR code unavailable or expired');const bytes=fs.readFileSync(path.join(folder,code+'.png'));
    if(bytes.length>2e6||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Invalid QR image');
    console.log(JSON.stringify({ok:true,png:bytes.toString('base64'),expiresAt:s.qrExpiresAt}));return;
  }else if(q.action!=='result')throw Error('Unknown action');
  console.log(JSON.stringify({ok:true,result:s}));
})().catch(error=>{console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
