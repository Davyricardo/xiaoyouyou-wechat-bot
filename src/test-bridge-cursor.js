'use strict';
// 启动宽限：重启前后 30 秒内的指令必须仍被处理（旧行为是全部当历史丢掉）。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
// 桥接会把 determine 不了结果的发送写进事件日志：测试前把日志文件指到临时目录，
// 免得脏真实的 recovery-events.jsonl（那条流是 auto-relogin 的唯一判据来源）。
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-bridge-test-'));
process.env.SPLATOON_EVENTS_FILE=path.join(TMP,'recovery-events.jsonl');
const {resumeCursor,command,CHAT,GRACE_MS,processBatch,backlogFloor}=require('./bridge-v3.3');
const {NICK}=require('./bot-config');
test.after(()=>fs.rmSync(TMP,{recursive:true,force:true}));

const at=(secAgo,now)=>new Date(now-secAgo*1000).toISOString();
const msg=(id,secAgo,now,over={})=>({
  chatId:CHAT,type:1,isMentioned:true,isSelf:false,localId:id,
  content:'@'+NICK+' 地图',timestamp:at(secAgo,now),...over
});

test('宽限默认 30 秒',()=>{
  assert.equal(GRACE_MS,30000);
});

test('宽限内的消息不算历史：游标停在上一条',()=>{
  const now=Date.now();
  const msgs=[msg(10,120,now),msg(11,60,now),msg(12,10,now),msg(13,2,now)];
  // since = 启动时刻 - 30s ⇒ id 12/13 在宽限内，10/11 是历史
  assert.equal(resumeCursor(msgs,now-30000),11);
});

test('全部早于宽限 → 游标指向最新（等同旧行为）',()=>{
  const now=Date.now();
  const msgs=[msg(1,600,now),msg(2,300,now),msg(3,120,now)];
  assert.equal(resumeCursor(msgs,now-30000),3);
});

test('空列表 → -1（由 processBatch 兜底）',()=>{
  assert.equal(resumeCursor([],Date.now()),-1);
});

test('时间戳非法或缺 localId 的消息被跳过',()=>{
  const now=Date.now();
  const msgs=[
    {localId:5,timestamp:'not-a-date'},
    {localId:'x',timestamp:at(600,now)},
    msg(6,600,now),
  ];
  assert.equal(resumeCursor(msgs,now-30000),6);
});

test('宽限内的指令仍会被 command() 接受',()=>{
  const now=Date.now();
  const since=now-30000;
  assert.ok(command(msg(20,5,now),since),'10 秒前的指令应被处理');
});

test('超过宽限的旧指令仍被 command() 拒绝',()=>{
  const now=Date.now();
  const since=now-30000;
  assert.equal(command(msg(21,90,now),since),null,'90 秒前的指令不应被补回复');
});

test('宽限内的指令但未 @机器人 → 仍然忽略',()=>{
  const now=Date.now();
  const since=now-30000;
  assert.equal(command(msg(22,5,now,{isMentioned:false}),since),null);
});

const eventsRead=()=>fs.readFileSync(process.env.SPLATOON_EVENTS_FILE,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const batchState=lastId=>({chatId:CHAT,lastId});

test('发送结果 uncertain → 不重试：游标直接推进，同一条不再二次发送',async()=>{
  const now=Date.now(),since=now-GRACE_MS;
  const msgs=[msg(40,5,now),msg(41,5,now)];
  let calls=0;
  const state=batchState(39);
  await processBatch(msgs,state,since,{save(){},running:()=>true,reply:async()=>{
    calls++;const e=Error('粘贴结果不明，可能已发送');e.uncertain=true;throw e;
  }});
  assert.equal(calls,2,'每条只应尝试一次');
  assert.equal(state.lastId,41,'uncertain 也要推进游标');
});

test('发送结果 uncertain → 事件日志里留下一条 send_uncertain',async()=>{
  const now=Date.now(),since=now-GRACE_MS;
  const state=batchState(49);
  await processBatch([msg(50,5,now)],state,since,{save(){},running:()=>true,reply:async()=>{
    const e=Error('粘贴结果不明');e.uncertain=true;throw e;
  }});
  const written=eventsRead().filter(e=>e.type==='send_uncertain'&&e.localId===50);
  assert.equal(written.length,1);
  assert.match(written[0].reason,/粘贴结果不明/);
});

test('普通失败仍然重试：游标不推进，交给下一批再试一次',async()=>{
  const now=Date.now(),since=now-GRACE_MS;
  const state=batchState(59);
  let calls=0;
  await assert.rejects(()=>processBatch([msg(60,5,now)],state,since,{save(){},running:()=>true,reply:async()=>{
    calls++;throw Error('发送超时');
  }}),/发送超时/);
  assert.equal(calls,1);
  assert.equal(state.lastId,59,'失败不推进游标');
});

test('恢复游标后，积压下限取 savedAt：停机期间发的指令不会被当历史丢掉',()=>{
  const now=Date.now();
  // 停机 5 分钟：savedAt 在 5 分钟前，远超 GRACE_MS，command() 仍应接受这段时间里的指令
  assert.equal(backlogFloor(now,GRACE_MS,now-5*60*1000),now-5*60*1000);
  // 没有恢复游标（首次启动）时保持旧行为
  assert.equal(backlogFloor(now,GRACE_MS,undefined),now-GRACE_MS);
  // savedAt 比默认下限更晚：取下界更早的那个，行为不变
  assert.equal(backlogFloor(now,GRACE_MS,now-1000),now-GRACE_MS);
});

test('恢复游标后 command() 接受停机期间发的指令',()=>{
  const now=Date.now();
  const since=backlogFloor(now,GRACE_MS,now-5*60*1000);
  assert.ok(command(msg(70,180,now),since),'停机第 3 分钟发的指令应被处理');
  assert.equal(command(msg(71,20*60,now),since),null,'停机 20 分钟前（超 BACKLOG_MS）的旧指令不重放');
});
