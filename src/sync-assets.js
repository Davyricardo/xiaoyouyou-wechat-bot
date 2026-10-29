#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
const {BASE,atomic,fetchBuffer,data}=require('./net');const {build}=require('./catalog-build');
sharp.concurrency(1);sharp.cache({memory:16,files:10,items:30});
const manifestFile=path.join(BASE,'assets','manifest.json'),catalogFile=path.join(BASE,'assets','catalog.json');
const safe=id=>String(id).replace(/[^a-zA-Z0-9_-]/g,'_');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function load(){try{return JSON.parse(fs.readFileSync(manifestFile));}catch(e){if(e.code!=='ENOENT')throw e;return {schema:1,entries:{}};}}
async function commit(file,image,key,entry){
  const lock=path.join(BASE,'assets','.manifest.lock');fs.mkdirSync(path.dirname(lock),{recursive:true});let acquired=false;
  for(let tries=0;tries<1500&&!acquired;tries++){
    try{fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});acquired=true;}catch(e){
      if(e.code!=='EEXIST')throw e;
      try{const pid=Number(fs.readFileSync(lock,'utf8'));if(Number.isSafeInteger(pid)&&pid>1){try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH')fs.unlinkSync(lock);}}}catch(err){if(err.code!=='ENOENT')throw err;}
      await new Promise(r=>setTimeout(r,20));
    }
  }
  if(!acquired)throw Error('素材索引正在被其他进程写入');
  try{const m=load();atomic(path.join(BASE,file),image);m.entries[key]=entry;atomic(manifestFile,JSON.stringify(m,null,2));}
  finally{fs.unlinkSync(lock);}
}
async function ensure(kind,item) {
  if(!item.id||!item.url)throw Error('素材缺少 ID/URL');
  const m=load(),key=kind+':'+item.id,old=m.entries[key];
  if(old?.url===item.url)try{const b=fs.readFileSync(path.join(BASE,old.file));if(sha(b)===old.sha256){await sharp(b).metadata();return old;}}catch{}
  let error;for(let attempt=0;attempt<3;attempt++)try{
    const b=await fetchBuffer(item.url,8e6);const meta=await sharp(b).metadata();if(!meta.width||!meta.height)throw Error('图片无效');
    const image=await sharp(b).resize({width:kind==='weapons'?360:1080,withoutEnlargement:true}).png().toBuffer();
    const file=`assets/${kind}/${safe(item.id)}.png`;
    const entry={id:item.id,name:item.name,url:item.url,file,sha256:sha(image),bytes:image.length,updatedAt:new Date().toISOString()};
    await commit(file,image,key,entry);return entry;
  }catch(e){error=e;await new Promise(r=>setTimeout(r,250*(attempt+1)));}
  // A failed fetch never replaces a valid existing file.
  if(old)try{const b=fs.readFileSync(path.join(BASE,old.file));if(sha(b)===old.sha256)return old;}catch{}
  throw error;
}
async function dynamicAssets(schedule,catalog) {
  const loc=catalog.locale;const items=[];
  for(const group of Object.values(schedule.coopGroupingSchedule||{}))for(const n of group?.nodes||[]) {
    const s=n.setting;if(!s)continue;
    items.push(['salmon',{id:s.coopStage.id,name:loc.stages[s.coopStage.id]?.name||s.coopStage.name,url:s.coopStage.image.url}]);
    for(const w of s.weapons||[])items.push(['salmon-weapons',{id:w.__splatoon3ink_id,name:loc.weapons[w.__splatoon3ink_id]?.name||w.name,url:w.image?.url}]);
  }return items.filter(([,x])=>x.id&&x.url);
}
async function main() {
  let catalog;
  if(process.argv.includes('--refresh')||!fs.existsSync(catalogFile)){catalog=await build();atomic(catalogFile,JSON.stringify(catalog,null,2));}
  else catalog=JSON.parse(fs.readFileSync(catalogFile));
  const tasks=[...catalog.weapons.map(x=>['weapons',x]),...catalog.stages.map(x=>['maps',x]),...catalog.salmon.map(x=>['salmon',x]),...catalog.modes.map(x=>['modes',x])];
  try{tasks.push(...await dynamicAssets((await data('schedules')).data,catalog));}catch(e){console.error('动态素材发现失败',e.message);}
  const announcements=JSON.parse(fs.readFileSync(path.join(BASE,'festival-announcements.json')));
  for(const f of announcements.events)tasks.push(['festivals',{id:f.id,name:f.title,url:f.imageUrl}]);
  const unique=[...new Map(tasks.map(t=>[t[0]+':'+t[1].id,t])).values()];let next=0,ok=0,fail=[];
  async function worker(){while(next<unique.length){const [kind,item]=unique[next++];try{await ensure(kind,item);ok++;}catch(e){fail.push({kind,id:item.id,error:e.message});}if((ok+fail.length)%20===0)console.log('已检查',ok+fail.length,'/',unique.length);}}
  await Promise.all([worker(),worker()]);
  const entries=load().entries;const report={at:new Date().toISOString(),ordinaryWeapons:catalog.weapons.length,maps:catalog.stages.length,salmonStages:catalog.salmon.length,normalSalmonStages:catalog.salmon.filter(x=>!x.isBigRun).length,modes:catalog.modes.length,expected:unique.length,success:ok,failed:fail,bytes:Object.values(entries).reduce((n,e)=>n+e.bytes,0),chineseCoverage:catalog.weapons.filter(x=>x.name).length+'/'+catalog.weapons.length};
  atomic(path.join(BASE,'assets','sync-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(fail.length)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={ensure,dynamicAssets,safe};
