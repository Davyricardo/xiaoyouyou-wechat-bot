'use strict';
const crypto=require('node:crypto');
const WAIT=120000,CONSENT=15*60000;
function begin(state,diagnosis,now){
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
function validRequest(s,request,now){
 const r=s?.recovery;
 return !!(r&&r.phase==='awaiting_approval'&&s.status!=='online'&&now<=r.expiresAt&&request?.code===r.code&&request.incident===r.incident&&
  ['approve','decline'].includes(request.action)&&request.userId==='user@im.wechat'&&request.platform==='weixin'&&
  request.at>=r.createdAt&&request.at<=r.expiresAt&&request.at<=now);
}
module.exports={begin,advance,validRequest,WAIT,CONSENT};
