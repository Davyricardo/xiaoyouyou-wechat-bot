'use strict';
// 群聊被动记忆：任何群友发言都进个人档案（不要求 @ 机器人）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemory } = require('./llm-memory');
const { createChat } = require('./llm-chat');

function mkMem() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyy-mem-'));
  let t = 1700000000000;
  const m = createMemory({ dir, now: () => t, blocked: /密码|token|手机/ });
  return { m, dir, advance: (ms) => { t += ms; } };
}

function stubMemory(calls) {
  return {
    ingest: (u, n, t) => { calls.push([u, n, t]); return false; },
    consolidate: async () => true,
    groupFacts: () => [], facts: () => [], recent: () => [], pendingMilestones: () => [],
    markTold: () => { }, record: () => false, slot: () => [],
  };
}

test('ingest：短消息、纯表情、空白不入档', () => {
  const { m } = mkMem();
  assert.equal(m.ingest('wxid_a', '甲', '嗯'), false);
  assert.equal(m.ingest('wxid_a', '甲', '😂😂😂'), false);
  assert.equal(m.ingest('wxid_a', '甲', '   '), false);
  assert.equal(m.load('wxid_a'), null);
});

test('ingest：攒够 5 条返回 true 并保留 pending', () => {
  const { m } = mkMem();
  const lines = ['今天打工好累啊', '晚上一起打真格吗', '我最近在练滚筒', '这把武器手感不错', '明天有祭典吗'];
  const due = lines.map((t) => m.ingest('wxid_a', '甲', t));
  assert.deepEqual(due, [false, false, false, false, true]);
  const p = m.load('wxid_a');
  assert.equal(p.pending.length, 5);
  assert.equal(p.nick, '甲');
  assert.equal(p.count, 5);
});

test('ingest：同一句不重复计入 pending', () => {
  const { m } = mkMem();
  for (let i = 0; i < 4; i++) m.ingest('wxid_a', '甲', '同一句话重复说');
  assert.equal(m.load('wxid_a').pending.length, 1);
});

test('ingest：30 分钟内不重复触发总结，过了就触发', async () => {
  const { m, advance } = mkMem();
  const first = ['第一句比较长的话', '第二句比较长的话', '第三句比较长的话', '第四句比较长的话', '第五句比较长的话'];
  first.forEach((t) => m.ingest('wxid_a', '甲', t));
  assert.equal(await m.consolidate('wxid_a', async () => ({ social: ['喜欢打真格'] })), true);
  assert.equal(m.load('wxid_a').pending.length, 0);

  const more = ['第六句比较长的话', '第七句比较长的话', '第八句比较长的话', '第九句比较长的话', '第十句比较长的话'];
  const due = more.map((t) => m.ingest('wxid_a', '甲', t));
  assert.equal(due[due.length - 1], false, '30 分钟内不应再触发');

  advance(31 * 60 * 1000);
  const later = ['A 句比较长的话', 'B 句比较长的话', 'C 句比较长的话', 'D 句比较长的话', 'E 句比较长的话'];
  const due2 = later.map((t) => m.ingest('wxid_a', '甲', t));
  assert.equal(due2[due2.length - 1], true, '过了 30 分钟应触发');
});

test('ingest：隐私词不进档案', () => {
  const { m } = mkMem();
  assert.equal(m.ingest('wxid_a', '甲', '我的手机号是多少你猜'), false);
  assert.equal(m.load('wxid_a'), null);
});

test('observe：非 @ 的群聊消息写入个人档案', () => {
  const calls = [];
  const chat = createChat({ memory: stubMemory(calls), env: { XYY_LLM: 'all' }, log: () => { } });
  chat.observe({
    type: 1, isSelf: false, isMentioned: false, sender: 'wxid_a', senderName: '甲',
    content: '今晚有人打真格吗', timestamp: new Date().toISOString(),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'wxid_a');
  assert.equal(calls[0][1], '甲');
  assert.match(calls[0][2], /真格/);
});

test('observe：@ 机器人和自己的消息不重复写入', () => {
  const calls = [];
  const chat = createChat({ memory: stubMemory(calls), env: { XYY_LLM: 'all' }, log: () => { } });
  const now = new Date().toISOString();
  chat.observe({ type: 1, isSelf: false, isMentioned: true, sender: 'wxid_a', senderName: '甲', content: '@小鱿鱿 地图', timestamp: now });
  chat.observe({ type: 1, isSelf: true, isMentioned: false, sender: 'wxid_bot', senderName: '小鱿鱿', content: '这是机器人的回复', timestamp: now });
  assert.equal(calls.length, 0);
});
