#!/usr/bin/env node
'use strict';
// 对战排班图（一般 / 蛮颓挑战 / 蛮颓开放 / X），2 小时一轮，两块 = 4 小时。
// 一次生成存盘，轮换窗口内查询只发缓存 PNG。
//
// 版式：左右分布 —— 左侧模式徽章 + 模式名 + 规则，右侧两张地图立绘。
// 参考图的美术风格：青绿底 + 细网点、黑底白字时间横幅、地图名白字黑边。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const BASE = process.env.XYY_BASE || '/opt/xiaoyouyou';
const OUT = path.join(BASE, 'cache', 'battle-schedule');
const ASSETS = path.join(BASE, 'assets');
const SCHEDULE = path.join(BASE, 'cache', 'schedules', 'schedules.json');
const LOCALE = path.join(BASE, 'cache', 'schedules', 'locale.json');
const NOW = Number(process.env.XYY_NOW) || Date.now();

const W = 1080;
const PAD = 20;
const BLOCKS = 2;               // 两块 = 4 小时
const BANNER_H = 66;
const ROW_H = 164;
const BLOCK_H = BANNER_H + ROW_H * 4 + 10;
const heightFor = (n) => PAD * 2 + BLOCK_H * n + 16 * (n - 1);

// 地图区几何：左列（徽章 + 模式名 + 药丸）占 272，右侧两张地图等宽并排
const MAP_W = 346;
const MAP_H = 132;
const MAP_GAP = 76;             // 两图之间可见空隙（与合成层步距一致）
const MAP_X = PAD + 272;
const MAP_PITCH = MAP_W + MAP_GAP;
const ICON_SIZE = 56;
const ICON_RING = 76;           // 图标外围半透明深底圆的直径（比图标大 20）
const ICON_CX = MAP_X + MAP_W + MAP_GAP / 2;   // 两图间隙正中
const ICON_CY_OFF = 46 + ICON_SIZE / 2;

// 左列：模式名与规则药丸共用同一左边线（药丸 176 宽，右缘留 4px 到地图区）
const COL_X = PAD + 92;
const PILL_W = 176;



// 定时器和桥接可能同时触发渲染：抢一个锁，别让两个进程同时写 current.png。
function acquireLock(dir) {
  const lock = path.join(dir, '.render.lock');
  for (let i = 0; i < 200; i++) {   // 必须 > 180s，否则崩溃遗留的锁永远等不到 stale 阈值
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lock); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 180000) { fs.unlinkSync(lock); continue; }   // 死锁兜底
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
  throw new Error('render lock busy');
}

