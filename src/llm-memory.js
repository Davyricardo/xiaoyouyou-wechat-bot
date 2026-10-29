'use strict';
// 小鱿鱿的群友记忆（v2：分类档案）。
//   短期：每人最近 3 轮闲聊，10 分钟不聊清空，只在内存里，重启就没了。
//   长期：每人一个 JSON 小档案（按微信 ID 的哈希命名，不按昵称），不存聊天原文。
//     按类存：喷喷 / 任天堂 / 音乐 / 数码 / 电影 / 互动，每类最多 3 条；另有「里程碑」（祝贺一次就不再提）。
//     60 天没再提到的条目自动淘汰。
//   群记忆：群里的梗和约好的活动，所有人共享，最多 6 条，14 天过期；绝不记个人信息。
// 记忆只用于闲聊语气和推荐，永远不参与权限判断。
const fs=require('fs'),path=require('path'),crypto=require('crypto');

const DAY=24*3600*1000;
const LIMITS={shortTurns:3,shortTtlMs:10*60*1000,perCat:3,factChars:30,pending:10,summarizeEvery:5,
  expireMs:60*DAY,milestones:3,milestoneTtlMs:30*DAY,group:6,groupTtlMs:14*DAY};
const CATS=['splat','nintendo','music','gear','movie','social'];
const LABEL={splat:'喷喷',nintendo:'任天堂',music:'音乐',gear:'数码',movie:'电影',social:'互动'};
const CAT_OF={'喷喷':'splat','斯普拉遁':'splat','打工':'splat','任天堂':'nintendo','游戏':'nintendo','音乐':'music','歌':'music',
  '数码':'gear','设备':'gear','装机':'gear','电影':'movie','影视':'movie','称呼':'social','互动':'social'};
// 这些内容不进长期记忆：身份/权限声明、隐私信息。
const DENY=/(管理员|管理|admin|权限|主人|开发者|作者|群主|密码|口令|key|token|密钥|手机|电话|微信号|地址|住在|身份证|学校|公司|单位|真名|真实姓名|银行卡|QQ号|生日|年龄|岁)/i;

function fileOf(dir,user){return path.join(dir,crypto.createHash('sha256').update(String(user)).digest('hex').slice(0,24)+'.json');}

