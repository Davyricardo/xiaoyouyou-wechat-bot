'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sharp=require('sharp');const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const execFileAsync=promisify(execFile);const {BASE,atomic,data,getJson}=require('./net');
const {eligible,RULES}=require('./catalog-build');const {ensure}=require('./sync-assets');
sharp.concurrency(1);sharp.cache({memory:16,files:10,items:30});
const BUILDS_ALIASES=['配装','装备','配卡'];
const ALLOWED=new Set(['地图','打工','祭典','随机武器','帮助',...BUILDS_ALIASES]);
const BUILDS_TIMEOUT_MS=20000;
function catalog(){return JSON.parse(fs.readFileSync(path.join(BASE,'assets/catalog.json')));}
const fmt=t=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(t));
const span=n=>`${fmt(n.startTime)} — ${fmt(n.endTime)}`;
function pair(nodes,now){
  const valid=(nodes||[]).filter(n=>Number.isFinite(Date.parse(n.startTime))&&Date.parse(n.startTime)<Date.parse(n.endTime)).sort((a,b)=>Date.parse(a.startTime)-Date.parse(b.startTime));
  return [{phase:'当前',node:valid.find(n=>Date.parse(n.startTime)<=now&&now<Date.parse(n.endTime))},
    {phase:'下一轮',node:valid.find(n=>Date.parse(n.startTime)>now)}];
}
function localized(c,kind,x){const id=x.id||x.__splatoon3ink_id;return String(c.locale[kind]?.[id]?.name||x.name||'数据未提供').replace(/[\x00-\x1f]/g,'');}
function modelMaps(d,c,now=Date.now()){
  const groups=[['regularSchedules','regularMatchSetting',null,'涂地比赛'],['bankaraSchedules','bankaraMatchSettings','CHALLENGE','蛮颓比赛·挑战'],['bankaraSchedules','bankaraMatchSettings','OPEN','蛮颓比赛·开放'],['xSchedules','xMatchSetting',null,'X 赛']];
  return {kind:'maps',title:'地图轮换',sections:groups.map(([key,field,mode,title])=>({title,rounds:pair(d[key]?.nodes,now).map(({phase,node:n})=>{
    const s=mode?n?.[field]?.find(x=>x.bankaraMode===mode):n?.[field];
    if(!s)return {phase,missing:true,text:'数据源未提供本轮（祭典期间可能暂停）'};
    return {phase,startTime:n.startTime,endTime:n.endTime,time:span(n),rule:RULES[s.vsRule.rule]||localized(c,'rules',s.vsRule),ruleId:s.vsRule.rule,
      stages:s.vsStages.map(x=>{const known=c.stages.find(z=>z.id===x.id);return {id:x.id,name:known?.name||localized(c,'stages',x),url:known?.url||x.image?.url};})};
  })}))};
}
function modelSalmon(d,c,now=Date.now()){
  const group=d.coopGroupingSchedule||{};const rounds=[];
  for(const [key,title] of [['regularSchedules','普通打工'],['bigRunSchedules','大型跑'],['teamContestSchedules','团队竞赛']]){
    if(key!=='regularSchedules'&&!(group[key]?.nodes||[]).some(n=>Date.parse(n.endTime)>now))continue;
    for(const {phase,node:n} of pair(group[key]?.nodes,now)){
      if(!n?.setting){if(key==='regularSchedules')rounds.push({phase,missing:true,text:'数据源未提供'+phase+'排班'});continue;}
      const s=n.setting;rounds.push({phase,title,time:span(n),startTime:n.startTime,endTime:n.endTime,
        stage:{id:s.coopStage.id,name:localized(c,'stages',s.coopStage),url:s.coopStage.image.url},
        weapons:(s.weapons||[]).map(x=>{const w=x.weapon||x;return {id:w.__splatoon3ink_id,name:localized(c,'weapons',w),url:w.image?.url};})});
    }
  }return {kind:'salmon',title:'鲑鱼跑排班',rounds};
}
let weaponMetaCache=null;
function weaponMeta(){
  if(weaponMetaCache)return weaponMetaCache;
  try{weaponMetaCache=JSON.parse(fs.readFileSync(path.join(BASE,'assets','weapon-meta.json'),'utf8'));}
  catch{weaponMetaCache={};}
  return weaponMetaCache;
}
// 射程三档（数据取自 WeaponInfoMain.Range 的三分位 13 / 17）
const RANGE_BUCKET=r=>r<13?'short':r<17?'mid':'long';
const RANGE_SLOTS=['short','short','mid','long'];