const BJ = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// 素材存在、是文件、够大且开头是 PNG 魔数才算可用（不要抛错，也不要删文件）
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function hasAsset(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 64) return false;   // 64 字节以下不可能是有效卡图/图标
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(8);
    try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
    return head.equals(PNG_MAGIC);                     // 截断/非 PNG 一律判缺失
  } catch { return false; }
}
const file = (id) => String(id).replace(/=+$/, '_').replace(/[^A-Za-z0-9_-]/g, '_') + '.png';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function stamp(iso) {
  const p = Object.fromEntries(BJ.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { md: `${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

const locale = (() => { const l = readJson(LOCALE); return (l && (l.data || l)) || {}; })();
const zh = (kind, id, fallback) => String(locale?.[kind]?.[id]?.name || fallback || '').replace(/[\x00-\x1f]/g, '');

const payload = (p) => { const d = p?.data?.data || p?.data || p; return d || {}; };

function nodesOf(p, key) {
  const d = payload(p);
  const n = d?.[key]?.nodes;
  return Array.isArray(n) ? n : [];
}

async function fetchFresh() {
  const res = await fetch('https://splatoon3.ink/data/schedules.json', { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('排班拉取失败 HTTP ' + res.status);
  const body = await res.json();
  // 写回 net.js / salmon-schedule.js 读的同一份缓存，否则这份数据没人用
  fs.mkdirSync(path.dirname(SCHEDULE), { recursive: true });
  const tmp = SCHEDULE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), data: body }));
  fs.renameSync(tmp, SCHEDULE);
  return body;
}

// 2 小时一轮：丢掉已经结束的格子，剩下不足两块就去拉新数据。
function futureBlocks(nodes) {
  return (nodes || []).filter((n) => Date.parse(n.endTime) > NOW);
}

function blockRows(node, bnode, xnode) {
  const rows = [];
  const regular = node?.regularMatchSetting || node?.festMatchSettings?.[0];
  const bankara = (bnode?.bankaraMatchSettings || []).concat(bnode?.festMatchSettings || []);
  const challenge = bankara.find((m) => (m.bankaraMode || m.mode) === 'CHALLENGE');
  const open = bankara.find((m) => (m.bankaraMode || m.mode) === 'OPEN');
  const x = xnode?.xMatchSetting || xnode?.festMatchSettings?.[0];
  const mk = (badge, label, setting) => {
    const rule = setting ? zh('rules', setting.vsRule?.id, setting.vsRule?.name) : '';
    return {
      badge,
      label,
      rule,
      ruleId: setting?.vsRule?.id || '',
      icon: rule ? ruleIcon(rule, setting?.vsRule?.id) : '',
      stages: (setting?.vsStages || []).slice(0, 2).map((s) => ({ id: s.id, name: zh('stages', s.id, s.name), url: s.image?.url })),
    };
  };
  rows.push(mk('badge-regular', '一般比赛', regular));
  rows.push(mk('badge-challenge', '蛮颓挑战', challenge));
  rows.push(mk('badge-open', '蛮颓开放', open));
  rows.push(mk('badge-x', 'X 比赛', x));
  return rows;
}

// 规则强调色：横幅色条与药丸描边共用。与规则图标映射同一套键。
const RULE_COLOR = {
  TURF_WAR: '#f5b915',   // 占地对战
  AREA: '#1fb6c9',       // 真格区域
  LOFT: '#a05cf0',       // 真格塔楼
  GOAL: '#ef8b2c',       // 真格鱼虎对战
  CLAM: '#f2c744',       // 真格蛤蜊
};
const ruleColor = (icon) => RULE_COLOR[icon] || '#7ef0c0';

function backgroundSvg(blocks) {
  const dots = [];
  const H = heightFor(blocks.length);
  for (let y = 6; y < H; y += 14) {
    for (let x = 6 + ((y / 14) % 2) * 7; x < W; x += 14) {
      dots.push(`<circle cx="${x}" cy="${y}" r="1.4" fill="#ffffff" fill-opacity="0.05"/>`);
    }
  }
  const parts = [`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`];
  parts.push(`<defs><linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0" stop-color="#10513f"/><stop offset="1" stop-color="#0a3427"/></linearGradient></defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
  parts.push(dots.join(''));

  blocks.forEach((b, bi) => {
    const top = PAD + bi * (BLOCK_H + 16);
    // 黑色时间横幅
    parts.push(`<rect x="${PAD}" y="${top}" width="${W - PAD * 2}" height="${BANNER_H}" rx="14" fill="#070d0b"/>`);
    parts.push(`<text x="${PAD + 22}" y="${top + 44}" font-family="Noto Sans CJK SC" font-size="30" font-weight="700" fill="#ffffff">${esc(b.time)}</text>`);
    if (!bi) parts.push(`<text x="${W - PAD - 22}" y="${top + 43}" text-anchor="end" font-family="Noto Sans CJK SC" font-size="20" fill="#7fd3ae">对战排班</text>`);
    // 横幅内高亮色条：取本块第一行的规则色，纯色块不做文字
    parts.push(`<rect x="${PAD + 18}" y="${top + BANNER_H - 6}" width="${W - PAD * 2 - 36}" height="6" rx="3" fill="${ruleColor(b.rows[0]?.icon)}"/>`);

    b.rows.forEach((r, ri) => {
      const y = top + BANNER_H + ri * ROW_H;
      if (ri) parts.push(`<line x1="${PAD + 8}" y1="${y}" x2="${W - PAD - 8}" y2="${y}" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>`);
      parts.push(`<text x="${COL_X}" y="${y + 52}" font-family="Noto Sans CJK SC" font-size="26" font-weight="700" fill="#ffffff">${esc(r.label)}</text>`);
      if (r.rule) {
        // 深色底 + 同规则色描边 + 白字；与模式名共用左列
        const rc = ruleColor(r.icon);
        parts.push(`<rect x="${COL_X}" y="${y + 90}" width="${PILL_W}" height="36" rx="18" fill="#0b2a21" fill-opacity="0.85" stroke="${rc}" stroke-width="2"/>`);
        parts.push(`<text x="${COL_X + PILL_W / 2}" y="${y + 116}" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="23" font-weight="700" fill="#ffffff">${esc(r.rule)}</text>`);
      }
    });
  });
  parts.push('</svg>');
  return Buffer.from(parts.join(''));
}

// 素材库只有 25 张地图，轮换里偶尔会出现没抓过的场地：按排班自带的 url 补一张。
async function ensureMap(stage) {
  const target = path.join(ASSETS, 'maps', file(stage.id));
  if (hasAsset(target)) return target;
  if (!stage.url) return null;
  try {
    const res = await fetch(stage.url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    return target;
  } catch { return null; }
}

function overlaySvg(blocks) {
  const H = heightFor(blocks.length);
  const parts = [`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`];
  parts.push(`<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0.4" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.78"/>
  </linearGradient></defs>`);
  blocks.forEach((b, bi) => {
    const top = PAD + bi * (BLOCK_H + 16) + BANNER_H;
    b.rows.forEach((r, ri) => {
      const y = top + ri * ROW_H;
      r.stages.forEach((s, si) => {
        const x = PAD + 272 + si * 422;
        parts.push(`<rect x="${x}" y="${y + 78}" width="346" height="64" fill="url(#shade)"/>`);
        const cx = x + 173, ny = y + ROW_H - 20;
        parts.push(`<text x="${cx}" y="${ny}" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="22" font-weight="700"
          fill="none" stroke="#04241a" stroke-width="6" stroke-linejoin="round">${esc(s.name)}</text>`);
        parts.push(`<text x="${cx}" y="${ny}" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="22" font-weight="700" fill="#ffffff">${esc(s.name)}</text>`);
      });
    });
  });
  parts.push('</svg>');
  return Buffer.from(parts.join(''));
}

async function cover(buf, w, h) {
  return sharp(buf).resize(w, h, { fit: 'cover', position: 'centre' }).png().toBuffer();
}

async function render(blocks) {
  const layers = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const top = PAD + bi * (BLOCK_H + 16) + BANNER_H;
    for (let ri = 0; ri < blocks[bi].rows.length; ri++) {
      const r = blocks[bi].rows[ri];
      const y = top + ri * ROW_H;
      // 模式徽章
      const bp = path.join(ASSETS, 'modes', r.badge + '.png');
      if (hasAsset(bp)) {
        layers.push({
          input: await sharp(bp).resize(58, 58, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
          left: PAD + 14, top: y + 20,
        });
      }
      // 规则图标：压在两图之间（参考图的排法），外围一层半透明深底圆做分离
      const rp = r.icon ? path.join(ASSETS, 'modes', r.icon + '.png') : '';
      if (rp && hasAsset(rp)) {
        const ringLeft = ICON_CX - ICON_RING / 2, ringTop = y + 46 - (ICON_RING - ICON_SIZE) / 2;
        layers.push({
          input: Buffer.from(`<svg width="${ICON_RING}" height="${ICON_RING}"><circle cx="${ICON_RING / 2}" cy="${ICON_RING / 2}" r="${ICON_RING / 2}" fill="#04241a" fill-opacity="0.55"/></svg>`),
          left: ringLeft, top: ringTop,
        });
        layers.push({
          input: await sharp(rp).resize(ICON_SIZE, ICON_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
          left: ICON_CX - ICON_SIZE / 2, top: y + 46,
        });
      }
      // 两张地图
      for (let si = 0; si < r.stages.length; si++) {
        const sp = await ensureMap(r.stages[si]);
        if (!sp) continue;
        layers.push({
          input: await cover(sp, MAP_W, MAP_H),
          left: MAP_X + si * MAP_PITCH, top: y + 8,
        });
      }
    }
  }
  layers.push({ input: overlaySvg(blocks), left: 0, top: 0 });
  return sharp(backgroundSvg(blocks)).composite(layers).png({ compressionLevel: 9, palette: true, quality: 92 }).toBuffer();
}

// 规则图标必须一一对应。以中文名为准（locale 里的官方译名，可人工核对），
// base64 id 只做兜底；两者都不认识就返回 null（宁可不画，也不画错）。
//   VsRule-0 占地对战 → TURF_WAR   VsRule-1 真格区域 → AREA
//   VsRule-2 真格塔楼 → LOFT       VsRule-3 真格鱼虎对战 → GOAL
//   VsRule-4 真格蛤蜊 → CLAM
const RULE_ICON_BY_NAME = {
  '占地对战': 'TURF_WAR',
  '真格区域': 'AREA',
  '真格塔楼': 'LOFT',
  '真格鱼虎对战': 'GOAL',
  '真格蛤蜊': 'CLAM',
};
const RULE_ICON_BY_ID = {
  VnNSdWxlLTA: 'TURF_WAR',
  VnNSdWxlLTE: 'AREA',
  VnNSdWxlLTI: 'LOFT',
  VnNSdWxlLTM: 'GOAL',
  VnNSdWxlLTQ: 'CLAM',
};

function ruleIcon(ruleName, rawId) {
  const byName = RULE_ICON_BY_NAME[String(ruleName || '').trim()];
  if (byName) return byName;
  const id = String(rawId || '').replace(/=+$/, '');
  const byId = RULE_ICON_BY_ID[id];
  if (!byId) console.error('unknown rule', JSON.stringify(ruleName), rawId);
  return byId || null;
}

(async () => {
  const force = process.argv.includes('--force');
  let raw = readJson(SCHEDULE);
  let regular = futureBlocks(nodesOf(raw, 'regularSchedules'));
  if (regular.length < BLOCKS) {
    try {
      raw = await fetchFresh(); regular = futureBlocks(nodesOf(raw, 'regularSchedules'));
    } catch (e) {
      // 断网/超时/HTTP 非 200：已有 1 块旧数据就继续画，别整图失败
      if (!regular.length) throw new Error('对战排班拉取失败: ' + e.message);
    }
  }
  if (!regular.length) throw new Error('对战排班为空');

  const bankara = futureBlocks(nodesOf(raw, 'bankaraSchedules'));
  const xb = futureBlocks(nodesOf(raw, 'xSchedules'));
  const byStart = (arr) => new Map(arr.map((n) => [n.startTime, n]));

  const bMap = byStart(bankara), xMap = byStart(xb);
  const picked = regular.slice(0, BLOCKS);
  const blocks = picked.map((n) => {
    const s = stamp(n.startTime), e = stamp(n.endTime);
    return {
      startISO: n.startTime, endISO: n.endTime,
      // 跨零点的块要带上结束日期，否则「22:00 - 00:00」看不出是哪天
      time: `${s.md} ${s.hm} - ${e.md === s.md ? e.hm : e.md + ' ' + e.hm}`,
      rows: blockRows(n, bMap.get(n.startTime), xMap.get(n.startTime)),
    };
  });

  const fingerprint = blocks.map((b) => b.startISO + '|' + b.rows.map((r) =>
    r.label + r.ruleId + (r.icon || '') + r.stages.map((s) => s.id).join(',')).join('~')).join('||');
  const key = crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);

  fs.mkdirSync(OUT, { recursive: true });
  const release = acquireLock(OUT);
  const target = path.join(OUT, key + '.png');
  const current = path.join(OUT, 'current.png');
  const meta = {
    key, generatedAt: new Date(NOW).toISOString(),
    window: { start: blocks[0].startISO, end: blocks[blocks.length - 1].endISO },
    blocks: blocks.map((b) => ({ time: b.time, startISO: b.startISO, endISO: b.endISO,
      rows: b.rows.map((r) => ({ label: r.label, rule: r.rule, icon: r.icon, stages: r.stages.map((s) => s.name) })) })),
  };
  const metaFile = path.join(OUT, 'meta.json');
  // 命中缓存也要校准 meta：桥接是按 meta 判断有效期的，meta 落后会误判过期
  const writeMeta = () => {
    const tmp = metaFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 1));
    fs.renameSync(tmp, metaFile);
  };

  // 渲染/落盘全程持锁；meta 在锁内写；异常路径也必须释放，且只释放一次
  let released = false;
  const unlock = () => { if (!released) { released = true; release(); } };
  try {
    const sane = fs.existsSync(target) && fs.statSync(target).size > 10000;   // 0 字节/截断视为损坏
    if (!force && sane) {
      writeMeta();
      console.log(JSON.stringify({ cached: true, key, file: target, current }));
      return;
    }

    const png = await render(blocks);
    // 原子落盘：先写临时文件再 rename，避免桥接在换班瞬间读到半个文件
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, target);
    const curTmp = current + '.tmp';
    fs.copyFileSync(target, curTmp);
    fs.renameSync(curTmp, current);
    writeMeta();

    try {
      const keep = fs.readdirSync(OUT).filter((n) => /^[0-9a-f]{12}\.png$/.test(n))
        .map((n) => ({ n, at: fs.statSync(path.join(OUT, n)).mtimeMs })).sort((a, b) => b.at - a.at);
      keep.slice(5).forEach((x) => fs.unlinkSync(path.join(OUT, x.n)));
    } catch {}

    console.log(JSON.stringify({ cached: false, key, file: target, current, bytes: png.length, size: `${W}x${heightFor(blocks.length)}` }));
  } finally {
    unlock();
  }
})().catch((e) => { console.error('render failed:', e.message); process.exitCode = 1; });
