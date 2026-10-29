#!/usr/bin/env node
'use strict';
// P2 自测：真实素材下载 + 断网降级。临时产物只落在调用方给的目录。
// 用法：node test-p2.js <workdir>

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const work = path.resolve(process.argv[2] || '/tmp/p2');
const repo = path.resolve(__dirname, '..');
const out = [];
const log = (s) => { out.push(s); console.log(s); };

function freshCopy() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'assets', 'builds'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'src/assets/builds/map.json'), path.join(work, 'assets', 'builds', 'map.json'));
  return path.join(work, 'assets');
}

(async () => {
  // ---- 0. 真实数据：fetchBuilds('.52加仑') 第一条
  const data = require(path.join(repo, 'src/builds-data.js'));
  const { builds, weaponName } = await data.fetchBuilds('.52加仑');
  const b = builds[0];
  log(`# 配装样本`);
  log(`weapon=${weaponName} buildId=${b.id} title=${JSON.stringify(b.title)} owner=${b.owner}`);
  log(`gear=${JSON.stringify(b.gear)}`);
  log(`abilities=${JSON.stringify(b.abilities)}`);

  // ---- 1. 全部 ensure*（每个阶段用一份全新素材目录，保证确实走下载）
  const assets1 = freshCopy();
  process.env.XYY_ASSETS = assets1;
  const ensureA = require(path.join(repo, 'src/builds-assets.js'));

  const slots = [['head', b.gear.head], ['clothes', b.gear.clothes], ['shoes', b.gear.shoes]];
  const skillCodes = [];
  for (const row of b.abilities) for (const c of row) if (!skillCodes.includes(c)) skillCodes.push(c);
  const allSkillCalls = b.abilities.flat();

  const t0 = Date.now();
  const gearRes = await Promise.all(slots.map(([slot, id]) => ensureA.ensureGear(id, slot)));
  const skillRes = await Promise.all(allSkillCalls.map((c) => ensureA.ensureSkill(c)));
  const elapsed = Date.now() - t0;

  log(`\n# 素材下载（并发出动，耗时 ${elapsed}ms）`);
  let gearOk = 0, gearBytes = 0;
  slots.forEach(([slot, id], i) => {
    const p = gearRes[i];
    const bytes = p ? fs.statSync(p).size : 0;
    if (p) { gearOk++; gearBytes += bytes; }
    log(`gear ${slot.padEnd(7)} splId=${String(id).padEnd(6)} -> ${p || 'null'} ${bytes ? bytes + ' bytes' : ''}`);
  });
  let skillOk = 0, skillBytes = 0;
  allSkillCalls.forEach((code, i) => {
    const p = skillRes[i];
    const bytes = p ? fs.statSync(p).size : 0;
    if (p) { skillOk++; skillBytes += bytes; }
    log(`skill ${code.padEnd(4)} -> ${p ? path.basename(p) : 'null'} ${bytes ? bytes + ' bytes' : ''}`);
  });
  log(`\n合计：装备 ${gearOk}/3 可下载（${gearBytes} bytes），技能 ${skillOk}/${allSkillCalls.length} 可下载（${skillBytes} bytes），去重技能 ${new Set(skillCodes).size} 种`);
  log(`素材目录文件数：gear ${fs.readdirSync(path.join(assets1, 'builds', 'gear')).length}，skill ${fs.readdirSync(path.join(assets1, 'builds', 'skill')).length}`);

  // ---- 2. 缓存命中：第二次调用应直接返回、不产生新文件
  const before = fs.statSync(gearRes[0]).mtimeMs;
  const again = await ensureA.ensureGear(b.gear.head, 'head');
  log(`\n缓存命中：same=${again === gearRes[0]} mtime未变=${fs.statSync(again).mtimeMs === before}`);

  // ---- 3. 断网模拟：改 hosts 指向不可达地址做不到（不能改系统），这里用无效域名 + 缺映射两种方式
  //      3a. 无效域名：子进程里把 raw.githubusercontent.com 解析到不可达 IP
  //      3b. 缺映射：从 map.json 删掉该条目
  const assets2 = path.join(work, 'assets-offline');
  fs.mkdirSync(path.join(assets2, 'builds'), { recursive: true });
  const offlineMap = JSON.parse(fs.readFileSync(path.join(assets1, 'builds', 'map.json'), 'utf8'));
  offlineMap.gear = {};                       // 3b：清空公共 gear 表
  offlineMap.gearBySlot = {};                 //     并清空按部位表 → 映射缺失
  fs.writeFileSync(path.join(assets2, 'builds', 'map.json'), JSON.stringify(offlineMap));

  const probe = `
    const a = require(${JSON.stringify(path.join(repo, 'src/builds-assets.js'))});
    (async () => {
      const g = await a.ensureGear(${b.gear.head}, 'head');
      const s = await a.ensureSkill('OG');
      console.log(JSON.stringify({ gear: g, skill: s }));
    })().catch((e) => { console.log(JSON.stringify({ threw: e.message })); });
  `;
  // 3a：DNS 不可达（用 hosts 覆盖不现实，这里把下载域名改写为不可解析域名）
  const noNet = path.join(work, 'no-net');
  fs.mkdirSync(noNet, { recursive: true });
  const stub = path.join(noNet, 'dns-stub.js');
  fs.writeFileSync(stub, `
    const dns = require('node:dns');
    dns.lookup = (host, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; }
      process.nextTick(() => cb(Object.assign(new Error('mock DNS failure'), { code: 'ENOTFOUND' })));
    };
    require(${JSON.stringify(path.join(repo, 'src/builds-assets.js.tmp-probe.js'))});
  `);
  // 把探针写到 noNet 下，避免污染仓库
  fs.writeFileSync(path.join(repo, 'src/builds-assets.js.tmp-probe.js'), probe);
  fs.writeFileSync(path.join(noNet, 'run-offline.js'), `
    const dns = require('node:dns');
    dns.lookup = function (host, opts, cb) {
      if (typeof opts === 'function') { cb = opts; }
      process.nextTick(() => cb(Object.assign(new Error('mock DNS failure'), { code: 'ENOTFOUND' })));
    };
    ${probe}
  `);
  let offlineOut;
  try {
    offlineOut = execFileSync(process.execPath, [path.join(noNet, 'run-offline.js')], {
      env: { ...process.env, XYY_ASSETS: assets1 },      // 用真实 map.json，但网络不可达
      encoding: 'utf8',
      timeout: 60000,
    });
  } finally {
    fs.rmSync(path.join(repo, 'src/builds-assets.js.tmp-probe.js'), { force: true });
    fs.rmSync(stub, { force: true });
  }
  log(`\n# 断网模拟（DNS 解析失败，真实 map.json）\n${offlineOut.trim()}`);

  const missingOut = execFileSync(process.execPath, ['-e', probe], {
    env: { ...process.env, XYY_ASSETS: assets2 },
    encoding: 'utf8',
    timeout: 60000,
  });
  log(`# 映射缺失模拟（map.json 无该 splId）\n${missingOut.trim()}`);

  // ---- 4. map.json 条目数
  const map = JSON.parse(fs.readFileSync(path.join(repo, 'src/assets/builds/map.json'), 'utf8'));
  log(`\n# map.json`);
  log(`gear（三部位同名的公共条目）: ${Object.keys(map.gear).length}`);
  log(`gearBySlot: head ${Object.keys(map.gearBySlot.head).length} / clothes ${Object.keys(map.gearBySlot.clothes).length} / shoes ${Object.keys(map.gearBySlot.shoes).length}`);
  log(`skill: ${Object.keys(map.skill).length}`);
  log(`source commit: ${map.source.leanny.commit} (mush ${map.source.leanny.gameVersion})`);

  // 3a 的结果判定
  const offline = JSON.parse(offlineOut.trim().split('\n').pop());
  const missing = JSON.parse(missingOut.trim().split('\n').pop());
  log(`\n判定：断网返回 null = ${offline.gear === null && offline.skill === null && !('threw' in offline)}；映射缺失返回 null = ${missing.gear === null && missing.skill === null && !('threw' in missing)}`);
  fs.writeFileSync(path.join(work, 'result.log'), out.join('\n'));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
