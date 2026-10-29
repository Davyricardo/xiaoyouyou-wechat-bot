'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {classify,observe,runCheck,formatAlert}=require('./wechat-health-monitor');
const healthy={bridge:'active/running',auth:'logged_in'},out={bridge:'active/running',auth:'logged_out'};
const step=(s,p,t)=>observe(s,p,t).state;
test('无流量的健康微信不告警；初次上线静默',()=>{
 let s=step(null,healthy,1000);s=step(s,healthy,4000);assert.equal(s.status,'online');assert.equal(s.sequence,0);assert.deepEqual(s.notifications,[]);
});
test('单次掉线或接口超时不告警；连续不同异常仍触发一次',()=>{
 let s=step(null,healthy,1000);s=step(s,out,31000);assert.equal(s.status,'online');s=step(s,healthy,61000);assert.equal(s.sequence,0);
 s=step(s,out,91000);s=step(s,{...healthy,auth:null,apiError:'timeout'},121000);assert.equal(s.status,'api_error');assert.equal(s.incidents,1);assert.equal(s.notifications.length,1);
});
test('持续离线不刷屏，原因变化仍为同一事件',()=>{
 let s=step(step(null,out,1000),out,31000);for(let i=0;i<10;i++)s=step(s,{bridge:'inactive/dead',auth:null},61000+i*30000);
 assert.equal(s.status,'bridge_down');assert.equal(s.sequence,1);assert.equal(s.incidents,1);assert.equal(s.notifications.length,1);
});
test('连续两次恢复才通知，新一轮掉线独立计数',()=>{
 let s=step(step(null,out,1000),out,31000);s=step(s,healthy,61000);assert.equal(s.status,'logged_out');s=step(s,healthy,91000);
 assert.equal(s.notifications[1].kind,'recovered');assert.equal(s.notifications[1].downSince,31000);assert.equal(s.downSince,undefined);
 s=step(step(s,out,121000),out,151000);assert.equal(s.incidents,2);assert.equal(s.sequence,3);
});
test('区分登录失效、接口异常和桥接停止；文字不含认证信息',()=>{
 assert.equal(classify(out),'logged_out');assert.equal(classify({...healthy,auth:null}),'api_error');assert.equal(classify({bridge:'failed/failed',auth:'logged_in'}),'bridge_down');
 assert.match(formatAlert({id:1,kind:'down',status:'logged_out',at:0,incident:1}),/手机确认/);
});
test('发送前持久化状态，正常投递后后续轮询不重复',async()=>{
 let db=step(null,out,1000),sends=0,logs=[];let now=31000;
 const io={load:()=>db,probe:()=>out,now:()=>now,save:s=>{db=structuredClone(s);},log:e=>logs.push(e),notify:async n=>{
  sends++;assert.equal(db.notifications[0].delivery,'sending');assert.equal(n.attempts,1);return {delivery:'sent',messageId:'test'};
 }};
 await runCheck(io);now=61000;await runCheck(io);assert.equal(sends,1);assert.equal(db.notifications[0].delivery,'sent');assert.equal(logs.filter(e=>e.kind==='down').length,1);
});
test('发送中断或结果不明确时保留诊断、不自动重复投递',async()=>{
 let db=step(step(null,out,1000),out,31000);db.notifications[0].delivery='sending';let sends=0;
 const io={load:()=>db,probe:()=>out,now:()=>61000,save:s=>{db=structuredClone(s);},log:()=>{},notify:async()=>{sends++;return {delivery:'sent'};}};
 await runCheck(io);assert.equal(sends,0);assert.equal(db.notifications[0].delivery,'uncertain');
});
