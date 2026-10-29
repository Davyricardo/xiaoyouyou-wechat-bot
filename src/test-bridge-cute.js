'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {cuteLine}=require('./bridge-v3.3');
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
