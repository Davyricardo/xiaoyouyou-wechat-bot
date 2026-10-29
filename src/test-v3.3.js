'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {pair,modelMaps,modelSalmon,randomMatch,selectFestival,festivalCandidates,fmt,respond,help}=require('./xiaoyouyou-v3.3');
const {eligible}=require('./catalog-build');const {command,CHAT,processBatch}=require('./bridge-v3.3');
const c=JSON.parse(fs.readFileSync('assets/catalog.json'));
const d=JSON.parse(fs.readFileSync('fixtures-schedules.json')).data;
const now=Date.parse('2026-10-11T23:10:00Z');
test('四种轮换各自当前/下一轮、挑战开放数组、稳定ID中文和北京时间',()=>{
  const m=modelMaps(d,c,now);assert.equal(m.sections.length,4);
  for(const s of m.sections){assert.equal(s.rounds.length,2);for(const r of s.rounds){assert.equal(r.missing,undefined);assert.equal(r.stages.length,2);assert.ok(Object.values(require('./catalog-build').RULES).includes(r.rule));for(const z of r.stages)assert.ok(c.stages.some(s=>s.id===z.id&&s.name===z.name));}}
  assert.equal(m.sections[1].rounds[0].rule,'真格蛤蜊');assert.notEqual(m.sections[1].rounds[0].rule,m.sections[2].rounds[0].rule);
  assert.equal(fmt('2026-10-11T16:00:00Z'),'10/12 00:00');
});
test('精确切换边界；空当前不能拿未来代替当前',()=>{
  const rows=[{startTime:'2026-10-12T00:00:00Z',endTime:'2026-10-12T02:00:00Z'},{startTime:'2026-10-12T02:00:00Z',endTime:'2026-10-12T04:00:00Z'}];
  assert.equal(pair(rows,Date.parse('2026-10-12T02:00:00Z'))[0].node,rows[1]);assert.equal(pair(rows,now)[0].node,undefined);assert.equal(pair(rows,now)[1].node,rows[0]);
  const x=modelMaps({...d,bankaraSchedules:{nodes:[]}},c,now);assert.ok(x.sections[1].rounds.every(r=>r.missing));
});
test('打工真实场地与四把武器当前/下一轮，大型跑仅有日程才显示',()=>{
  const m=modelSalmon(d,c,now);assert.equal(m.rounds.length,2);for(const r of m.rounds){assert.equal(r.weapons.length,4);assert.ok(c.salmon.some(x=>x.id===r.stage.id));for(const w of r.weapons)assert.ok(c.locale.weapons[w.id]?.name===w.name);}
  const extra={...d,coopGroupingSchedule:{...d.coopGroupingSchedule,bigRunSchedules:{nodes:[d.coopGroupingSchedule.regularSchedules.nodes[0]]}}};assert.ok(modelSalmon(extra,c,now).rounds.some(r=>r.title==='大型跑'));
});
test('完整普通对战池与排除规则：类型、ID、稀有标记、所有熊先生专用',()=>{
  assert.equal(c.weapons.length,174);assert.ok(c.weapons.every(eligible));
  const base=c.weapons[0];for(const b of [{type:'Coop'},{numericId:20900},{isCoopRare:true},{name:'Grizzco Blaster'},{rowId:'Stringer_Bear_Coop'}])assert.equal(eligible({...base,...b}),false);
  for(let i=0;i<100000;i++){const m=randomMatch(c),w=m.teams.flat();assert.equal(w.length,8);assert.equal(new Set(w.map(x=>x.id)).size,8);assert.ok(w.every(eligible));assert.ok(c.stages.some(x=>x.id===m.stage.id&&x.numericId!==25));assert.ok(['TURF_WAR','AREA','LOFT','GOAL','CLAM'].includes(m.ruleId));}
});
test('真实@、唯一群、五命令；表情/媒体/无效/自身/历史静默',async()=>{
  const m={chatId:CHAT,type:1,isMentioned:true,isSelf:false,localId:500,content:'@小鱿鱿\u2005地图',timestamp:new Date(now).toISOString()};
  assert.equal(command(m,now-1),'地图');
  for(const patch of [{chatId:'123456789@chatroom'},{chatId:'123@chatroom'},{isMentioned:false},{isSelf:true},{type:3},{type:47},{type:43},{type:34},{content:'@小鱿鱿 😄'},{content:'@小鱿鱿 4v4'},{content:'@小鱿鱿 战绩'},{content:'@小鱿鱿 无效'},{content:'@小鱿鱿 地图 哈哈'},{content:'地图'},{timestamp:new Date(now-2000).toISOString()}])assert.equal(command({...m,...patch},now-1),null);
  assert.equal(await respond('无效'),null);assert.ok(!help('小鱿鱿').includes('4v4'));assert.ok(!help('小鱿鱿').includes('战绩'));
});
test('去重游标先保存；发送失败后的同一消息不重发',async()=>{
  const m={chatId:CHAT,type:1,isMentioned:true,isSelf:false,localId:501,content:'@小鱿鱿 帮助',timestamp:new Date(now).toISOString()};let sends=0,persisted;
  const s={lastId:500},handlers={save:x=>persisted=x.lastId,reply:async()=>{sends++;assert.equal(persisted,501);throw Error('mock send failed');}};
  await assert.rejects(()=>processBatch([m],s,now-1,handlers));await processBatch([m],s,now-1,handlers);assert.equal(sends,1);
});
test('嵌套祭典、无活动不编造、公告有效期、主题阵营中文和时间',()=>{
  const f={id:'test',__splatoon3ink_id:'JUEA-00100',title:'English',teams:[{teamName:'A'},{teamName:'B'},{teamName:'C'}],startTime:'2026-10-31T00:00:00Z',endTime:'2026-11-02T00:00:00Z',image:{url:'https://example.com/a.png'}};
  const raw={JP:{data:{festRecords:{nodes:[f]}}}};assert.equal(festivalCandidates(raw).length,1);
  const selected=selectFestival(raw,c,{events:[]},now);assert.equal(selected.title,'如果进入幻想世界想成为哪种职业？');assert.deepEqual(selected.teams,['魔法师','骑士','忍者']);
  assert.equal(selectFestival({},c,{events:[]},now),null);
  assert.equal(selectFestival(raw,c,{events:[]},Date.parse(f.endTime)),null);
  const announcements=JSON.parse(fs.readFileSync('festival-announcements.json'));assert.equal(selectFestival({},c,announcements,now).id,'splatoween-2026-official');
  assert.equal(selectFestival({},c,announcements,Date.parse('2027-01-01Z')),null);
});
