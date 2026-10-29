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
// schedules 的 TTL 必须 ≥ 同步间隔：数据由香橙派每 30 分钟推到阿里云，
// 阿里云自己连不上官方源。TTL 设 2 分钟时，缓存只有 2/30 的时间算「新鲜」，
// 其余时间每次查询都会去连不通的网络并失败——这正是「未使用过期日程」的来源。
// ⚠ 35 分钟只剩 5 分钟余量：香橙派只要漏掉一轮（或 cron 挤过一次），缓存就会在
// 「过期」状态下待上 30 分钟，期间每 20 秒打一次 25 秒超时的请求（线上 23:00–23:45
// 就是这么刷的）。改成 60 分钟 = 容忍漏掉一整轮；数据本身 2 小时才换班，
// 兜底校验仍在——真过期（>60 分钟）时会报错而不是张冠李戴。
const TTLS={schedules:60*60*1000,festivals:6*60*60*1000,locale:6*60*60*1000};
function valid(name,d){
  if(name==='schedules')return Array.isArray(d?.data?.vsStages?.nodes);
  if(name==='festivals')return ['JP','AP','US','EU'].some(region=>Array.isArray(d?.[region]?.data?.festRecords?.nodes));
  return !!d?.stages&&!!d?.weapons;
}
function createDataCache({base=BASE,loadJson=getJson,now=Date.now}={}){
  const memory=new Map(),pending=new Map();let timer;
  let festivalFailures=0,festivalRetryAt=0;
  // 阿里云直连 splatoon3.ink 永远超时（实测每次 25 秒），线上数据其实由香橙派每 30 分钟推送。
  // XYY_REMOTE_REFRESH=0 时彻底关掉远程拉取和后台预热：不再有必然失败的请求、不再挂
  // 一个永不完成的 https socket、journal 也不会被同一行超时日志刷满。
  // 过期缓存的策略不变——宁可报「暂不可用」，也不给用户看错的班次。
  const remoteEnabled=process.env.XYY_REMOTE_REFRESH!=='0';
  function file(name){if(!Object.hasOwn(TTLS,name))throw Error('未知数据类型');return path.join(base,'cache','schedules',name+'.json');}
  // ⚠ 缓存必须跟着文件走。旧实现第一次读盘后就把内容记进 memory 永不失效，
  // 香橙派每 30 分钟推一次新文件，桥接却一直用「进程启动时那份」：
  // 过了 TTL 之后，每个查询都会去连阿里云根本连不上的 splatoon3.ink，然后回
  // 「地图查询暂不可用」。2026-10-24 00:21 启动的进程、00:30 换了班次，
  // 到 00:32 仍然读着 23:30 的旧缓存 —— 这就是那条报错的来源。
  // 现在用 mtime 做缓存键：文件一变就重读，没变就复用，成本只有一次 stat。
  function cached(name){
    const filename=file(name);let st;
    try{st=fs.statSync(filename);}catch(e){return null;}
    const hit=memory.get(name);
    if(hit&&hit.mtimeMs===st.mtimeMs)return hit.value;
    try{
      let v=JSON.parse(fs.readFileSync(filename));
      // 兼容没有 {at,data} 包装的裸 payload：香橙派的 sync.sh 曾经只给 schedules 加包装，
      // festivals.json / locale.json 是原样落地。这时 v.at 是 undefined，
      // 判过期得到 NaN（永远「不过期」），但 valid(name, v.data) 拿到 undefined 一定失败，
      // 于是每一轮都认为「没缓存」→ 去连阿里云连不上的 splatoon3.ink → 每 20 秒一次 25 秒超时。
      // 用文件 mtime 兜底当 at，至少让它能被当成有效缓存。
      if(!Number.isFinite(v.at))v={at:st.mtimeMs,data:v};
      if(!valid(name,v.data))return null;
      memory.set(name,{mtimeMs:st.mtimeMs,value:v});
      return v;
    }catch{return null;}
  }
  function refresh(name){
    const filename=file(name);if(pending.has(name))return pending.get(name);
    if(!remoteEnabled)return Promise.reject(Error('远程刷新已关闭（XYY_REMOTE_REFRESH=0），只读本地缓存'));
    const url=name==='locale'?'https://splatoon3.ink/data/locale/zh-CN.json':'https://splatoon3.ink/data/'+name+'.json';
    const request=(async()=>{
      const d=await loadJson(url);if(!valid(name,d))throw Error('数据源结构变化：'+name);
      const v={at:now(),data:d};atomic(filename,JSON.stringify(v));
      // 自己写下去的文件也要进缓存（带 mtime），否则下一次 cached() 会多读一遍盘
      let st=null;try{st=fs.statSync(filename);}catch{}
      memory.set(name,{mtimeMs:st?st.mtimeMs:null,value:v});
      if(name==='festivals'){festivalFailures=0;festivalRetryAt=0;}
      return d;
    })().catch(e=>{
      if(name==='festivals'){
        festivalFailures=Math.min(festivalFailures+1,5);
        festivalRetryAt=now()+Math.min(60000*2**(festivalFailures-1),TTLS.festivals);
      }
      throw e;
    }).finally(()=>pending.delete(name));pending.set(name,request);return request;
  }
  // 过期就是过期：宁可报「暂不可用」也不给用户看错的班次（这条策略有测试守着）。
  // 但把「拒绝时缓存已经多老」写进日志 —— 今天排查就卡在这里：分不清是
  // 「香橙派没推」还是「阿里云连不上」。TTL 60 分钟 > 同步间隔 30 分钟，
  // 只有漏掉一整轮推送才会走到这里。
  async function data(name){
    const v=cached(name);
    if(v&&now()-v.at<TTLS[name])return v.data;
    try{return await refresh(name);}
    catch(e){
      if(v)console.error('数据源不可用，拒绝使用 '+Math.round((now()-v.at)/60000)+' 分钟前的缓存：'+name);
      throw e;
    }
  }
  // 后台预热失败要退避。v3.4 的写法是每 20 秒无条件重试一次，而阿里云直连
  // splatoon3.ink 永远超时（每次 25 秒），于是：① 每分钟打 3 次必然失败的请求；
  // ② 永远有一个 https socket 挂着 —— 进程收到 SIGTERM 后事件循环不空，只能等
  // systemd 60 秒 SIGKILL；③ journal 被同一行日志刷满掩盖真实故障。
  // 现在按 1/2/4/8/16/30 分钟退避，成功后清零。
  let warmFailures=0,warmPausedUntil=0;
  function start(){
    if(timer)return;
    if(!remoteEnabled){
      console.error('Data refresh: 远程拉取已关闭（XYY_REMOTE_REFRESH=0），只读香橙派推送的缓存');
      return;
    }
    const warm=()=>{
      if(now()<warmPausedUntil)return;
      for(const name of Object.keys(TTLS)){
        if(now()<warmPausedUntil)break;      // 上一路刚失败，本轮就此打住
        if(name==='festivals'&&now()<festivalRetryAt)continue;
        const v=cached(name);if(!v||now()-v.at>=TTLS[name]-60000){
          refresh(name).then(()=>{warmFailures=0;warmPausedUntil=0;}).catch(e=>{
            // 同一轮并发失败只算一次，否则三路一起挂会把退避推快三倍
            if(now()<warmPausedUntil)return;
            warmFailures=Math.min(warmFailures+1,6);
            warmPausedUntil=now()+Math.min(30*60*1000,60000*Math.pow(2,warmFailures-1));
            console.error('Background data refresh',name,e.message,
              '(连续失败 '+warmFailures+' 次，暂停 '+Math.round((warmPausedUntil-now())/1000)+'s)');
          });
        }
      }
    };
    warm();timer=setInterval(warm,20000);timer.unref();
  }
  function stop(){if(timer){clearInterval(timer);timer=null;}}
  return {data,refresh,start,stop};
}
const cache=createDataCache();
module.exports={BASE,TTLS,atomic,fetchBuffer,getJson,data:cache.data,startDataRefresh:cache.start,
  stopDataRefresh:cache.stop,createDataCache};
