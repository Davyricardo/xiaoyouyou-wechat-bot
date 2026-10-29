'use strict';
function action(gate,ack,now){
 if(!gate||!/^XYY-\d+-[0-9a-f]{8}$/.test(gate.code))return null;
 if(gate.phase==='blocked')return 'wait';
 if(gate.phase==='paused'&&Number.isFinite(gate.expiresAt)&&now<gate.expiresAt)return 'wait';
 if((gate.phase==='resume'||gate.phase==='paused'&&now>=gate.expiresAt)&&ack?.code!==gate.code)return 'reset';
 return null;
}
module.exports={action};
