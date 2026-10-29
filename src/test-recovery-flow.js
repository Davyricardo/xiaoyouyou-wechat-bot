'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {begin,advance,validRequest,WAIT}=require('./recovery-flow');
const {action}=require('./recovery-gate'),{formatAlert,observe}=require('./wechat-health-monitor');
function fixture(){const s={status:'logged_out',incidents:1,sequence:1,notifications:[{id:1,kind:'down',incident:1,delivery:'sent',finishedAt:1000}]};begin(s,{summary:'微信崩溃后未登录',reloginEligible:true},1000);return s;}
test('两次提醒完成后才询问；等待同意期间没有二维码动作',()=>{
 const s=fixture();advance(s,WAIT,null);assert.equal(s.notifications.length,1);
 advance(s,WAIT+1000,null);assert.equal(s.notifications[1].kind,'reminder2');assert.equal(s.recovery.phase,'second_reminder');
 advance(s,WAIT+2000,null);assert.equal(s.notifications.length,2);
 s.notifications[1].delivery='sent';advance(s,WAIT+3000,null);assert.equal(s.notifications[2].kind,'login_offer');assert.equal(s.recovery.phase,'awaiting_approval');
 advance(s,WAIT+4000,null);assert.equal(s.notifications.length,3);assert.match(formatAlert(s.notifications[2]),/收到同意后才/);
});
test('自然恢复时取消待询问，不再发起登录',()=>{
 const s=fixture();s.status='online';advance(s,WAIT+1000,null);assert.equal(s.recovery.phase,'closed');assert.equal(s.notifications.length,1);
});
test('缺少明确登录失效证据时两次提醒后人工检查，不生成二维码',()=>{
 const s=fixture();s.recovery.diagnosis.reloginEligible=false;advance(s,WAIT+1000);s.notifications[1].delivery='sent';advance(s,WAIT+2000);assert.equal(s.notifications[2].kind,'manual_check');
});
test('通知没有明确成功时不会把两次检查误当作两次提醒',()=>{
 const s=fixture();s.notifications[0].delivery='uncertain';advance(s,WAIT*5);assert.equal(s.notifications.length,1);assert.equal(s.recovery.phase,'reminders');
});
test('确认限于本人、当前事件和有效期，不能复用旧确认',()=>{
 const s=fixture();advance(s,WAIT+1000);s.notifications[1].delivery='sent';advance(s,WAIT+2000);
 const req={code:s.recovery.code,incident:1,action:'approve',userId:'user@im.wechat',platform:'weixin',at:WAIT+3000};
 assert.equal(validRequest(s,req,WAIT+4000),true);
 for(const p of [{code:'XYY-0-00000000'},{incident:0},{userId:'other'},{action:'restart'},{at:0}])assert.equal(validRequest(s,{...req,...p},WAIT+4000),false);
 assert.equal(validRequest(s,req,s.recovery.expiresAt+1),false);s.status='online';assert.equal(validRequest(s,req,WAIT+4000),false);
});
test('拒绝、失败和确认过期只处理一次；不会自动重复二维码',()=>{
 for(const phase of ['declined','failed']){
  const s=fixture();const result={code:s.recovery.code,phase,reason:'超时'};advance(s,5000,result);advance(s,8000,result);assert.equal(s.notifications.length,2);assert.equal(s.recovery.phase,phase);
 }
 const s=fixture();advance(s,WAIT+1000);s.notifications[1].delivery='sent';advance(s,WAIT+2000);advance(s,s.recovery.expiresAt+1);assert.equal(s.recovery.phase,'expired');
});
test('登录期间暂停桥接，恢复或超时只初始化游标一次',()=>{
 const gate={code:'XYY-1-01234567',phase:'paused',expiresAt:5000};assert.equal(action(gate,null,1000),'wait');assert.equal(action(gate,null,6000),'reset');
 gate.phase='resume';assert.equal(action(gate,null,1000),'reset');assert.equal(action(gate,{code:gate.code},1000),null);gate.phase='finished';assert.equal(action(gate,null,1000),null);
});
test('二维码步骤结束前不把已登录但未验证的状态报告为恢复',()=>{
 const s=observe(null,{bridge:'active/running',auth:'logged_out'},1).state;
 const next=observe(s,{bridge:'active/running',auth:'logged_in',recovering:true},2).state;assert.notEqual(next.status,'online');
});
test('过期后只在本人主动要求时重新询问，生成新的事件码',()=>{
 const s=fixture(),old=s.recovery.code;s.recovery.phase='expired';advance(s,900000);assert.equal(s.notifications.length,1);
 advance(s,910000,{code:old,phase:'reoffer'});assert.equal(s.recovery.phase,'awaiting_approval');assert.notEqual(s.recovery.code,old);assert.equal(s.notifications[1].kind,'login_offer');
});
