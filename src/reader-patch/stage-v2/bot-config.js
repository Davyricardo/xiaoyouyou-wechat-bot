'use strict';
const config=require('./bot-config.json');
const CHAT=config.chatId,CHAT_NAME=config.chatName,NICK=process.env.SPLATOON_BOT_NICK||config.botNick;
if(!/^\d+@chatroom$/.test(CHAT)||typeof CHAT_NAME!=='string'||!CHAT_NAME.trim()||typeof NICK!=='string'||!NICK.trim())throw Error('机器人群配置无效');
if(process.env.SPLATOON_CHAT_ID&&process.env.SPLATOON_CHAT_ID!==CHAT)throw Error('环境群 ID 与授权群配置不一致');
function groupHeader(name){return typeof name==='string'&&(name===CHAT_NAME||(name.startsWith(CHAT_NAME)&&/^\s*(?:\(\d+\)|（\d+）)$/.test(name.slice(CHAT_NAME.length))));}
module.exports=Object.freeze({CHAT,CHAT_NAME,NICK,groupHeader});
