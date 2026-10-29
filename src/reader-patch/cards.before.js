'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sharp=require('sharp');const {BASE,atomic,data,getJson}=require('./net');
const {eligible,RULES}=require('./catalog-build');const {ensure}=require('./sync-assets');
sharp.concurrency(1);sharp.cache({memory:16,files:10,items:30});
const ALLOWED=new Set(['地图','打工','祭典','随机武器','帮助']);
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
function randomMatch(c){
  const pool=c.weapons.filter(eligible);if(pool.length<8)throw Error('合法武器不足八把');
  const picks=pool.slice();for(let i=0;i<8;i++){const j=i+crypto.randomInt(picks.length-i);[picks[i],picks[j]]=[picks[j],picks[i]];}
  const maps=c.stages.filter(x=>Number.isInteger(x.numericId)&&x.numericId!==25);
  const mode=Object.keys(RULES)[crypto.randomInt(5)];
  return {kind:'random',title:'随机武器',teams:[picks.slice(0,4),picks.slice(4,8)],stage:maps[crypto.randomInt(maps.length)],rule:RULES[mode],ruleId:mode};
}
function festivalCandidates(raw){
  const out=[];function walk(x,region){if(!x||typeof x!=='object')return;if(typeof x.startTime==='string'&&typeof x.endTime==='string'&&Array.isArray(x.teams))out.push({...x,region});else for(const v of Object.values(x))walk(v,region);}
  for(const region of ['JP','AP','US','EU'])walk(raw?.[region],region);if(raw?.data)walk(raw.data,'JP');return out;
}
function selectFestival(raw,c,announcements,now=Date.now()){
  const active=festivalCandidates(raw).filter(f=>Date.parse(f.endTime)>now&&Date.parse(f.startTime)<Date.parse(f.endTime));
  const f=active.sort((a,b)=>(a.region==='JP'?-1:1)-(b.region==='JP'?-1:1)||Date.parse(a.startTime)-Date.parse(b.startTime))[0];
  if(f){const id=f.__splatoon3ink_id||f.id,z=c.locale.festivals[id];return {kind:'festival',id,title:z?.title||f.title,teams:f.teams.map((t,i)=>z?.teams?.[i]?.teamName||t.teamName),startTime:f.startTime,endTime:f.endTime,time:span(f),sourceLabel:'splatoon3.ink · '+f.region,verifiedAt:new Date(now).toISOString(),imageUrl:f.image?.url,note:'以游戏内公告为准'};}
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
  async function image(kind,item,x,y,w,h,cropPoster=false){
    if(!item?.id||!item?.url)throw Error('缺少准确素材 ID/URL');const e=await ensure(kind,item);
    let pipeline=sharp(path.join(BASE,e.file));
    if(cropPoster){const m=await pipeline.metadata();pipeline=pipeline.extract({left:0,top:Math.floor(m.height*0.21),width:m.width,height:Math.floor(m.height*0.62)});}
    overlays.push({input:await pipeline.resize(w,h,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer(),left:x,top:y});
  }
  async function finish(file){text(36,height-20,'北京时间 · 小鱿鱿 v3.3 · 数据 splatoon3.ink',21,'#91a2b7');svg.push('</svg>');
    const tmp=file+'.tmp-'+process.pid;await sharp(Buffer.from(svg.join(''))).composite(overlays).png().toFile(tmp);fs.renameSync(tmp,file);return file;}
  return {text,rect,image,finish};
}
async function render(model){
  const key=crypto.createHash('sha256').update('renderer-3|'+JSON.stringify(model)).digest('hex').slice(0,24);
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
const help=nick=>`小鱿鱿指令：\n${[...ALLOWED].map(c=>'@'+nick+' '+c).join('\n')}`;
async function respond(cmd,nick='小鱿鱿'){
  if(!ALLOWED.has(cmd))return null;if(cmd==='帮助')return {text:help(nick)};
  let model;
  try{
    const c=catalog();
    if(cmd==='随机武器')model=randomMatch(c);
    else if(cmd==='地图')model=modelMaps((await data('schedules')).data,c);
    else if(cmd==='打工')model=modelSalmon((await data('schedules')).data,c);
    else {
      let raw,failed=false;try{raw=await data('festivals');}catch{failed=true;}
      let current;try{current=(await data('schedules')).data.currentFest;}catch{}
      if(current)raw={...raw,data:{currentFest:current}};
      // Pull fresh localized festival titles for newly published records.
      if(raw&&festivalCandidates(raw).some(f=>Date.parse(f.endTime)>Date.now()))try{c.locale=await getJson('https://splatoon3.ink/data/locale/zh-CN.json');}catch{}
      model=selectFestival(raw,c,JSON.parse(fs.readFileSync(path.join(BASE,'festival-announcements.json'))));
      if(!model)return {text:`目前${failed?'接口不可用，':''}没有可确认的当前或未来祭典；这不代表官方没有新公告。\n查询：${fmt(new Date())}（北京时间）`};
      model.phase=Date.parse(model.startTime)>Date.now()?'即将开始':'进行中';
    }
    const text='（图片不可用，文字回退）\n'+fallback(model)+'\n北京时间';
    try{return {...await render(model),fallbackText:text};}catch(e){console.error('Card fallback',cmd,e.message);return {text};}
  }catch(e){console.error('Query failed',cmd,e.message);return {text:`${cmd}查询暂不可用，请稍后重试。未使用过期日程。`};}
}
module.exports={ALLOWED,fmt,pair,modelMaps,modelSalmon,randomMatch,festivalCandidates,selectFestival,render,fallback,respond,help};
