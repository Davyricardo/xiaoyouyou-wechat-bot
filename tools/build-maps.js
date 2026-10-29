#!/usr/bin/env node
'use strict';
// 配装素材映射表生成脚本（P2）。可重跑，输出 assets/builds/map.json：
//   { source,
//     gear:       { "<splId>": "<Leanny 文件名>" }        splId 在三个部位含义一致时
//     gearBySlot: { head|clothes|shoes: { "<splId>": "<文件名>" } }  重号 splId 按部位分表
//     skill:      { "<代码>": "<Leanny 文件名>" } }
//
// 用法：
//   node tools/build-maps.js                 生成到 src/assets/builds/map.json（= 部署时的 <XYY_BASE>/assets/builds/map.json）
//   node tools/build-maps.js --out <file>    指定输出文件
//   node tools/build-maps.js --leanny <sha>  固定 Leanny 仓库的 commit（默认取 main 当前 HEAD）
//
// 数据来源与推导链（每一步都用真实数据交叉校验，对不上就报错退出，绝不猜）：
//   1. Leanny/splat3  git tree（递归列表）→ 判定哪些图片文件真实存在
//   2. Leanny data/mush/<最新版本>/GearInfo{Head,Clothes,Shoes}.json → splId(Id) → __RowId（= 图片文件名去 .png）
//   3. sendou.ink locales/en/gear.json + game-misc.json → splId → 装备英文名 / 技能代码 → 技能英文名
//   4. Leanny data/language/EUen_full.json 的 CommonMsg/Gear/GearName_* 与 GearPowerName → 内部名 → 英文名
//   5. 用英文名把 (3) 和 (4) 连起来：名字必须唯一且两边完全一致，否则该条目丢弃并计入报告
//
// 装备 splId 在三个部位之间大量重复（同一数字在不同部位是不同装备），
// 所以 gear 表只收「各部位文件名一致」的 splId，重号的进 gearBySlot，运行时用 ensureGear(splId, slot) 取。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const REPO = 'Leanny/splat3';
const RAW = `https://raw.githubusercontent.com/${REPO}`;
const SENDOU_LOCALES = 'https://raw.githubusercontent.com/sendou-ink/sendou.ink/main/locales/en';
// 仓库里的素材根目录，部署时整棵拷到 <XYY_BASE>/assets
const ASSETS = path.join(__dirname, '..', 'src', 'assets');

const UA = 'XiaoYouyou/3.3 (personal splatoon schedule bot; asset map builder)';
const TIMEOUT = 60000;
const MAX_BYTES = 32 * 1024 * 1024;

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(Error('仅支持 HTTPS：' + url));
    const req = https.get(u, { headers: { 'User-Agent': UA }, timeout: TIMEOUT }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Error('HTTP ' + res.statusCode + '：' + url));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (b) => {
        size += b.length;
        if (size > MAX_BYTES) req.destroy(Error('响应过大：' + url));
        else chunks.push(b);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('请求超时：' + url)));
    req.on('error', reject);
  });
}
const fetchJson = async (url) => JSON.parse((await fetchBuffer(url)).toString('utf8'));

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// 从 git tree 里挑出最新游戏版本号：data/mush/<版本>/ 下的目录名，数字最大者。
function latestMushVersion(tree) {
  const versions = new Set();
  for (const { path: p } of tree) {
    const m = /^data\/mush\/(\d+)\/GearInfoHead\.json$/.exec(p);
    if (m) versions.add(m[1]);
  }
  if (!versions.size) throw Error('Leanny tree 里找不到 data/mush/<版本>/GearInfoHead.json');
  return [...versions].sort((a, b) => Number(a) - Number(b)).pop();
}

function parseArgs(argv) {
  const out = { out: path.join(ASSETS, 'builds', 'map.json'), leanny: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--leanny') out.leanny = argv[++i];
    else throw Error('未知参数：' + argv[i]);
  }
  return out;
}

