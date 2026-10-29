'use strict';
const {getJson,fetchBuffer}=require('./net');
const RULES={TURF_WAR:'占地对战',AREA:'真格区域',LOFT:'真格塔楼',GOAL:'真格鱼虎对战',CLAM:'真格蛤蜊'};
const EXCLUDED=/熊先生|熊耳朵|Grizzco|Bear|Kuma|クマサン/i;
function eligible(w){return w.type==='Versus'&&w.isCoopRare===false&&Number.isInteger(w.numericId)&&w.numericId>=0&&w.numericId<20000&&!EXCLUDED.test([w.id,w.rowId,w.name,w.en].join(' '));}
async function build() {
  const tree=await getJson('https://api.github.com/repos/Leanny/splat3/git/trees/main?recursive=1');
  if(tree.truncated)throw Error('上游目录不完整');
  const files=new Set(tree.tree.filter(x=>x.type==='blob').map(x=>x.path));
  const versions=[...files].filter(p=>/^data\/mush\/\d+\/WeaponInfoMain.json$/.test(p)).map(p=>Number(p.split('/')[2]));
  const version=Math.max(...versions), raw='https://raw.githubusercontent.com/Leanny/splat3/'+tree.sha+'/';
  const [info,coop,vs,stat,locale,stageData,statStages]=await Promise.all([
    getJson(raw+`data/mush/${version}/WeaponInfoMain.json`),getJson(raw+`data/mush/${version}/CoopSceneInfo.json`),
    getJson(raw+`data/mush/${version}/VersusSceneInfo.json`),getJson('https://stat.ink/api/v3/weapon?full=1'),
    getJson('https://splatoon3.ink/data/locale/zh-CN.json'),getJson('https://splatoon3.ink/data/stages.json'),
    getJson('https://stat.ink/api/v3/stage?full=1')]);
  const byNumber=new Map();for(const w of stat)for(const a of w.aliases)if(/^\d+$/.test(a))byNumber.set(Number(a),w);
  const weapons=info.filter(x=>x.Type==='Versus').map(x=>{
    const s=byNumber.get(x.Id), art=`images/weapon/Wst_${x.__RowId}.png`;
    if(!s?.name?.zh_CN||!files.has(art))throw Error('普通武器缺少译名或图片：'+x.Id);
    return {id:s.key,numericId:x.Id,type:x.Type,isCoopRare:x.IsCoopRare,rowId:x.__RowId,name:s.name.zh_CN.replace(/[\x00-\x1f]/g,''),en:s.name.en_US,url:raw+art};
  });
  if(weapons.some(w=>!eligible(w))||weapons.length!==stat.length)throw Error('完整普通武器目录核对失败');
  const stages=stageData.data.stageRecords.nodes.map(x=>{
    const s=statStages.find(s=>s.aliases.includes(String(x.vsStageId))&&s.name.en_US===x.name);
    const name=s?.name?.zh_CN||locale.stages[x.id]?.name;if(!name)throw Error('场地缺少中文：'+x.id);
    return {id:x.id,numericId:x.vsStageId,name,en:x.name,url:x.originalImage.url};
  });
  const salmon=coop.map(x=>{
    const id=Buffer.from('CoopStage-'+x.Id).toString('base64');let art=`images/stage/Cop_${x.__RowId.slice(4)}.png`;
    // Big Run reuses the same stage art; match the game scene identifier, not a text search.
    if(x.IsBigRun){const suffix=x.__RowId.slice(4).replace(/\d+$/,'');const v=vs.find(v=>v.__RowId.slice(4).replace(/\d+$/,'')===suffix);if(v)art=`images/stage/${v.__RowId.replace(/\d+$/,'')}.png`;}
    const name=locale.stages[id]?.name;
    if(!name||!files.has(art))throw Error('打工场地缺少索引：'+x.Id+' '+art);
    return {id,numericId:x.Id,name,isBigRun:x.IsBigRun,url:raw+art};
  });
  const modes=Object.entries(RULES).map(([id,name])=>({id,name,url:`https://raw.githubusercontent.com/Cypas/splatoon3-schedule/main/nonebot_plugin_splatoon3_schedule/resource/ImageData/${id}.png`}));
  return {schema:1,generatedAt:new Date().toISOString(),sourceRevision:tree.sha,gameDataVersion:version,weapons,stages,salmon,modes,locale};
}
module.exports={build,eligible,EXCLUDED,RULES};
