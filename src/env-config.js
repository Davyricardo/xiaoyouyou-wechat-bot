'use strict';
// 敏感配置（管理员 IM 用户 ID、Telegram chat id、通知渠道等）不再写进代码。
// 读取顺序：进程环境变量（生产由 systemd 的 EnvironmentFile 注入）
//          → private/*.env 文件（手工执行 / 调试时的兜底）。
// 读不到就返回 null / 空数组，由调用方明确报错或跳过通知——
// 绝不猜一个「看起来像」的默认值，那等于把身份又写死回代码里。
const fs=require('node:fs'),path=require('node:path');

function parseEnv(text){
  const out={};
  for(const line of String(text||'').split('\n')){
    const trimmed=line.trim();
    if(!trimmed||trimmed.startsWith('#'))continue;
    const body=trimmed.startsWith('export ')?trimmed.slice(7).trim():trimmed;
    const i=body.indexOf('=');
    if(i<=0)continue;
    const key=body.slice(0,i).trim();
    let value=body.slice(i+1).trim();
    if(value.length>1&&/^['"]/.test(value)&&value[0]===value[value.length-1])value=value.slice(1,-1);
    if(key)out[key]=value;
  }
  return out;
}
// private 目录：XYY_PRIVATE_DIR → $XYY_HOME/private → $XYY_BASE/private → $HOME/private → <代码目录>/private。
// 缺目录不算错误。生产（阿里云）代码扁平放在 /opt/xiaoyouyou，systemd 把 HOME 设成 /opt/xiaoyouyou/private，
// 所以 $HOME/private 落空，靠最后一项「代码目录/private」找到 /opt/xiaoyouyou/private/*.env。
function privateDirs(env=process.env){
  const home=env.HOME||'';
  const list=[env.XYY_PRIVATE_DIR,env.XYY_HOME?path.join(env.XYY_HOME,'private'):null,
    env.XYY_BASE?path.join(env.XYY_BASE,'private'):null,home?path.join(home,'private'):null,path.join(__dirname,'private')];
  return [...new Set(list.filter(Boolean))];
}
// 目录下的 *.env 都读（按文件名排序，后面的覆盖前面的）：生产包里通常就是 wechat.env。
function envFiles(env=process.env){
  const out=[];
  for(const dir of privateDirs(env)){
    let names=[];
    try{names=fs.readdirSync(dir).filter(n=>n.endsWith('.env'));}catch(e){if(e.code!=='ENOENT')throw e;continue;}
    names.sort();
    for(const n of names)out.push(path.join(dir,n));
  }
  return out;
}
let cache=null;
function privateEnv(env=process.env){
  if(cache&&cache.env===env)return cache.value;
  const merged={};
  for(const file of envFiles(env)){
    let text='';
    try{text=fs.readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}   // 文件被并发删掉不算错误
    Object.assign(merged,parseEnv(text));
  }
  cache={env,value:merged};
  return merged;
}
function reset(){cache=null;}
// 支持一次查多个 key（按优先级取第一个非空值）。
function secret(keys,env=process.env){
  const names=Array.isArray(keys)?keys:[keys];
  for(const name of names){
    const fromProcess=env[name];
    if(typeof fromProcess==='string'&&fromProcess.trim())return fromProcess.trim();
  }
  const fromFile=privateEnv(env);
  for(const name of names){
    const value=fromFile[name];
    if(typeof value==='string'&&value.trim())return value.trim();
  }
  return null;
}
function secretList(keys,env=process.env){
  return String(secret(keys,env)||'').split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
}
// 恢复审批、通知投递都按「管理员是自己」这条判据，变量缺失时一律拒绝/跳过。
function adminIds(env=process.env){return secretList(['XYY_ADMIN_IM_IDS','XYY_ADMIN_IM_ID'],env);}
function adminPlatform(env=process.env){return secret('XYY_ADMIN_IM_PLATFORM',env)||'weixin';}
function adminTarget(env=process.env){
  const ids=adminIds(env);
  return ids.length?adminPlatform(env)+':'+ids[0]:null;
}
function telegramTarget(env=process.env){
  const chat=secret('XYY_TELEGRAM_CHAT_ID',env);
  return chat?'telegram:'+chat:null;
}
module.exports={parseEnv,privateDirs,envFiles,privateEnv,reset,secret,secretList,adminIds,adminPlatform,adminTarget,telegramTarget};
