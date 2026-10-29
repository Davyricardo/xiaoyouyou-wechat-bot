'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loginSocket}=require('./wechat-recovery-worker');
class Socket{
 constructor(events){this.handlers={};this.closed=false;setImmediate(()=>{for(const event of events)this.handlers.message?.({data:JSON.stringify(event)});});}
 addEventListener(k,fn){this.handlers[k]=fn;}
 close(){this.closed=true;this.handlers.close?.();}
}
test('批准后的二维码只处理一次，手机确认和成功按顺序完成',async()=>{
 const seen=[];let socket;
 await loginSocket({timeoutMs:1000,current:()=>true,connect:()=>socket=new Socket([{type:'qr',qrData:'test-only'},{type:'qr',qrData:'refresh'},{type:'phone_confirm'},{type:'phone_confirm'},{type:'login_success'}]),qr:async data=>seen.push(data),phone:async()=>seen.push('phone')});
 assert.deepEqual(seen,['test-only','phone']);assert.equal(socket.closed,true);
});
test('事件被取消时不生成二维码，超时不会自动重复订阅',async()=>{
 let generated=0;
 await assert.rejects(()=>loginSocket({timeoutMs:1000,current:()=>false,connect:()=>new Socket([{type:'qr',qrData:'test'}]),qr:async()=>generated++,phone:async()=>{}}),/事件已结束/);
 assert.equal(generated,0);
 let connections=0;await assert.rejects(()=>loginSocket({timeoutMs:10,current:()=>true,connect:()=>{connections++;return new Socket([]);},qr:async()=>generated++,phone:async()=>{}}),/超时/);
 assert.equal(connections,1);
});
test('二维码发送失败不能报告登录成功',async()=>{
 await assert.rejects(()=>loginSocket({timeoutMs:1000,current:()=>true,connect:()=>new Socket([{type:'qr',qrData:'test'},{type:'login_success'}]),qr:async()=>{throw Error('发送失败');},phone:async()=>{}}),/发送失败/);
});
test('同一微信账号允许不同本地目录后缀，错误扫码账号不能成功',async()=>{
 const {isExpectedUser}=require('./recovery-infrastructure');
 assert.equal(isExpectedUser('wxid_bot_account'),true);assert.equal(isExpectedUser('wxid_bot_account'),true);assert.equal(isExpectedUser('wxid_bot_account'),true);
 for(const id of ['wxid_other_e382','wxid_bot_account',null])assert.equal(isExpectedUser(id),false);
 await assert.rejects(()=>loginSocket({timeoutMs:1000,current:()=>true,connect:()=>new Socket([{type:'login_success',userId:'wxid_other'}]),success:async id=>{if(!isExpectedUser(id))throw Error('wrong account');},qr:async()=>{},phone:async()=>{}}),/wrong account/);
});