function cleanFact(f){
  let s=String(f||'').replace(/[\r\n\t]+/g,' ').replace(/[@＠]\S*/g,'').replace(/https?:\/\/\S+/gi,'').replace(/[`*#]/g,'').trim();
  s=s.replace(/^[-•\d.、\s]+/,'').trim();
  if(!s||DENY.test(s))return null;
  const c=[...s];return c.length>LIMITS.factChars?c.slice(0,LIMITS.factChars).join(''):s;
}

// 「记住我…」时按关键词归类。
function classify(t){
  const s=String(t||'');
  if(/(歌|音乐|专辑|乐队|歌手|摇滚|说唱|嘻哈|流行|电子|R&B|爵士|古典|Taylor|Swift|Coldplay|Queen|Beatles)/i.test(s))return 'music';
  if(/(电影|影片|导演|演员|科幻片|动画片|恐怖片|喜剧片|诺兰|漫威|皮克斯|宫崎骏|美剧)/.test(s))return 'movie';
  if(/(手柄|Switch ?2|switch ?2|OLED|显卡|CPU|电脑|笔记本|游戏本|耳机|预算|配件|显示器|键盘|鼠标|PS5|Xbox|Steam ?Deck)/i.test(s))return 'gear';
  if(/(滚筒|射击枪|刷|狙|加仑|泼桶|双枪|伞|雨刷|弓|尖枪|蛤蜊|塔楼|鱼虎|区域|涂地|打工|鲑鱼|段位|S\+|X ?段|X ?赛|武器|斯普拉遁|喷喷|祭典|大型跑)/.test(s))return 'splat';
  if(/(塞尔达|马力欧|马里奥|宝可梦|卡比|动森|火纹|火焰纹章|异度|大乱斗|马车|银河战士|大金刚|皮克敏|星际火狐|任天堂|通关|在玩|想买)/.test(s))return 'nintendo';
  return 'social';
}

function emptyProfile(t){const p={v:2,first:t,count:0,pending:[],milestones:[],slots:{}};for(const c of CATS)p.slots[c]=[];return p;}
function migrate(j,t){
  if(j&&j.v===2){for(const c of CATS)if(!Array.isArray(j.slots&&j.slots[c]))(j.slots=j.slots||{})[c]=[];j.milestones=j.milestones||[];return j;}
  if(j&&j.v===1){
    const p=emptyProfile(j.first||t);Object.assign(p,{nick:j.nick||'',last:j.last,count:j.count||0,pending:j.pending||[]});
    for(const f of j.facts||[]){const c=classify(f);if(p.slots[c].length<LIMITS.perCat)p.slots[c].push({t:f,at:j.summarizedAt||j.last||t});}
    return p;
  }
  return null;
}

function createMemory(opts={}){
  const dir=opts.dir;const now=opts.now||(()=>Date.now());const fsMod=opts.fs||fs;
  const blocked=opts.blocked||/$^/;
  const short=new Map();
  const groupFile=()=>path.join(dir,'_group.json');

  function writeJson(f,obj){
    fsMod.mkdirSync(dir,{recursive:true,mode:0o700});
    const tmp=f+'.'+process.pid+'.tmp';fsMod.writeFileSync(tmp,JSON.stringify(obj),{mode:0o600});fsMod.renameSync(tmp,f);
  }
  function load(user){
    let j;try{j=JSON.parse(fsMod.readFileSync(fileOf(dir,user),'utf8'));}catch{return null;}
    const p=migrate(j,now());if(!p)return null;
    const t=now();
    for(const c of CATS)p.slots[c]=p.slots[c].filter(x=>x&&x.t&&t-(x.at||0)<=LIMITS.expireMs);
    p.milestones=p.milestones.filter(x=>x&&x.t&&t-(x.at||0)<=LIMITS.milestoneTtlMs);
    return p;
  }
  function save(user,p){writeJson(fileOf(dir,user),p);}
  function recent(user){
    const s=short.get(user);if(!s)return [];
    if(now()-s.at>LIMITS.shortTtlMs){short.delete(user);return [];}
    return s.turns.slice(-LIMITS.shortTurns);
  }
  function profile(user){return load(user);}
  // 给提示词用：每类一行「喷喷：主玩滚筒、怕鲑鱼」。
  function facts(user){
    const p=load(user);if(!p)return [];
    return CATS.filter(c=>p.slots[c].length).map(c=>LABEL[c]+'：'+p.slots[c].map(x=>x.t).join('、'));
  }
  function slot(user,cat){const p=load(user);return p?p.slots[cat].map(x=>x.t):[];}
  function pendingMilestones(user){const p=load(user);return p?p.milestones.filter(x=>!x.told).map(x=>x.t):[];}
  function markTold(user){
    const p=load(user);if(!p||!p.milestones.some(x=>!x.told))return;
    for(const x of p.milestones)x.told=true;try{save(user,p);}catch{}
  }

  // 记一轮对话。返回是否该做一次总结。
  function record(user,nick,said,answered){
    if(!user)return false;
    const t=now();
    const s=short.get(user)&&t-short.get(user).at<=LIMITS.shortTtlMs?short.get(user):{turns:[],at:t};
    s.turns.push({u:said,a:answered});s.turns=s.turns.slice(-LIMITS.shortTurns);s.at=t;short.set(user,s);
    if(short.size>500){for(const [k,v] of short)if(t-v.at>LIMITS.shortTtlMs)short.delete(k);}
    const p=load(user)||emptyProfile(t);
    p.nick=nick||p.nick||'';p.last=t;p.count=(p.count||0)+1;
    p.pending=[...(p.pending||[]),String(said).slice(0,100)].slice(-LIMITS.pending);
    try{save(user,p);}catch{return false;}
    return p.pending.length>=LIMITS.summarizeEvery;
  }

  // 「记住我主玩风暴刷」：立刻写入。返回 {ok,cat,text} 或 {ok:false,reason}。
  function remember(user,nick,text){
    if(!user)return {ok:false,reason:'nouser'};
    let s=String(text||'').trim().replace(/^我(?:是|的)?/,'').trim();
    const f=cleanFact(s);
    if(!f||blocked.test(f))return {ok:false,reason:'deny'};
    const t=now();const p=load(user)||emptyProfile(t);p.nick=nick||p.nick||'';p.last=t;
    const cat=classify(f);
    const list=p.slots[cat].filter(x=>x.t!==f);list.unshift({t:f,at:t});p.slots[cat]=list.slice(0,LIMITS.perCat);
    try{save(user,p);}catch{return {ok:false,reason:'io'};}
    return {ok:true,cat,label:LABEL[cat],text:f};
  }

  // 总结：summarize(旧档案, 新发言[]) => {splat:[],nintendo:[],music:[],gear:[],social:[],milestones:[],group:[]}
  // 条目以「+」开头表示这批话里新提到或再次确认（刷新 60 天计时）。失败就留着 pending 下次再试。
  const inflight=new Set();
  async function consolidate(user,summarize){
    if(!user||inflight.has(user))return false;
    inflight.add(user);
    try{
      const p=load(user);if(!p||!p.pending||!p.pending.length)return false;
      const taken=p.pending.slice();
      const old={};for(const c of CATS)old[LABEL[c]]=p.slots[c].map(x=>x.t);
      const out=await summarize(old,taken)||{};
      const q=load(user);if(!q)return false;            // 期间被「忘记我」删掉了
      const t=now();
      const parse=v=>(Array.isArray(v)?v:[]).map(x=>{const raw=String(x||'').trim();const fresh=raw.startsWith('+');const f=cleanFact(raw.replace(/^\+\s*/,''));return f&&!blocked.test(f)?{f,fresh}:null;}).filter(Boolean);
      for(const c of CATS){
        if(!(c in out))continue;
        const prev=new Map(q.slots[c].map(x=>[x.t,x.at]));const seen=new Set();const next=[];
        for(const {f,fresh} of parse(out[c])){if(seen.has(f))continue;seen.add(f);next.push({t:f,at:fresh||!prev.has(f)?t:prev.get(f)});}
        q.slots[c]=next.slice(0,LIMITS.perCat);
      }
      for(const {f} of parse(out.milestones)){
        if(!q.milestones.some(x=>x.t===f))q.milestones.push({t:f,at:t,told:false});
      }
      q.milestones=q.milestones.slice(-LIMITS.milestones);
      const g=parse(out.group).map(x=>x.f);if(g.length)addGroup(g);
      q.pending=(q.pending||[]).slice(taken.length);q.summarizedAt=t;
      save(user,q);return true;
    }catch{return false;}
    finally{inflight.delete(user);}
  }

  function forget(user){
    short.delete(user);
    try{fsMod.unlinkSync(fileOf(dir,user));return true;}catch{return false;}
  }
  function forgetCategory(user,word){
    const p=load(user);if(!p)return false;
    if(/里程碑/.test(word)){p.milestones=[];}
    else{const c=CAT_OF[word];if(!c)return false;p.slots[c]=[];}
    try{save(user,p);return true;}catch{return false;}
  }

  // ---- 群记忆 ----
  function loadGroup(){
    try{const j=JSON.parse(fsMod.readFileSync(groupFile(),'utf8'));const t=now();
      return (Array.isArray(j.items)?j.items:[]).filter(x=>x&&x.t&&t-(x.at||0)<=LIMITS.groupTtlMs);}catch{return [];}
  }
  function addGroup(list){
    const t=now();const items=loadGroup();
    for(const raw of list){const f=cleanFact(raw);if(!f||blocked.test(f))continue;
      const i=items.findIndex(x=>x.t===f);if(i>=0)items.splice(i,1);items.push({t:f,at:t});}
    try{writeJson(groupFile(),{v:1,items:items.slice(-LIMITS.group)});}catch{}
  }
  function groupFacts(){return loadGroup().map(x=>x.t);}
  function forgetGroup(){try{fsMod.unlinkSync(groupFile());return true;}catch{return false;}}

  return {recent,facts,slot,profile,pendingMilestones,markTold,record,remember,consolidate,forget,forgetCategory,
    groupFacts,addGroup,forgetGroup,load,_short:short};
}

module.exports={createMemory,cleanFact,classify,fileOf,LIMITS,DENY,CATS,LABEL,CAT_OF};
