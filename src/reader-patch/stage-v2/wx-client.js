'use strict';
const path=require('node:path');const {execFile,execFileSync}=require('node:child_process');
const {CHAT,CHAT_NAME,groupHeader}=require('./bot-config');
let env;
function environment(){
  if(env)return env;
  let token=process.env.AGENT_WECHAT_TOKEN;
  if(!token){
    const d=JSON.parse(execFileSync('docker',['inspect','splatoon-wechat-test'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024}))[0];
    const item=d.Config.Env.find(x=>x.startsWith('AGENT_WECHAT_TOKEN='));
    if(!item)throw Error('现有微信容器未提供认证令牌');token=item.slice(item.indexOf('=')+1);
  }
  env={...process.env,AGENT_WECHAT_TOKEN:token,AGENT_WECHAT_URL:'http://127.0.0.1:6174'};return env;
}
function wx(args,timeout=25000){return new Promise((resolve,reject)=>execFile(process.env.WX_BIN||path.join(__dirname,'node_modules/.bin/wx'),args,{env:environment(),timeout,maxBuffer:2*1024*1024},(e,out,err)=>{if(e){const error=Error((err||e.message).slice(0,200));error.uncertain=e.killed||e.code==='ETIMEDOUT';reject(error);}else resolve(out);}));}
async function status(){const r=await fetch('http://127.0.0.1:6174/api/status/auth',{headers:{Authorization:'Bearer '+environment().AGENT_WECHAT_TOKEN},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('微信状态 HTTP '+r.status);return r.json();}
function editor(tree){
  for(const parent of [tree,...(tree?.children||[])]){
    const children=parent?.children||[],button=children.find(n=>n.role==='push-button'&&n.name==='Send(S)'),input=children.find(n=>n.role==='text'&&n.states?.includes('EDITABLE'));
    if(input&&button)return {input,button};
  }
  for(const child of tree?.children||[]){const found=editor(child);if(found)return found;}
  return null;
}
function pendingImageButton(tree){
  const e=editor(tree);let group=false;
  function walk(n){if(n?.role==='label'&&groupHeader(n.name))group=true;for(const c of n?.children||[])walk(c);}walk(tree);
  if(!group||!e||e.input.name!==CHAT_NAME||String(e.input.text||'').trim()!=='\ufffc'||e.button.states?.includes('DISABLED'))throw Error('未确认授权群聊的单张图片草稿，停止发送');
  const b=e.button.bounds;if(!b||![b.x,b.y,b.width,b.height].every(Number.isFinite)||b.width<=0||b.height<=0)throw Error('发送按钮位置无效');
  return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};
}
async function apiGet(endpoint){const r=await fetch('http://127.0.0.1:6174'+endpoint,{headers:{Authorization:'Bearer '+environment().AGENT_WECHAT_TOKEN},signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('微信接口 HTTP '+r.status);return r.json();}
async function rows(limit=50){const messages=await apiGet('/api/messages/'+encodeURIComponent(CHAT)+'?limit='+limit);if(!Array.isArray(messages))throw Error('消息列表结构变化');return messages;}
async function a11yTree(){const r=await apiGet('/api/debug/a11y');if(!r.tree)throw Error(r.error||'界面读取失败');return r.tree;}
async function confirmImage(afterId,attempts=12){
  for(let i=0;i<attempts;i++){
    const sent=(await rows()).filter(m=>m.chatId===CHAT&&m.localId>afterId&&m.isSelf===true&&m.type===3);
    if(sent.length===1)return sent[0];if(sent.length>1)throw Error('图片发送数量不唯一，停止重试');
    await new Promise(r=>setTimeout(r,2000));
  }return null;
}
async function completePendingImage(afterId){
  const existing=await confirmImage(afterId,1);if(existing)return existing;
  const button=pendingImageButton(JSON.parse(await wx(['a11y'])));
  await new Promise((resolve,reject)=>execFile('docker',['exec','splatoon-wechat-test','/opt/tools/click',String(button.x),String(button.y)],{timeout:12000},e=>e?reject(e):resolve()));
  const confirmed=await confirmImage(afterId);if(!confirmed){const e=Error('图片发送后尚未回读确认，不自动重发');e.uncertain=true;throw e;}return confirmed;
}
async function sendImageLegacy(chat,file){
  if(chat!==CHAT)throw Error('图片仅允许发往授权群聊');
  const before=await rows(),lastId=Math.max(-1,...before.map(m=>m.localId));
  const tree=JSON.parse(await wx(['a11y'])),e=editor(tree);
  if(!e||String(e.input.text||'').trim()){const error=Error('微信输入框已有未发送内容，停止覆盖');error.uncertain=true;throw error;}
  try{await wx(['messages','send',chat,'--image',file],45000);}catch(error){
    const sent=await confirmImage(lastId,1);if(sent)return sent;
    if(error.uncertain)throw error;
    if(!error.message.includes('No action selected'))throw error;
    // This CLI pastes an image and presses Return, but this WeChat build leaves
    // the image in the editor. Finish only one verified image in the configured group.
    try{return await completePendingImage(lastId);}catch(e){e.uncertain=true;throw e;}
  }
  const sent=await confirmImage(lastId);if(!sent){const error=Error('CLI 未回读确认图片，停止自动重发');error.uncertain=true;throw error;}return sent;
}
module.exports={wx,status,editor,pendingImageButton,apiGet,rows,a11yTree,sendImageLegacy,completePendingImage,
  sendImage:(...args)=>require('./wx-fast').sendImage(...args),sendText:(...args)=>require('./wx-fast').sendText(...args)};