// 公平随机：两队同槽位同射程档（对称），8 把不重复、家族不重复、同队非 Shooter 类别不重复。
function randomMatch(c){
  const meta=weaponMeta();
  const pool=c.weapons.filter(eligible).map(w=>{
    const m=meta[w.id]||{};
    return {...w,range:typeof m.range==='number'?m.range:null,
      cls:m.cls||String(w.rowId||'').split('_')[0],
      family:m.family||String(w.rowId||'').replace(/_\d+$/,'')};
  }).filter(w=>w.range!==null&&w.family);
  if(pool.length<8)throw Error('合法武器不足八把');
  const buckets={short:[],mid:[],long:[]};
  for(const w of pool)buckets[RANGE_BUCKET(w.range)].push(w);

  const build=()=>{
    const used=new Set(),fams=new Set(),teams=[[],[]];
    for(const b of RANGE_SLOTS){
      const cands=buckets[b];let pair=null;
      for(let i=0;i<600&&!pair;i++){
        const a=cands[crypto.randomInt(cands.length)],d=cands[crypto.randomInt(cands.length)];
        if(!a||!d||a.id===d.id)continue;
        if(used.has(a.id)||used.has(d.id))continue;
        if(fams.has(a.family)||fams.has(d.family)||a.family===d.family)continue;
        if(a.cls!=='Shooter'&&teams[0].some(x=>x.cls===a.cls))continue;
        if(d.cls!=='Shooter'&&teams[1].some(x=>x.cls===d.cls))continue;
        pair=[a,d];
      }
      if(!pair){                    // 兜底：只保证 8 把互不相同
        for(let i=0;i<600&&!pair;i++){
          const a=cands[crypto.randomInt(cands.length)],d=cands[crypto.randomInt(cands.length)];
          if(a&&d&&a.id!==d.id&&!used.has(a.id)&&!used.has(d.id))pair=[a,d];
        }
      }
      if(!pair)return null;
      used.add(pair[0].id);used.add(pair[1].id);
      fams.add(pair[0].family);fams.add(pair[1].family);
      teams[0].push(pair[0]);teams[1].push(pair[1]);
    }
    return teams;
  };

  // 多试几次，挑两队射程总和最接近的一组
  let best=null,bestDiff=Infinity;
  for(let i=0;i<40;i++){
    const t=build();if(!t)continue;
    const diff=Math.abs(t[0].reduce((s,x)=>s+x.range,0)-t[1].reduce((s,x)=>s+x.range,0));
    if(diff<bestDiff){best=t;bestDiff=diff;}
    if(diff<=4)break;
  }
  if(!best)throw Error('无法生成公平组合');
  for(const team of best)for(let i=team.length-1;i>0;i--){const j=crypto.randomInt(i+1);[team[i],team[j]]=[team[j],team[i]];}
  const maps=c.stages.filter(x=>Number.isInteger(x.numericId)&&x.numericId!==25);
  const mode=Object.keys(RULES)[crypto.randomInt(5)];
  return {kind:'random',title:'随机武器',teams:best,stage:maps[crypto.randomInt(maps.length)],rule:RULES[mode],ruleId:mode,rangeDiff:bestDiff};
}
function festivalCandidates(raw){
  const out=[];function walk(x,region){if(!x||typeof x!=='object')return;if(typeof x.startTime==='string'&&typeof x.endTime==='string'&&Array.isArray(x.teams))out.push({...x,region});else for(const v of Object.values(x))walk(v,region);}
  for(const region of ['JP','AP','US','EU'])walk(raw?.[region],region);if(raw?.data)walk(raw.data,'JP');return out;
}
function selectFestival(raw,c,announcements,now=Date.now()){
  const active=festivalCandidates(raw).filter(f=>Date.parse(f.endTime)>now&&Date.parse(f.startTime)<Date.parse(f.endTime));
  const f=active.sort((a,b)=>(a.region==='JP'?-1:1)-(b.region==='JP'?-1:1)||Date.parse(a.startTime)-Date.parse(b.startTime))[0];
  if(f){const id=f.__splatoon3ink_id||f.id,z=c.locale.festivals[id];return {kind:'festival',id,title:z?.title||f.title,teams:f.teams.map((t,i)=>z?.teams?.[i]?.teamName||t.teamName),teamArt:f.teams.map((t,i)=>({name:z?.teams?.[i]?.teamName||t.teamName,color:t.color,url:t.image?.url})),startTime:f.startTime,endTime:f.endTime,time:span(f),sourceLabel:'splatoon3.ink · '+f.region,verifiedAt:new Date(now).toISOString(),imageUrl:f.image?.url,note:'以游戏内公告为准'};}
  const a=announcements.events.filter(f=>Date.parse(f.endTime)>now).sort((a,b)=>Date.parse(a.startTime)-Date.parse(b.startTime))[0];
  return a?{...a,kind:'festival',time:span(a)}:null;
}
const esc=x=>String(x??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function chunks(text,n){let lines=[],s='',width=0;for(const ch of String(text)){const unit=/[\x20-\x7e]/.test(ch)?0.55:1;if(width+unit>n&&s){lines.push(s);s='';width=0;}s+=ch;width+=unit;}if(s)lines.push(s);return lines;}
function canvas(height,title,subtitle){
  const svg=[`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}"><style>text{font-family:'Noto Sans CJK SC',sans-serif}</style><rect width="1080" height="${height}" fill="#101825"/>`];
  const overlays=[];
  const text=(x,y,value,size=28,color='#edf4ff',anchor='start')=>svg.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${esc(value)}</text>`);
  const rect=(x,y,w,h,fill='#213044')=>svg.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${fill}"/>`);
  text(36,55,'小鱿鱿 · '+title,38);text(36,94,subtitle,23,'#9aacbf');
  // 单个素材缺失/下载失败只画占位块，不拖垮整张图
  async function image(kind,item,x,y,w,h,cropPoster=false){
    try{
      if(!item?.id||!item?.url)throw Error('缺少准确素材 ID/URL');const e=await ensure(kind,item);
      let pipeline=sharp(path.join(BASE,e.file));
      if(cropPoster){const m=await pipeline.metadata();pipeline=pipeline.extract({left:0,top:Math.floor(m.height*0.21),width:m.width,height:Math.floor(m.height*0.62)});}
      overlays.push({input:await pipeline.resize(w,h,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(),left:x,top:y});
    }catch(e){console.error('asset placeholder',kind,item?.id||'',e.message);
      overlays.push({input:Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="18" fill="#1b2534" stroke="#2b3a50" stroke-width="2"/></svg>`),left:x,top:y});
    }
  }
  async function finish(file){text(36,height-20,'北京时间 · 小鱿鱿 v3.3 · 数据 splatoon3.ink',21,'#91a2b7');svg.push('</svg>');
    const tmp=file+'.tmp-'+process.pid;await sharp(Buffer.from(svg.join(''))).composite(overlays).png({palette:true,colours:128,dither:0.3,effort:4,compressionLevel:6}).toFile(tmp);fs.renameSync(tmp,file);return file;}
  return {text,rect,image,finish};
}
// 换班瞬间缓存可能还没刷新（定时器 5 分钟一轮）：就地补跑一次渲染，别退回旧版式。
// 异步 + 可配置超时（默认 60 秒，XYY_CARD_REFRESH_TIMEOUT_MS 可调）：execFileSync 会把
// 事件循环整段堵住，期间轮询停摆、SIGTERM 也收不到处理，表现就是「发图前卡一分钟」。
// 失败返回 false，由调用方决定降级还是拒绝。
async function refreshCard(script,timeoutMs=Number(process.env.XYY_CARD_REFRESH_TIMEOUT_MS)||60000){
  try{
    await execFileAsync(process.execPath,[path.join(BASE,script)],{
      cwd:BASE,env:{...process.env,HOME:BASE},timeout:timeoutMs,stdio:'ignore'});
    return true;
  }catch(e){console.error('card refresh failed',script,e.message);return false;}
}
// 预生成排班图的取用策略：命中且没过期就直接发；过期了就地补渲染一次。
// 补渲染后仍然过期（或压根没补成功）时抛 E_STALE_CARD —— 宁可回复「暂不可用」，
// 也绝不把上一轮的老班次发出去（坑 14 / 坑 20：这条策略是有测试守着的）。
// 从来没有缓存图时返回 null，交给下面的现渲染路径。
const STALE_CARD=script=>Object.assign(Error(script+' 预渲染图已过期且补渲染失败'),{code:'E_STALE_CARD'});
async function usePrerendered(read,script,refresh=refreshCard){
  const c=read();
  if(c&&c.valid)return {image:c.path,cached:true};
  if(await refresh(script)){
    const n=read();
    if(n&&n.valid)return {image:n.path,cached:true};
    if(n)throw STALE_CARD(script);
  }else if(c)throw STALE_CARD(script);
  return null;
}
// 打工排班图是 40h 一轮、由 salmon-schedule.timer 预生成的；命中就直接发缓存图，不再现合成。
// 对战排班同样是预生成的：两块（4 小时）一轮，命中缓存就直接发图。
function battleCardPath(){
  try{
    const dir=path.join(BASE,'cache','battle-schedule');
    const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8'));
    const png=path.join(dir,'current.png');
    if(!fs.existsSync(png)||fs.statSync(png).size<10000)return null;
    const blocks=meta.blocks||[];
    if(!blocks.length)return null;
    // valid=false 表示这张图已经过期（第一块结束）；调用方会先尝试补渲染，失败才降级使用
    return {path:png,valid:Date.parse(blocks[0].endISO||0)>Date.now()};
  }catch{return null;}
}
function salmonCardPath(){
  try{
    const dir=path.join(BASE,'cache','salmon-schedule');
    const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8'));
    const png=path.join(dir,'current.png');
    if(!fs.existsSync(png)||fs.statSync(png).size<10000)return null;
    // 40 小时一轮：第一段还在跑就是「当前排班」；过期时 valid=false，由调用方决定补渲染还是降级
    const rows=meta.rows||[];
    if(!rows.length)return null;
    return {path:png,valid:Date.parse(rows[0].endISO||0)>Date.now()};
  }catch{return null;}
}
async function render(model){
  if(model.kind==='salmon'){const hit=await usePrerendered(salmonCardPath,'salmon-schedule.js');if(hit)return hit;}
  if(model.kind==='random'){
    const ids=[...model.teams[0],...model.teams[1]].map(w=>w.id);
    if(ids.length===8){
      try{
        // 进程内渲染：省掉 node+sharp 启动的 ~530ms
        const info=await require('./weapon-card').renderCard(ids);
        if(info&&info.file&&fs.existsSync(info.file))return {image:info.file,cached:false};
      }catch(e){console.error('weapon card failed',e.message);}
    }
  }
  if(model.kind==='maps'){const hit=await usePrerendered(battleCardPath,'battle-schedule.js');if(hit)return hit;}
  const key=crypto.createHash('sha256').update('renderer-5-teamcols|'+JSON.stringify(model)).digest('hex').slice(0,24);
  const dir=path.join(BASE,'cache/cards');fs.mkdirSync(dir,{recursive:true});
  // Bound only this module's generated PNGs. No recursive cleanup or shared paths.
  const own=fs.readdirSync(dir).filter(n=>/^(maps|salmon|random|festival)-[a-f0-9]+\.png$/.test(n)).map(n=>({n,at:fs.statSync(path.join(dir,n)).mtimeMs})).sort((a,b)=>b.at-a.at);
  for(let i=0;i<own.length;i++)if(i>=96||Date.now()-own[i].at>48*3600000)fs.unlinkSync(path.join(dir,own[i].n));
  const file=path.join(dir,(model.kind==='random'?'random-'+crypto.randomBytes(5).toString('hex'):model.kind+'-'+key)+'.png');
  if(model.kind!=='random'&&fs.existsSync(file)){try{await sharp(file).metadata();return {image:file,cached:true};}catch{}}
  let cv;
  if(model.kind==='maps'){
    cv=canvas(1590,model.title,'四类比赛 · 当前 / 下一轮');
    for(let i=0;i<model.sections.length;i++){
      const section=model.sections[i],y=120+i*350;cv.text(36,y+32,section.title,30,'#fdcf64');
      for(let j=0;j<2;j++){
        const r=section.rounds[j],x=32+j*520;cv.rect(x,y+48,504,288);
        cv.text(x+18,y+83,r.phase+' · '+(r.rule||'暂无数据'),26,'#89e2d2');
        if(r.missing){chunks(r.text,17).forEach((s,k)=>cv.text(x+20,y+140+k*32,s,23));continue;}
        cv.text(x+18,y+116,r.time,22,'#b7c9dd');
        for(let k=0;k<r.stages.length;k++){
          const sx=x+18+k*238;await cv.image('maps',r.stages[k],sx,y+132,230,130);
          chunks(r.stages[k].name,10).forEach((s,n)=>cv.text(sx+115,y+289+n*27,s,23,'#edf4ff','middle'));
        }
      }
    }
  }else if(model.kind==='salmon'){
    cv=canvas(156+model.rounds.length*380,model.title,'场地与武器 · 当前 / 下一轮');
    for(let i=0;i<model.rounds.length;i++){
      const r=model.rounds[i],y=120+i*380;cv.rect(32,y,1016,364);
      if(r.missing){cv.text(52,y+60,r.text);continue;}
      cv.text(52,y+44,r.title+' · '+r.phase,30,'#fdcf64');cv.text(52,y+80,r.time,24,'#b7c9dd');
      await cv.image('salmon',r.stage,52,y+102,260,156);chunks(r.stage.name,11).forEach((s,n)=>cv.text(182,y+294+n*28,s,25,'#edf4ff','middle'));
      if(r.weapons.length!==4)throw Error('打工武器数量异常');
      for(let j=0;j<4;j++){const x=340+j*172;await cv.image('salmon-weapons',r.weapons[j],x,y+112,158,134);chunks(r.weapons[j].name,6).forEach((s,n)=>cv.text(x+79,y+280+n*27,s,23,'#edf4ff','middle'));}
    }
  }else if(model.kind==='random'){
    cv=canvas(1080,model.title,'两队各四把 · 八把不重复');cv.rect(32,118,1016,226);
    await cv.image('maps',model.stage,52,136,280,157);cv.text(366,180,model.rule,32,'#fdcf64');cv.text(366,230,model.stage.name,32);cv.text(366,286,'私人比赛 · '+catalog().weapons.length+' 把普通武器池',24,'#b7c9dd');
    for(let team=0;team<2;team++){const y=364+team*332;cv.rect(32,y,1016,310);cv.text(52,y+45,team?'B 队':'A 队',32,team?'#ffb36c':'#86c5ff');
      for(let j=0;j<4;j++){const x=52+j*249,w=model.teams[team][j];await cv.image('weapons',w,x+18,y+64,210,156);chunks(w.name,10).forEach((s,n)=>cv.text(x+115,y+253+n*27,s,25,'#edf4ff','middle'));}}
  }else if(model.kind==='festival'){
    // 三列阵营版式（对齐官方海报）：阵营色块 + 立绘 + 队名 + 时间。
    // 立绘来自香橙派预取的 assets/festivals/teams/，三张都在才用；缺任何一张就退回下面
    // 「贴整张海报」的老版式 —— 宁可版式旧一点，也不要发出写着「立绘缺失」的破图。
    {
      const poster=require('./fest-poster');
      const art=model.teamArt||[];
      if(art.length>=2&&poster.ready({teams:art})){
        return {image:await poster.renderPoster({title:model.title,start:model.startTime,end:model.endTime,teams:art},file),cached:false};
      }
    }
    cv=canvas(920,'祭典 · '+(model.phase||'即将开始'),'有来源的活动公告');
    const official=model.id==='splatoween-2026-official';
    await cv.image('festivals',{id:model.id,name:model.title,url:model.imageUrl},32,126,1016,390,official);
    chunks(model.title,28).forEach((s,n)=>cv.text(36,563+n*40,s,34,'#fdcf64'));
    cv.text(36,644,model.teams.join('  /  '),32,'#89e2d2');cv.text(36,691,model.time,29);
    cv.text(36,735,model.sourceLabel,23,'#b7c9dd');cv.text(36,772,'核验：'+fmt(model.verifiedAt),23,'#b7c9dd');
    chunks(model.note||'以游戏内公告为准',42).forEach((s,n)=>cv.text(36,815+n*30,s,23,'#b7c9dd'));
  }else throw Error('未知图卡类型');
  return {image:await cv.finish(file),cached:false};
}
function fallback(model){
  if(model.kind==='maps')return model.sections.map(s=>s.title+'\n'+s.rounds.map(r=>r.missing?r.phase+'：暂无数据':`${r.phase} ${r.time}\n${r.rule}｜${r.stages.map(x=>x.name).join(' / ')}`).join('\n')).join('\n\n');
  if(model.kind==='salmon')return model.rounds.map(r=>r.missing?r.text:`${r.title}·${r.phase} ${r.time}\n${r.stage.name}\n${r.weapons.map(w=>w.name).join('、')}`).join('\n\n');
  if(model.kind==='random')return `${model.rule}｜${model.stage.name}\nA 队：${model.teams[0].map(w=>w.name).join('、')}\nB 队：${model.teams[1].map(w=>w.name).join('、')}`;
  return `${model.title}\n${model.teams.join(' / ')}\n${model.time}\n${model.sourceLabel}\n核验：${fmt(model.verifiedAt)}\n${model.note||''}`;
}
// 用法提示里的示例：取 catalog 里真实存在的中文名（优先这几把常见武器）
const SAMPLE_WEAPONS=['斯普拉射击枪','新叶射击枪','.52加仑','碳纤维滚筒'];
function buildsUsage(nick='小鱿鱿'){
  let names=[];
  try{
    const all=catalog().weapons.map(w=>w.name);
    names=SAMPLE_WEAPONS.filter(n=>all.includes(n)).slice(0,3);
    if(names.length<3)names=[...new Set([...names,...all])].slice(0,3);
  }catch{}
  if(!names.length)names=SAMPLE_WEAPONS.slice(0,3);
  return '用法：@'+nick+' 配装 <武器名>\n例如：\n'+names.map(n=>'@'+nick+' 配装 '+n).join('\n');
}
// 渲染超时按失败处理，避免一条消息把整批轮询卡住。
// onTimeout 先执行（调用方用它置取消标志），再 reject；被丢弃的 promise 也必须挂 catch，
// 否则它之后失败会变成 unhandledRejection。
function withTimeout(promise,ms,onTimeout){
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{try{onTimeout&&onTimeout();}finally{reject(Object.assign(Error('渲染超时'),{code:'E_TIMEOUT'}));}},ms);});
  return Promise.race([promise,timeout]).finally(()=>{clearTimeout(timer);promise.catch(()=>{});});
}
const BUILDS_SOURCE_DOWN=new Set(['E_HTTP','E_PARSE','E_EMPTY','E_SHAPE']);
async function buildsReply(arg,nick='小鱿鱿'){
  if(!arg)return {text:buildsUsage(nick)};
  let r;
  // 超时后置 abort：渲染器在下一步之间退出，不再占下载并发/内存，也不写半成品图
  const controller=new AbortController();
  try{
    r=await withTimeout(require('./builds-card').renderBuildsCard(arg,{signal:controller.signal}),BUILDS_TIMEOUT_MS,
      ()=>controller.abort());
  }catch(e){
    if(e&&e.code==='E_UNKNOWN')return {text:'没找到武器：'+arg+'，试试完整中文名或英文名'};
    if(e&&e.code==='E_TIMEOUT')return {text:'配装生成超时，请稍后再试'};
    if(e&&BUILDS_SOURCE_DOWN.has(e.code))return {text:'配装数据源暂时不可用（sendou.ink），稍后再试'};
    // 本地故障（写盘、素材、sharp）：不把内部错误文本发到群里
    console.error('Builds card failed',arg,e&&e.code||'',e&&e.message||e);
    return {text:'配装生成失败，请稍后再试'};
  }
  return {image:r.file,fallbackText:'配装图生成失败，可到 sendou.ink 查看'};
}
const HELP_ALIASES=new Set(['装备','配卡']);
const help=nick=>`小鱿鱿指令：\n${[...ALLOWED].filter(c=>!HELP_ALIASES.has(c)).map(c=>'@'+nick+' '+(c==='配装'?c+' <武器名>':c)).join('\n')}`;
async function respond(cmd,nick='小鱿鱿'){
  const m=/^(\S+)(?:\s+([\s\S]*))?$/.exec(String(cmd??'').trim());
  if(!m||!ALLOWED.has(m[1]))return null;
  const head=m[1],arg=(m[2]||'').trim();
  if(BUILDS_ALIASES.includes(head))return buildsReply(arg,nick);
  if(arg)return null;                            // 其余指令不接受参数（保持旧行为）
  if(head==='帮助')return {text:help(nick)};
  let model;
  try{
    const c=catalog();
    if(head==='随机武器')model=randomMatch(c);
    else if(head==='地图')model=modelMaps((await data('schedules')).data,c);
    else if(head==='打工')model=modelSalmon((await data('schedules')).data,c);
    else {
      let raw,failed=false;try{raw=await data('festivals');}catch{failed=true;}
      let current;try{current=(await data('schedules')).data.currentFest;}catch{}
      if(current)raw={...raw,data:{currentFest:current}};
      // Pull fresh localized festival titles for newly published records.
      if(raw&&festivalCandidates(raw).some(f=>Date.parse(f.endTime)>Date.now()))try{c.locale=await data('locale');}catch{}
      model=selectFestival(raw,c,JSON.parse(fs.readFileSync(path.join(BASE,'festival-announcements.json'))));
      if(!model)return {text:`目前${failed?'接口不可用，':''}没有可确认的当前或未来祭典；这不代表官方没有新公告。\n查询：${fmt(new Date())}（北京时间）`};
      model.phase=Date.parse(model.startTime)>Date.now()?'即将开始':'进行中';
    }
    const text='（图片不可用，文字回退）\n'+fallback(model)+'\n北京时间';
    try{return {...await render(model),fallbackText:text};}catch(e){
      // 预渲染图过期且补不回来：明确回「暂不可用」，不发旧图（坑 14 / 20）
      if(e&&e.code==='E_STALE_CARD')return {text:`${cmd}查询暂不可用，请稍后重试。未使用过期日程。`};
      console.error('Card fallback',cmd,e.message);return {text};}
  }catch(e){console.error('Query failed',cmd,e.message);return {text:`${cmd}查询暂不可用，请稍后重试。未使用过期日程。`};}
}
module.exports={ALLOWED,BUILDS_ALIASES,fmt,pair,modelMaps,modelSalmon,randomMatch,festivalCandidates,selectFestival,render,fallback,respond,help,buildsUsage,refreshCard,usePrerendered};
