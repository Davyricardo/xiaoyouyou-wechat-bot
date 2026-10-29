'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BASE = process.env.XYY_HOME || __dirname;
function atomic(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp=file+'.tmp-'+process.pid+'-'+crypto.randomBytes(3).toString('hex');
  fs.writeFileSync(tmp,data); fs.renameSync(tmp,file);
}
function fetchBuffer(url, limit=12e6, redirects=3) {
  return new Promise((resolve,reject)=> {
    const u=new URL(url); if(u.protocol!=='https:')return reject(Error('仅支持 HTTPS'));
    const req=https.get(u,{headers:{'User-Agent':'XiaoYouyou/3.3 (personal schedule bot)'},timeout:15000},res=>{
      if([301,302,303,307,308].includes(res.statusCode)&&redirects>0){res.resume();return resolve(fetchBuffer(new URL(res.headers.location,u).href,limit,redirects-1));}
      if(res.statusCode!==200){res.resume();return reject(Error('数据源 HTTP '+res.statusCode));}
      let size=0, chunks=[];
      res.on('data',b=>{size+=b.length;if(size>limit)req.destroy(Error('数据超过大小限制'));else chunks.push(b);});
      res.on('end',()=>resolve(Buffer.concat(chunks)));res.on('error',reject);
    });req.on('timeout',()=>req.destroy(Error('数据源连接超时')));req.on('error',reject);
    const timer=setTimeout(()=>req.destroy(Error('数据源请求超时')),25000);req.on('close',()=>clearTimeout(timer));
  });
}
const getJson=async url=>JSON.parse((await fetchBuffer(url)).toString('utf8'));
const TTLS={schedules:120000,festivals:900000,locale:900000};
function valid(name,d){
  if(name==='schedules')return Array.isArray(d?.data?.vsStages?.nodes);
  if(name==='festivals')return Array.isArray(d?.JP?.data?.festRecords?.nodes);
  return !!d?.stages&&!!d?.weapons;
}
function createDataCache({base=BASE,loadJson=getJson,now=Date.now}={}){
  const memory=new Map(),pending=new Map();let timer;
  function file(name){if(!Object.hasOwn(TTLS,name))throw Error('未知数据类型');return path.join(base,'cache','schedules',name+'.json');}
  function cached(name){
    const filename=file(name);let v=memory.get(name);
    if(!v)try{v=JSON.parse(fs.readFileSync(filename));if(valid(name,v.data))memory.set(name,v);else v=null;}catch{}
    return v;
  }
  function refresh(name){
    const filename=file(name);if(pending.has(name))return pending.get(name);
    const url=name==='locale'?'https://splatoon3.ink/data/locale/zh-CN.json':'https://splatoon3.ink/data/'+name+'.json';
    const request=(async()=>{
      const d=await loadJson(url);if(!valid(name,d))throw Error('数据源结构变化：'+name);
      const v={at:now(),data:d};atomic(filename,JSON.stringify(v));memory.set(name,v);return d;
    })().finally(()=>pending.delete(name));pending.set(name,request);return request;
  }
  async function data(name){const v=cached(name);if(v&&now()-v.at<TTLS[name])return v.data;return refresh(name);}
  function start(){
    if(timer)return;
    const warm=()=>{for(const name of Object.keys(TTLS)){const v=cached(name);if(!v||now()-v.at>=TTLS[name]-60000)refresh(name).catch(e=>console.error('Background data refresh',name,e.message));}};
    warm();timer=setInterval(warm,20000);timer.unref();
  }
  return {data,refresh,start};
}
const cache=createDataCache();
module.exports={BASE,atomic,fetchBuffer,getJson,data:cache.data,startDataRefresh:cache.start,createDataCache};
