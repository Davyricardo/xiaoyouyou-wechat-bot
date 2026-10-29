'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {CHAT,CHAT_NAME,groupHeader}=require('./bot-config');
test('正式群 Unicode 名称精确匹配，可带成员数，旧群或近似名称拒绝',()=>{
 assert.equal(CHAT,'123456789@chatroom');
 for(const name of [CHAT_NAME,CHAT_NAME+'(2)',CHAT_NAME+' （120）'])assert.equal(groupHeader(name),true);
 for(const name of ['测试群','测试群(2)',CHAT_NAME+'2',CHAT_NAME+'其他(2)',CHAT_NAME+'(2）','Splatoon示例群🦑',null])assert.equal(groupHeader(name),false);
});
test('服务环境与授权群配置不一致时拒绝启动',()=>{
 assert.throws(()=>execFileSync(process.execPath,['-e',"require('./bot-config')"],{cwd:__dirname,env:{...process.env,SPLATOON_CHAT_ID:'123456789@chatroom'},stdio:'pipe'}));
});
