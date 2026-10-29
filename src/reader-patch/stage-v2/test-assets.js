'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const temp=fs.mkdtempSync(path.join(__dirname,'cache/assets-test-'));
process.env.XYY_HOME=temp;
const sharp=require('sharp'),net=require('./net');let downloads=0,broken=false;
net.fetchBuffer=async()=>{downloads++;if(broken)throw Error('mock offline');return sharp({create:{width:30,height:20,channels:4,background:'#55aacc'}}).png().toBuffer();};
const {ensure}=require('./sync-assets');
(async()=>{
 const item={id:'fixture',name:'验证图片',url:'https://example.com/a.png'};
 const first=await ensure('weapons',item);assert.equal(downloads,1);const filename=path.join(temp,first.file),valid=fs.readFileSync(filename);
 await ensure('weapons',item);assert.equal(downloads,1);
 broken=true;await ensure('weapons',{...item,url:'https://example.com/b.png'});assert.deepEqual(fs.readFileSync(filename),valid);
 broken=false;fs.writeFileSync(filename,'corrupt fixture only');await ensure('weapons',item);assert.equal((await sharp(filename).metadata()).width,30);
 const m=JSON.parse(fs.readFileSync(path.join(temp,'assets/manifest.json')));const actual=crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');assert.equal(m.entries['weapons:fixture'].sha256,actual);
 console.log('素材校验通过：有效缓存复用、失败不覆盖、损坏可恢复、SHA256 精确对应。');
})().catch(e=>{console.error(e);process.exitCode=1;});
