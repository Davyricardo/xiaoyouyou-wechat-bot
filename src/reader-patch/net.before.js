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
const memory=new Map();
async function data(name) {
  if(!['schedules','festivals'].includes(name))throw Error('未知数据类型');
  const ttl=name==='schedules'?120000:900000, at=Date.now();
  let v=memory.get(name);
  if(v&&at-v.at<ttl)return v.data;
  const file=path.join(BASE,'cache','schedules',name+'.json');
  if(!v)try{v=JSON.parse(fs.readFileSync(file));if(at-v.at<ttl){memory.set(name,v);return v.data;}}catch{}
  const d=await getJson('https://splatoon3.ink/data/'+name+'.json');
  if(name==='schedules'&&!Array.isArray(d?.data?.vsStages?.nodes))throw Error('地图日程结构变化');
  if(name==='festivals'&&!d.JP?.data?.festRecords?.nodes)throw Error('祭典日程结构变化');
  v={at,data:d};atomic(file,JSON.stringify(v));memory.set(name,v);return d;
}
module.exports={BASE,atomic,fetchBuffer,getJson,data};
