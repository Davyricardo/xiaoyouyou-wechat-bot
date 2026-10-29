'use strict';
const crypto=require('node:crypto');
const {adminIds,adminPlatform}=require('./env-config');
const WAIT=120000,CONSENT=15*60000;
function begin(state,diagnosis,now){
 const current=state.recovery;
 if(current&&current.incident===state.incidents&&current.phase!=='closed')return current;
 const code=`XYY-${state.incidents}-${crypto.randomBytes(4).toString('hex')}`;
 state.recovery={code,incident:state.incidents,phase:'reminders',diagnosis,createdAt:now};
 const first=state.notifications.find(n=>n.kind==='down'&&n.incident===state.incidents);if(first)first.diagnosis=diagnosis;
}
function enqueue(s,kind,now,extra={}){
 const n={id:++s.sequence,kind,status:s.status,at:now,incident:s.incidents,delivery:'pending',attempts:0,...extra};s.notifications.push(n);return n;
}
function advance(s,now,result){
 const r=s.recovery;if(!r)return;
 if(s.status!=='online'&&['declined','failed','expired'].includes(r.phase)&&result?.code===r.code&&result.phase==='reoffer'){
  r.code=`XYY-${r.incident}-${crypto.randomBytes(4).toString('hex')}`;r.createdAt=now;
  if(!r.diagnosis.reloginEligible){r.phase='failed';enqueue(s,'manual_check',now,{code:r.code,diagnosis:r.diagnosis});return;}
  r.phase='awaiting_approval';r.expiresAt=now+CONSENT;
  enqueue(s,'login_offer',now,{code:r.code,diagnosis:r.diagnosis});return;
 }
 if(['closed','declined','failed','expired','verified'].includes(r.phase))return;
 if(s.status==='online'){r.phase='closed';return;}
 if(result?.code===r.code){
  if(result.phase==='declined'){r.phase='declined';enqueue(s,'login_declined',now,{code:r.code});return;}
  if(result.phase==='failed'){
   r.phase='failed';r.failure=result.reason;enqueue(s,'login_failed',now,{code:r.code,reason:result.reason});return;
  }
  if(result.phase==='verified'){r.phase='verified';return;}
  if(['starting','waiting_scan','verifying'].includes(result.phase)){r.phase='login_active';return;}
 }
 if(r.phase==='awaiting_approval'&&now>r.expiresAt){r.phase='expired';return;}
 const first=s.notifications.find(n=>n.kind==='down'&&n.incident===r.incident);
 if(r.phase==='reminders'&&first?.delivery==='sent'&&now-(first.finishedAt||first.at)>=WAIT){
  enqueue(s,'reminder2',now,{code:r.code,diagnosis:r.diagnosis});r.phase='second_reminder';return;
 }
 const second=s.notifications.find(n=>n.kind==='reminder2'&&n.incident===r.incident);
 if(r.phase==='second_reminder'&&second?.delivery==='sent'){
  if(!r.diagnosis.reloginEligible){r.phase='failed';enqueue(s,'manual_check',now,{code:r.code,diagnosis:r.diagnosis});return;}
  r.phase='awaiting_approval';r.expiresAt=now+CONSENT;
  enqueue(s,'login_offer',now,{code:r.code,diagnosis:r.diagnosis});
 }
}
// 「重新登录」这种高危操作只能由配置里的管理员本人批准。
// 管理员 ID 不再写死在代码里（XYY_ADMIN_IM_IDS / XYY_ADMIN_IM_ID，逗号分隔；平台默认 weixin，
// 可用 XYY_ADMIN_IM_PLATFORM 覆盖）；没配置时明确报错并返回 false —— 宁可让审批失败，
// 也不能退化成「谁都能批准」或「没人能批准但看不出来」。
function validRequest(s,request,now,env=process.env){
 const r=s?.recovery;
 const admins=adminIds(env);
 if(!admins.length){
  console.error('recovery-flow: 未配置 XYY_ADMIN_IM_ID(S)，拒绝一切恢复审批');
  return false;
 }
 return !!(r&&r.phase==='awaiting_approval'&&s.status!=='online'&&now<=r.expiresAt&&request?.code===r.code&&request.incident===r.incident&&
  ['approve','decline'].includes(request.action)&&admins.includes(String(request.userId||''))&&request.platform===adminPlatform(env)&&
  request.at>=r.createdAt&&request.at<=r.expiresAt&&request.at<=now);
}
module.exports={begin,advance,validRequest,WAIT,CONSENT};
