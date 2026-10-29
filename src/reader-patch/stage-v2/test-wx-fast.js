const test=require('node:test'),assert=require('node:assert/strict');
const {createSender}=require('./wx-fast');const {editor,pendingImageButton}=require('./wx-client');
const {CHAT,CHAT_NAME}=require('./bot-config');
function fixture(options={}){
 const tree={children:[{role:'frame',name:'Weixin',states:['ACTIVE'],children:[{role:'label',name:CHAT_NAME+'(2)'},{children:[{role:'text',name:CHAT_NAME,states:['EDITABLE'],text:'',bounds:{x:289,y:677,width:972,height:40}},{role:'push-button',name:'Send(S)',states:['DISABLED'],bounds:{x:1165,y:729,width:96,height:32}}]}]}]};
 const messages=[{chatId:CHAT,localId:10,isSelf:false,type:1}],calls=[];let draftType,draftContent,treeReads=0,pendingMessage,delayedReads=0;
 const io={editor,pendingImageButton,find:async()=>options.chats||[{chatId:CHAT,name:CHAT_NAME}],tree:async()=>{treeReads++;return structuredClone(tree);},rows:async()=>{if(pendingMessage&&++delayedReads>=3){messages.push(pendingMessage);pendingMessage=null;}return structuredClone(messages);},open:async()=>{calls.push('open');},
  image:async()=>{calls.push('paste-image');draftType=3;editor(tree).input.text=options.double?'\ufffc\ufffc':'\ufffc';editor(tree).button.states=[];if(options.pasteFail)throw Error('mock tool failure');},
  tool:async(name,args)=>{calls.push(name+':'+args.join(','));if(name==='input'){draftType=1;draftContent=args[0];editor(tree).input.text=args[0];editor(tree).button.states=[];}if(name==='click'&&args[0]==='1213'&&args[1]==='745'){editor(tree).input.text='';editor(tree).button.states=['DISABLED'];const message={chatId:CHAT,localId:11,isSelf:true,type:draftType,content:options.wrongText?'unrelated message':draftContent};if(options.delayed)pendingMessage=message;else if(!options.lag)messages.push(message);if(options.duplicate)messages.push({chatId:CHAT,localId:12,isSelf:true,type:draftType,content:draftContent});}}
 };
 return {tree,calls,messages,get treeReads(){return treeReads;},sender:createSender(io)};
}
test('当前授权群聊直接贴图并点击发送，跳过重新开群和失败重试',async()=>{
 const x=fixture();const r=await x.sender.sendImage(CHAT,'fixture.png');assert.equal(r.confirmation,'database');assert.equal(r.localId,11);assert.equal(x.treeReads,2);assert.ok(!x.calls.includes('open'));assert.equal(x.calls.filter(c=>c==='paste-image').length,1);assert.equal(x.calls.filter(c=>c==='click:1213,745').length,1);
});
test('文字 Unicode 与换行被准确验证，并且只点击一次发送',async()=>{
 const x=fixture(),text='小鱿鱿\n@小鱿鱿 帮助 🦑';const r=await x.sender.sendText(CHAT,text);assert.equal(r.type,1);assert.equal(r.confirmation,'database');assert.equal(x.calls.filter(c=>c==='click:1213,745').length,1);
});
test('DB 回读延迟时依据已清空的草稿确认界面，不再次贴图',async()=>{
 const x=fixture({lag:true});const r=await x.sender.sendImage(CHAT,'fixture.png');assert.equal(r.confirmation,'ui');assert.equal(x.treeReads,3);assert.equal(x.calls.filter(c=>c==='paste-image').length,1);assert.equal(x.calls.filter(c=>c==='click:1213,745').length,1);
});
test('用户草稿、群名冲突、错误群 ID 和其他发送群全部阻止',async()=>{
 const x=fixture();editor(x.tree).input.text='尚未发送的用户文字';await assert.rejects(()=>x.sender.sendImage(CHAT,'fixture.png'));assert.equal(x.calls.length,0);
 for(const chats of [[{chatId:'123@chatroom',name:CHAT_NAME}],[{chatId:CHAT,name:CHAT_NAME},{chatId:'123@chatroom',name:CHAT_NAME}]]){const y=fixture({chats});await assert.rejects(()=>y.sender.sendImage(CHAT,'fixture.png'));assert.equal(y.calls.length,0);}
 const z=fixture();await assert.rejects(()=>z.sender.sendText('123@chatroom','测试'));assert.equal(z.calls.length,0);
});
test('多张图片或粘贴过程异常时不点击、不重试，标记状态不确定',async()=>{
 for(const options of [{double:true},{pasteFail:true}]){const x=fixture(options);await assert.rejects(()=>x.sender.sendImage(CHAT,'fixture.png'),e=>e.uncertain===true);assert.equal(x.calls.filter(c=>c==='paste-image').length,1);assert.equal(x.calls.filter(c=>c==='click:1213,745').length,0);}
});
test('不把其他文字当作确认；多条匹配发送记录停止且不重发',async()=>{
 const wrong=fixture({wrongText:true});const result=await wrong.sender.sendText(CHAT,'帮助回复');assert.equal(result.confirmation,'ui');assert.equal(wrong.treeReads,3);
 const duplicate=fixture({duplicate:true});await assert.rejects(()=>duplicate.sender.sendImage(CHAT,'fixture.png'),e=>e.uncertain===true);assert.equal(duplicate.calls.filter(c=>c==='paste-image').length,1);assert.equal(duplicate.calls.filter(c=>c==='click:1213,745').length,1);
});
test('短暂入库延迟用有界回读确认，无额外界面转储且只发送一次',async()=>{
 const x=fixture({delayed:true});const result=await x.sender.sendImage(CHAT,'fixture.png');assert.equal(result.confirmation,'database');assert.equal(x.treeReads,2);assert.ok(result.timings.readback>=90);assert.equal(result.timings.verifySent,undefined);assert.equal(x.calls.filter(c=>c==='paste-image').length,1);assert.equal(x.calls.filter(c=>c==='click:1213,745').length,1);
});
