'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {CHAT,CHAT_NAME,groupHeader}=require('./bot-config');
function nodes(tree){const out=[];function walk(n){if(!n)return;out.push(n);for(const c of n.children||[])walk(c);}walk(tree);return out;}
function ready(tree,editor){
  const all=nodes(tree),e=editor(tree);
  if(!all.some(n=>n.role==='frame'&&n.name==='Weixin'&&n.states?.includes('ACTIVE'))||!all.some(n=>n.role==='label'&&groupHeader(n.name))||e?.input?.name!==CHAT_NAME)throw Error('当前窗口不是已确认的授权群聊');
  return e;
}
function point(bounds){if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)||bounds.width<=0||bounds.height<=0)throw Error('控件位置无效');return [String(Math.round(bounds.x+bounds.width/2)),String(Math.round(bounds.y+bounds.height/2))];}
const normalized=s=>String(s||'').replace(/\r\n/g,'\n').trim();
function createSender(io){
  async function group(){
    const chats=await io.find();const exact=chats.filter(c=>c.name===CHAT_NAME);if(exact.length!==1||(exact[0].chatId||exact[0].id)!==CHAT)throw Error('授权群聊名称不唯一或 ID 不匹配');
    let tree=await io.tree(),e;
    try{e=ready(tree,io.editor);}catch{await io.open();tree=await io.tree();e=ready(tree,io.editor);}
    if(normalized(e.input.text))throw Error('微信输入框已有未发送内容，停止覆盖');
    return e;
  }
  async function send(chat,payload,type){
    if(chat!==CHAT)throw Error('仅允许指定授权群聊');
    if(String(payload||'').trim()==='')throw Error('empty payload');
    const start=performance.now(),timings={},stage=async(name,fn)=>{const at=performance.now(),v=await fn();timings[name]=Math.round(performance.now()-at);return v;};
    let mutated=false,draftEditor=null;
    // A failed paste leaves a dead draft behind; preflight rejects the next launch.
    async function clearDraft(){
      try{
        await io.tool('click',point(draftEditor.input.bounds));
        await io.tool('key',['ctrl+a']);
        await io.tool('key',['BackSpace']);
        await new Promise(resolve=>setTimeout(resolve,150));
        const tree=await io.tree(),draft=ready(tree,io.editor);
        return !normalized(draft.input.text);
      }catch{return false;}
    }
    try{
      const before=await stage('read',()=>io.rows()),lastId=Math.max(-1,...before.map(m=>m.localId));
      const e=await stage('group',group);draftEditor=e;
      await stage('focus',()=>io.tool('click',point(e.input.bounds)));mutated=true;
      await stage('paste',()=>type===3?io.image(payload):io.tool('input',[payload]));
      const pasted=await stage('verifyDraft',async()=>{
        for(let i=0;;i++){
          const tree=await io.tree(),draft=ready(tree,io.editor),filled=type===3?String(draft.input.text||'').trim():normalized(draft.input.text);
          if(filled||i>=9)return {tree,draft};
          await new Promise(resolve=>setTimeout(resolve,200));
        }
      }),draft=pasted.draft;
      if(type===3){io.pendingImageButton(pasted.tree);}else if(normalized(draft.input.text)!==normalized(payload))throw Error('待发送文字与回复不一致');
      if(draft.button.states?.includes('DISABLED'))throw Error('发送按钮不可用');
      await stage('send',()=>io.tool('click',point(draft.button.bounds)));
      // The live reader can confirm the outgoing row before an expensive UI dump.
      // Text requires an exact content match; ambiguous rows never trigger retries.
      const confirmed=(messages)=>messages.filter(m=>m.chatId===CHAT&&m.localId>lastId&&m.isSelf===true&&m.type===type&&(type!==1||normalized(m.content)===normalized(payload)));
      const immediate=await stage('readback',async()=>{
        const deadline=performance.now()+600;let matches=confirmed(await io.rows());
        while(matches.length===0&&performance.now()<deadline){
          await new Promise(resolve=>setTimeout(resolve,50));matches=confirmed(await io.rows());
        }
        return matches;
      });
      if(immediate.length>1)throw Error('回读到多条发送记录，停止重试');
      if(immediate.length===1)return {confirmation:'database',localId:immediate[0].localId,beforeId:lastId,type,elapsedMs:Math.round(performance.now()-start),timings};
      // A fresh UI read verifies that the exact draft was consumed. Database
      // updates may lag; never paste again just because the DB has not caught up.
      const after=await stage('verifySent',()=>io.tree()),empty=ready(after,io.editor);
      if(normalized(empty.input.text))throw Error('发送状态未确认，不自动重发');
      const messages=await stage('readbackAfterUI',()=>io.rows());
      const sent=confirmed(messages);
      if(sent.length>1)throw Error('回读到多条发送记录，停止重试');
      return {confirmation:sent.length?'database':'ui',localId:sent[0]?.localId,beforeId:lastId,type,elapsedMs:Math.round(performance.now()-start),timings};
    }catch(e){e.uncertain=e.uncertain||mutated||/草稿|输入框|窗口|控件|状态/.test(e.message);if(mutated&&!(await clearDraft()))e.draftStuck=true;throw e;}
  }
  return {sendImage:(chat,file)=>send(chat,file,3),sendText:(chat,text)=>send(chat,text,1)};
}
function tool(name,args,input){return new Promise((resolve,reject)=>{
  const child=execFile('docker',['exec',...(input?['-i']:[]),'splatoon-wechat-test',name==='image'?'/bin/sh':'/opt/tools/'+name,...args],{timeout:12000,maxBuffer:16000},(e)=>e?reject(e):resolve());
  if(input){child.stdin.on('error',()=>{});child.stdin.end(input);}
});}
function image(file){
  // Two generated directories are allowed: per-query cards and the 40h pre-rendered schedule.
  const roots=[path.join(__dirname,'cache/cards'),path.join(__dirname,'cache/salmon-schedule'),path.join(__dirname,'cache/battle-schedule')]
    .filter(d=>{try{fs.accessSync(d);return true;}catch{return false;}})
    .map(d=>fs.realpathSync(d));
  const real=fs.realpathSync(file);
  if(!roots.includes(path.dirname(real))||!real.endsWith('.png'))throw Error('仅发送生成的 PNG 图卡');
  const b=fs.readFileSync(real);if(b.length>8e6||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('图卡格式或大小无效');
  const temp='/tmp/xyy-fast-'+crypto.randomBytes(12).toString('hex')+'.png';
  // Only this generated temporary file is removed, including on tool failure.
  const script='umask 077; trap \'unlink -- "$1"\' EXIT; cat > "$1" && /opt/tools/paste-image "$1" image/png';
  return tool('image',['-c',script,'xyy-image',temp],b);
}
let sender;
function current(){if(!sender){const c=require('./wx-client');sender=createSender({editor:c.editor,pendingImageButton:c.pendingImageButton,tree:c.a11yTree,rows:c.rows,find:()=>c.apiGet('/api/chats/find?name='+encodeURIComponent(CHAT_NAME)),open:()=>c.wx(['chats','open',CHAT]),tool,image});}return sender;}
module.exports={createSender,ready,point,sendImage:(...args)=>current().sendImage(...args),sendText:(...args)=>current().sendText(...args)};