// 同名内部项必须唯一，否则没法用「英文名」当桥梁
function invertUnique(names, label) {
  const map = new Map();
  const dup = [];
  for (const [internal, name] of Object.entries(names)) {
    if (!name) continue;
    if (map.has(name)) {
      dup.push(name);
      map.delete(name);                       // 歧义名直接作废，不碰运气
    } else {
      map.set(name, internal);
    }
  }
  if (dup.length) console.warn(`  ${label}：${dup.length} 个英文名对应多个内部项，已排除（${dup.slice(0, 5).join(' / ')}）`);
  return map;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---- 1. Leanny 仓库快照
  const sha = args.leanny || (await fetchJson(`https://api.github.com/repos/${REPO}/commits/main`)).sha;
  console.log('Leanny commit', sha);
  const tree = (await fetchJson(`https://api.github.com/repos/${REPO}/git/trees/${sha}?recursive=1`)).tree;
  const files = new Set(tree.map((x) => x.path));
  const gearImages = new Set(
    [...files].filter((p) => /^images\/gear\/[^/]+\.png$/.test(p)).map((p) => p.slice('images/gear/'.length))
  );
  const skillImages = new Set(
    [...files].filter((p) => /^images\/skill\/[^/]+\.png$/.test(p)).map((p) => p.slice('images/skill/'.length))
  );
  console.log(`图片文件：gear ${gearImages.size} 张，skill ${skillImages.size} 张`);

  // ---- 2. 装备 splId → __RowId（内部名），分部位
  const version = latestMushVersion(tree);
  console.log('游戏数据版本', version);
  const slots = { head: 'Head', clothes: 'Clothes', shoes: 'Shoes' };
  const gearInfo = {};
  for (const [slot, suffix] of Object.entries(slots)) {
    const rows = await fetchJson(`${RAW}/${sha}/data/mush/${version}/GearInfo${suffix}.json`);
    const byId = new Map();
    for (const r of rows) {
      if (Number.isInteger(r.Id) && typeof r.__RowId === 'string') byId.set(r.Id, r.__RowId);
    }
    gearInfo[slot] = byId;
    console.log(`  ${slot}: ${byId.size} 件（${path.basename(`GearInfo${suffix}.json`)}）`);
  }

  // ---- 3. sendou 的名称表
  const sendouGear = await fetchJson(`${SENDOU_LOCALES}/gear.json`);
  const sendouMisc = await fetchJson(`${SENDOU_LOCALES}/game-misc.json`);

  // ---- 4. Leanny 的英文名（内部名 → 名字），按部位分开，避免同名跨部位串味
  const leannyNames = await fetchJson(`${RAW}/${sha}/data/language/EUen_full.json`);
  const gearNamesBySlot = {
    head: leannyNames['CommonMsg/Gear/GearName_Head'],
    clothes: leannyNames['CommonMsg/Gear/GearName_Clothes'],
    shoes: leannyNames['CommonMsg/Gear/GearName_Shoes'],
  };
  for (const [slot, names] of Object.entries(gearNamesBySlot)) {
    if (!names || typeof names !== 'object') throw Error('EUen_full.json 缺少 GearName_' + slot);
  }
  const skillByEnglish = invertUnique(leannyNames['CommonMsg/Gear/GearPowerName'], 'GearPowerName');

  // ---- 5a. 装备：sendou 的 H_/C_/S_<splId> 与 Leanny 同部位条目按英文名对齐
  const slotPrefix = { head: 'H_', clothes: 'C_', shoes: 'S_' };
  const perSlot = { head: {}, clothes: {}, shoes: {} };
  const gearReport = { checked: 0, nameMatched: 0, nameMismatch: [], imageMissing: [], splIdMissing: [] };
  for (const [slot, prefix] of Object.entries(slotPrefix)) {
    for (const [key, englishName] of Object.entries(sendouGear)) {
      if (!key.startsWith(prefix)) continue;
      const splId = Number(key.slice(prefix.length));
      if (!Number.isInteger(splId)) continue;
      const rowId = gearInfo[slot].get(splId);
      if (!rowId) {
        gearReport.splIdMissing.push({ slot, splId });
        continue;
      }
      gearReport.checked++;
      const leannyName = gearNamesBySlot[slot][rowId.split('_').slice(1).join('_')];
      if (leannyName !== englishName) {
        gearReport.nameMismatch.push({ slot, splId, rowId, sendou: englishName, leanny: leannyName || null });
        continue;                                // 对不上不收录
      }
      gearReport.nameMatched++;
      if (!gearImages.has(rowId + '.png')) {
        gearReport.imageMissing.push({ slot, splId, rowId });
        continue;
      }
      perSlot[slot][splId] = rowId + '.png';
    }
  }

  // 只把「三个部位都指向同一文件名」或「仅一个部位有」的 splId 写进公共 gear 表；
  // 其余 splId 在不同部位是不同装备，写到 gearBySlot 里由运行时按部位取。
  const gearOut = {};
  const ambiguous = [];
  const allIds = new Set(Object.values(perSlot).flatMap((m) => Object.keys(m).map(Number)));
  for (const splId of allIds) {
    const filenames = ['head', 'clothes', 'shoes']
      .map((s) => perSlot[s][splId])
      .filter(Boolean);
    const unique = new Set(filenames);
    if (unique.size === 1) gearOut[splId] = filenames[0];
    else ambiguous.push(splId);
  }

  // 跨部位重号的 splId：按部位分开存，运行时必须带 slot 才能取
  const gearBySlot = { head: {}, clothes: {}, shoes: {} };
  for (const splId of ambiguous) {
    for (const slot of ['head', 'clothes', 'shoes']) {
      if (perSlot[slot][splId]) gearBySlot[slot][splId] = perSlot[slot][splId];
    }
  }

  // ---- 5b. 技能：sendou 代码 → 英文名 → Leanny 内部名 → 图片
  const skillOut = {};
  const skillReport = { sendouCodes: 0, unmatched: [], imageMissing: [], nameMismatch: [] };
  for (const [key, englishName] of Object.entries(sendouMisc)) {
    if (!key.startsWith('ABILITY_')) continue;
    const code = key.slice('ABILITY_'.length);
    skillReport.sendouCodes++;
    const internal = skillByEnglish.get(englishName);
    if (!internal) {
      // 名称不一致时退一步：内部名恰好等于代码本身也算有据可查（Leanny 与 sendou 用同一套代码）
      if (skillImages.has(code + '.png') && leannyNames['CommonMsg/Gear/GearPowerName'][code] === englishName) {
        skillOut[code] = code + '.png';
      } else {
        skillReport.unmatched.push({ code, englishName });
      }
      continue;
    }
    const leannyEnglish = leannyNames['CommonMsg/Gear/GearPowerName'][internal];
    if (leannyEnglish !== englishName) {
      skillReport.nameMismatch.push({ code, englishName, internal, leannyEnglish });
      continue;
    }
    if (!skillImages.has(internal + '.png')) {
      skillReport.imageMissing.push({ code, internal });
      continue;
    }
    skillOut[code] = internal + '.png';
  }

  // ---- 6. 落盘 + 报告
  const map = {
    source: {
      leanny: { repo: REPO, commit: sha, gameVersion: version },
      sendou: { repo: 'sendou-ink/sendou.ink', locales: ['locales/en/gear.json', 'locales/en/game-misc.json'] },
      generatedAt: new Date().toISOString(),
    },
    gear: gearOut,
    gearBySlot,
    skill: skillOut,
  };
  writeAtomic(args.out, JSON.stringify(map, null, 1) + '\n');

  const report = {
    out: args.out,
    gear: {
      entries: Object.keys(gearOut).length,
      ambiguousSplIds: ambiguous.length,
      bySlotEntries: {
        head: Object.keys(gearBySlot.head).length,
        clothes: Object.keys(gearBySlot.clothes).length,
        shoes: Object.keys(gearBySlot.shoes).length,
      },
      ...gearReport,
    },
    skill: {
      entries: Object.keys(skillOut).length,
      ...skillReport,
    },
  };
  console.log(JSON.stringify(report, null, 1));

  // 硬失败：技能表缺项或装备一条都没出来，说明上游结构变了，别产出半张表
  if (!Object.keys(skillOut).length) throw Error('技能表为空，上游数据结构可能已变化');
  if (!Object.keys(gearOut).length) throw Error('装备表为空，上游数据结构可能已变化');
  // 名称对不上的条目是数据侧的不一致，记录下来但不中断（对应运行时降级）
  if (gearReport.nameMismatch.length || skillReport.unmatched.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error('build-maps 失败：' + e.message);
  process.exitCode = 1;
});
