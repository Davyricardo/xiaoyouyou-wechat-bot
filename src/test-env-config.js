'use strict';
// 敏感配置（管理员 IM ID / Telegram chat id）从环境变量或 private/*.env 读取，
// 仓库里不留任何真实身份标识。这里守的是「读得到 / 读不到」两头的明确行为。
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {parseEnv,privateDirs,envFiles,privateEnv,secret,secretList,adminIds,adminTarget,telegramTarget,reset}=require('./env-config');

test('parseEnv：忽略注释/空行/export 前缀，支持引号包裹',()=>{
  const out=parseEnv('# comment\n\nEXPORTED=abc\nexport WITH_EXPORT=def\nQUOTED="ghi"\nSINGLE=\'jkl\'\nNO_VALUE\n =novalue\n');
  assert.deepEqual(out,{EXPORTED:'abc',WITH_EXPORT:'def',QUOTED:'ghi',SINGLE:'jkl'});
  assert.deepEqual(parseEnv(''),{});
  assert.deepEqual(parseEnv(null),{});
});

test('进程环境变量优先；没有时回落到 private/*.env',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xyy-env-test-'));
  test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'notify.env'),'XYY_ADMIN_IM_ID=from-file@im.wechat\nXYY_TELEGRAM_CHAT_ID=1001\n');
  const env={XYY_PRIVATE_DIR:dir,HOME:dir};
  reset();
  assert.equal(envFiles(env).length,1);
  assert.equal(secret('XYY_ADMIN_IM_ID',env),'from-file@im.wechat');
  assert.equal(secret('XYY_TELEGRAM_CHAT_ID',env),'1001');
  assert.equal(secret('MISSING_KEY',env),null);
  // 环境变量优先
  assert.equal(secret('XYY_ADMIN_IM_ID',{...env,XYY_ADMIN_IM_ID:'from-env@im.wechat'}),'from-env@im.wechat');
  // 多个 key 按优先级
  assert.equal(secret(['XYY_LOWPRIO','XYY_ADMIN_IM_ID'],env),'from-file@im.wechat');
  // private 目录缺省的位置：XYY_PRIVATE_DIR > $XYY_HOME/private > $HOME/private
  assert.deepEqual(privateDirs({HOME:'/h'}),['/h/private',path.join(__dirname,'private')]);
  assert.deepEqual(privateDirs({HOME:'/h',XYY_HOME:'/x'}),['/x/private','/h/private',path.join(__dirname,'private')]);
  assert.deepEqual(privateDirs({HOME:'/opt/x/private',XYY_BASE:'/opt/x'}),['/opt/x/private','/opt/x/private/private',path.join(__dirname,'private')]);
  assert.deepEqual(privateEnv(env).XYY_ADMIN_IM_ID,'from-file@im.wechat');
  reset();
});

test('缺少目录不报错（首次启动 / 手工执行时的常态）',()=>{
  const env={XYY_PRIVATE_DIR:path.join(os.tmpdir(),'xyy-env-'+Date.now(),'nope'),HOME:undefined};
  reset();
  assert.deepEqual(envFiles(env),[]);
  assert.deepEqual(privateEnv(env),{});
  assert.equal(secret('XYY_ADMIN_IM_ID',env),null);
  reset();
});

test('列表按逗号/空白分割，空值得空数组',()=>{
  assert.deepEqual(secretList('X',{X:'a@im.wechat,b@im.wechat'}),['a@im.wechat','b@im.wechat']);
  assert.deepEqual(secretList('X',{X:'  a@im.wechat   b@im.wechat '}),['a@im.wechat','b@im.wechat']);
  assert.deepEqual(adminIds({}),[]);
  assert.deepEqual(adminIds({XYY_ADMIN_IM_ID:''}),[]);
});

test('通知目标按配置拼装；缺配置返回 null（调用方跳过而不是发给默认地址）',()=>{
  const env={XYY_ADMIN_IM_ID:'a@im.wechat',XYY_TELEGRAM_CHAT_ID:'2002'};
  assert.equal(adminTarget(env),'weixin:a@im.wechat');
  assert.equal(telegramTarget(env),'telegram:2002');
  assert.equal(adminTarget({XYY_ADMIN_IM_ID:'a@im.wechat',XYY_ADMIN_IM_PLATFORM:'tg'}),'tg:a@im.wechat');
  assert.equal(adminTarget({}),null);
  assert.equal(telegramTarget({}),null);
});
