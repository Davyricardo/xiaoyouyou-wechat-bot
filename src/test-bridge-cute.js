'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {cuteLine,shouldSendCuteLine}=require('./bridge-v3.3');
const CUTE='小鱿鱿要亲亲～';
const IMG={image:'/tmp/x.png'},TXT={text:'纯文字'};
test('图片回复 + 地图 → 追发',()=>assert.equal(cuteLine('地图',IMG),CUTE));
test('图片回复 + 帮助 → 不追发',()=>assert.equal(cuteLine('帮助',IMG),null));
test('文本回复 + 地图 → 不追发',()=>assert.equal(cuteLine('地图',TXT),null));
test('图片回复 + 配装 碳纤维滚筒 → 追发',()=>assert.equal(cuteLine('配装 碳纤维滚筒',IMG),CUTE));
test('图片回复 + 帮助 配装 → 不追发',()=>assert.equal(cuteLine('帮助 配装',IMG),null));
test('空/异常输入不抛异常',()=>{
 for(const [c,r] of [[null,IMG],['',IMG],['地图',null],['地图',undefined],[undefined,{image:'x'}]])assert.equal(cuteLine(c,r),null);
});
test('shouldSendCuteLine：冷却期内抑制追发，过期或冷却=0 允许追发',()=>{
 const base=1000000,cooldown=10*60*1000;
 assert.equal(shouldSendCuteLine('地图',IMG,0,base,cooldown),CUTE,'首次发送允许');
 assert.equal(shouldSendCuteLine('地图',IMG,base,base+60*1000,cooldown),null,'1 分钟内冷却阻止');
 assert.equal(shouldSendCuteLine('地图',IMG,base,base+cooldown-1,cooldown),null,'差 1ms 仍阻断');
 assert.equal(shouldSendCuteLine('地图',IMG,base,base+cooldown,cooldown),CUTE,'满冷却恢复');
 assert.equal(shouldSendCuteLine('地图',IMG,base,base+1,0),CUTE,'cooldown=0 不限制');
 assert.equal(shouldSendCuteLine('帮助',IMG,0,base,cooldown),null,'帮助依然不追发');
});
