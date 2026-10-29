const sharp=require('sharp'),net=require('./net');
net.fetchBuffer=async()=>sharp({create:{width:30,height:20,channels:4,background:'#55aacc'}}).png().toBuffer();
const {ensure}=require('./sync-assets');
(async()=>{for(let i=0;i<20;i++)await ensure('weapons',{id:process.argv[2]+'-'+i,name:'并发校验',url:'https://example.com/'+i+'.png'});})().catch(e=>{console.error(e);process.exitCode=1;});
