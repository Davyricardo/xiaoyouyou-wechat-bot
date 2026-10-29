'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {pollConfig}=require('./bridge-v3.3');

test('轮询配置：默认值与现状一致（250ms、无退避下限、封顶 5s）',()=>{
 assert.deepEqual(pollConfig({}),{interval:250,backoffMin:0,backoffMax:5000});
});
test('轮询配置：POLL_MS=500 是 A/B 实验组',()=>{
 assert.equal(pollConfig({POLL_MS:'500'}).interval,500);
});
test('轮询配置：间隔不低于 250ms（防止控制台误设把客户端打爆）',()=>{
 assert.equal(pollConfig({POLL_MS:'10'}).interval,250);
});
test('轮询配置：退避参数可配置',()=>{
 assert.deepEqual(pollConfig({POLL_BACKOFF_MIN_MS:'2000',POLL_BACKOFF_MAX_MS:'10000'}),
  {interval:250,backoffMin:2000,backoffMax:10000});
});
test('轮询配置：非法/负数/空值回落默认，不抛',()=>{
 for(const env of [{POLL_MS:'abc'},{POLL_MS:''},{POLL_MS:'-1'},{POLL_BACKOFF_MIN_MS:'nope'},{POLL_BACKOFF_MAX_MS:null}]){
  const c=pollConfig(env);
  assert.ok(Number.isFinite(c.interval)&&c.interval>=250);
  assert.ok(Number.isFinite(c.backoffMin)&&c.backoffMin>=0);
  assert.ok(Number.isFinite(c.backoffMax)&&c.backoffMax>=250);
 }
});
test('轮询配置：退避下限设 0 时恢复旧行为（interval*2^n，封顶 5s）',()=>{
 const {pollBackoff}=require('./recovery-core');
 const c=pollConfig({});
 // 旧实现：min(250*2^min(f,5),5000)；新纯函数在 minMs=0 时给出同样序列
 assert.deepEqual([1,2,3,4,5,6].map(f=>pollBackoff({failures:f,intervalMs:c.interval,minMs:c.backoffMin,maxMs:c.backoffMax})),
  [500,1000,2000,4000,5000,5000]);
});
