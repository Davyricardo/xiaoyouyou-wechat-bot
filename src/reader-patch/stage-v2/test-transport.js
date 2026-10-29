const test=require('node:test'),assert=require('node:assert/strict');
const {pendingImageButton}=require('./wx-client');
const {CHAT_NAME}=require('./bot-config');
const tree={children:[{role:'label',name:CHAT_NAME+'(2)'},{children:[{role:'text',name:CHAT_NAME,states:['EDITABLE'],text:'\ufffc'},{role:'push-button',name:'Send(S)',bounds:{x:100,y:200,width:80,height:30}}]}]};
test('仅确认指定授权群聊单张图片草稿，发送按钮坐标由即时界面读取',()=>{
 assert.deepEqual(pendingImageButton(tree),{x:140,y:215});
 for(const value of ['', '\ufffc\ufffc','用户草稿','\ufffc备注']){const other=structuredClone(tree);other.children[1].children[0].text=value;assert.throws(()=>pendingImageButton(other));}
 const group=structuredClone(tree);group.children[0].name='其他群(2)';assert.throws(()=>pendingImageButton(group));
 const disabled=structuredClone(tree);disabled.children[1].children[1].states=['DISABLED'];assert.throws(()=>pendingImageButton(disabled));
});
