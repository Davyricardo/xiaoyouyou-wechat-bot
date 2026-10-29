#!/usr/bin/env node
'use strict';
// 鲑鱼跑排班图 —— 一次生成，整轮 40h 复用。
//
// 版式对齐参考图：竖版 4:5，左侧「时间 + 4 武器」，右侧地图立绘，行内右下角压头目图（不写字）。
// 头目在游戏里是随机出现，splatoon3.ink 给的是推测值，所以只放图、不写名称/概率。
//
// 缓存：以 5 段排班的 startTime 序列做 key。同一轮内重复调用只返回已有 PNG，不重新合成。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const BASE = process.env.XYY_BASE || '/opt/xiaoyouyou';
const OUT = path.join(BASE, 'cache', 'salmon-schedule');
const ASSETS = path.join(BASE, 'assets');
const SCHEDULE = path.join(BASE, 'cache', 'schedules', 'schedules.json');
const LOCALE = path.join(BASE, 'cache', 'schedules', 'locale.json');

const W = 1080, ROW_H = 270;
const NOW = Number(process.env.XYY_NOW) || Date.now();   // 测试轮换边界用

const LEFT_W = 596;              // 信息栏
const ART_W = W - LEFT_W;        // 484
const PAD = 34;

const WEAPON_SIZE = 138;         // 武器方块
const WEAPON_PITCH = 144;        // 方块间距 6
// 四块整体在左栏内水平居中（不再是左对齐）
const WEAPON_X0 = Math.round((LEFT_W - (WEAPON_SIZE + 3 * WEAPON_PITCH)) / 2);

const file = (id) => String(id).replace(/=+$/, '_').replace(/[^A-Za-z0-9_-]/g, '_') + '.png';

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

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

function coopNodes(payload) {
  // The bot caches splatoon3.ink as {at, data:{data:{...}}}; a raw fetch is {data:{...}}.
  const d = payload?.data?.data || payload?.data || payload;
  return d?.coopGroupingSchedule?.regularSchedules?.nodes || null;
}

// 40 小时一轮意味着：正在跑的那一轮随时可能是列表第一条，也可能刚好换班。
// 已结束的段一律丢掉；剩不到 5 段就重新拉一次，实在不够就画现有的几段。
function futureNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((n) => Date.parse(n.endTime) > NOW);
}

async function fetchFresh() {
  const res = await fetch('https://splatoon3.ink/data/schedules.json', { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('排班拉取失败 HTTP ' + res.status);
  const payload = await res.json();
  const fresh = coopNodes(payload);
  // 写回 net.js 读的同一份缓存（{at, data:原始 payload}），否则这份数据没人用
  fs.mkdirSync(path.dirname(SCHEDULE), { recursive: true });
  const tmp = SCHEDULE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), data: payload }));
  fs.renameSync(tmp, SCHEDULE);
  return fresh || [];
}

async function loadSchedule() {
  const cached = futureNodes(coopNodes(readJson(SCHEDULE)));
  if (cached.length >= 5) return cached.slice(0, 5);
  try {
    const fresh = futureNodes(await fetchFresh());
    if (fresh.length) return fresh.slice(0, 5);
  } catch (e) {
    // 断网/超时/HTTP 非 200：有 1-4 段缓存也画，别整图失败
    if (cached.length) return cached.slice(0, 5);
    throw new Error('排班拉取失败: ' + e.message);
  }
  if (cached.length) return cached.slice(0, 5);   // 网络给空：有 1-4 段缓存也画，别整图失败
  throw new Error('排班数据为空');
}

const locale = (() => {
  const l = readJson(LOCALE);
  return (l && (l.data || l)) || {};
})();

function zhName(kind, id, fallback) {
  return String(locale?.[kind]?.[id]?.name || fallback || '').replace(/[\x00-\x1f]/g, '');
}

// 排班是 40 小时一轮，边界落在 00:00 / 08:00 / 16:00 之间漂移，
// 所以时间一律按北京时间格式化，绝不依赖宿主机时区。

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

function cst(iso) {
  const parts = Object.fromEntries(BJ.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { md: `${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}

function bossSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z]/g, '');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function backgroundSvg(rows, H) {
  // 深绿底 + 鳞片暗纹 + 每行时间/武器框/地图名
  const scale = [];
  for (let y = -20; y < H + 40; y += 46) {
    for (let x = -20; x < LEFT_W + 40; x += 46) {
      const ox = (Math.floor(y / 46) % 2) * 23;
      scale.push(`<circle cx="${x + ox}" cy="${y}" r="21" fill="none" stroke="#ffffff" stroke-opacity="0.02" stroke-width="2"/>`);
    }
  }
  const parts = [];
  parts.push(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`);
  parts.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#14452f"/><stop offset="0.55" stop-color="#0e3624"/><stop offset="1" stop-color="#082418"/>
    </linearGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.45" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.62"/>
    </linearGradient>
  </defs>`);
  parts.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
  parts.push(scale.join(''));

  rows.forEach((r, i) => {
    const y = i * ROW_H;
    // 行分隔（极淡）
    if (i) parts.push(`<line x1="0" y1="${y}" x2="${LEFT_W}" y2="${y}" stroke="#ffffff" stroke-opacity="0.05" stroke-width="2"/>`);

    // 时间
    const t = `${r.start.md} ${r.start.hm} - ${r.end.md} ${r.end.hm}`;
    parts.push(`<text x="22" y="${y + 54}" font-family="Noto Sans CJK SC" font-size="31" font-weight="700" fill="#ffffff">${esc(t)}</text>`);
    // 红色小鱼标（纯装饰，接在时间后面）
    const fx = 430, fy = y + 44;
    parts.push(`<g transform="translate(${fx},${fy})" fill="#ff4d5a">
      <path d="M0 0 q10 -9 22 0 q-10 9 -22 0 z"/><path d="M22 0 l9 -7 v14 z"/></g>`);

    // 武器框
    r.weapons.forEach((w, j) => {
      const x = WEAPON_X0 + j * WEAPON_PITCH;
      parts.push(`<rect x="${x}" y="${y + 68}" width="${WEAPON_SIZE}" height="${WEAPON_SIZE}" rx="24" fill="#0b3323" stroke="#7fe0ad" stroke-opacity="0.5" stroke-width="2"/>`);
    });

  });
  parts.push('</svg>');
  return Buffer.from(parts.join(''));
}

// 头目图做出「贴纸」效果：alpha 先模糊再阈值 → 平滑外扩成奶油色描边，再叠回本体。
// 立绘本身是橙绿场景，不描边的话头目轮廓和背景糊在一起。
function hexRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

async function sticker(buf, size, outline = 6, color = '#fdf3d0', saturate = 1.14) {
  const inner = size - outline * 2;
  const body = await sharp(buf)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .modulate({ saturation: saturate })
    .png()
    .toBuffer();

  const canvas = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: body, left: outline, top: outline }])
    .png()
    .toBuffer();

  // 模糊 + 阈值 = 圆滑的外扩轮廓（比 8 方向错位叠图干净得多）
  const { data: mask } = await sharp(canvas)
    .ensureAlpha()
    .extractChannel('alpha')
    .blur(outline * 0.55)
    .threshold(30)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const [r, g, b] = hexRgb(color);
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = mask[i];
  }
  const outlineLayer = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();

  return sharp(outlineLayer).composite([{ input: body, left: outline, top: outline }]).png().toBuffer();
}

async function ensureAsset(dir, name, url) {
  const target = path.join(dir, name + '.png');
  if (hasAsset(target)) return target;
  if (!url) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  return target;
}

function overlaySvg(rows, H) {
  const parts = [`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`];
  parts.push(`<defs>
    <radialGradient id="bossGlow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0.45" stop-color="#02150e" stop-opacity="0.55"/><stop offset="1" stop-color="#02150e" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0.35" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.78"/>
  </linearGradient></defs>`);
  rows.forEach((r, i) => {
    const y = i * ROW_H;
    parts.push(`<rect x="${LEFT_W}" y="${y + ROW_H - 96}" width="${ART_W}" height="96" fill="url(#shade)"/>`);
    const nx = LEFT_W + ART_W / 2, ny = y + ROW_H - 20;
    // 长名自动缩号，避免顶到左下角头目徽章
    const name = String(r.stage.name || '');
    const nameSize = Array.from(name).length > 8 ? 26 : 30;
    parts.push(`<text x="${nx}" y="${ny}" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="${nameSize}" font-weight="700"
      fill="none" stroke="#04241a" stroke-width="9" stroke-linejoin="round">${esc(name)}</text>`);
    parts.push(`<text x="${nx}" y="${ny}" text-anchor="middle" font-family="Noto Sans CJK SC" font-size="${nameSize}" font-weight="700" fill="#ffffff">${esc(name)}</text>`);
  });
  parts.push('</svg>');
  return Buffer.from(parts.join(''));
}

async function tile(buf, w, h, pad = 0) {
  let img;
  try { img = sharp(buf).trim({ threshold: 8 }); } catch { img = sharp(buf); }
  return img
    .resize(w - pad * 2, h - pad * 2, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

async function cover(buf, w, h) {
  return sharp(buf).resize(w, h, { fit: 'cover', position: 'centre' }).png().toBuffer();
}

async function render(rows) {
  const layers = [];
  // 地图立绘
  for (let i = 0; i < rows.length; i++) {
    const p = path.join(ASSETS, 'salmon', file(rows[i].stage.id));
    if (hasAsset(p)) {
      layers.push({ input: await cover(p, ART_W, ROW_H), left: LEFT_W, top: i * ROW_H });
    }
  }
  // 武器图标
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows[i].weapons.length; j++) {
      const w = rows[i].weapons[j];
      const p = await ensureAsset(path.join(ASSETS, 'salmon-weapons'), file(w.id).replace(/\.png$/, ''), w.url);
      if (!p || !hasAsset(p)) continue;
      layers.push({
        input: await tile(p, WEAPON_SIZE, WEAPON_SIZE, 10),
        left: WEAPON_X0 + j * WEAPON_PITCH + 10,
        top: i * ROW_H + 68 + 10,
      });
    }
  }
  layers.push({ input: overlaySvg(rows, rows.length * ROW_H), left: 0, top: 0 });
  // 头目图（只放图，不写字）：压在奶油底板上，最后合成
  for (let i = 0; i < rows.length; i++) {
    const slug = bossSlug(rows[i].boss.name);
    // 游戏内徽章图优先（badge-*.png），没有就退回立绘
    const badge = path.join(ASSETS, 'boss', 'badge-' + slug + '.png');
    const model = path.join(ASSETS, 'boss', slug + '.png');
    const p = hasAsset(badge) ? badge : (hasAsset(model) ? model : null);
    if (!slug || !p) continue;
    const size = 68;
    const badgeBuf = await sharp(p).trim({ threshold: 8 })
      .resize(size - 10, size - 10, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    // 徽章本身没有描边，压在立绘上会糊：先垫一圈白边 + 深色投影
    const ring = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: badgeBuf, left: 5, top: 5 }])
      .blur(3.4).threshold(26).png().toBuffer();
    const white = await sharp({ create: { width: size, height: size, channels: 4, background: '#ffffff' } })
      .composite([{ input: ring, blend: 'dest-in' }]).png().toBuffer();
    const stickerBuf = await sharp(white).composite([{ input: badgeBuf, left: 5, top: 5 }]).png().toBuffer();
    layers.push({
      input: stickerBuf,
      left: LEFT_W + 12,
      top: i * ROW_H + ROW_H - size - 12,
    });
  }
  return sharp(backgroundSvg(rows, rows.length * ROW_H))
    .composite(layers)
    .png({ compressionLevel: 9, palette: true, quality: 92 })
    .toBuffer();
}

(async () => {
  const force = process.argv.includes('--force');
  const nodes = await loadSchedule();
  const rows = nodes.map((n) => ({
    start: cst(n.startTime),
    end: cst(n.endTime),
    stage: { id: n.setting.coopStage.id, name: zhName('stages', n.setting.coopStage.id, n.setting.coopStage.name) },
    weapons: (n.setting.weapons || []).slice(0, 4).map((w) => ({ id: w.__splatoon3ink_id, name: w.name, url: w.image?.url })),
    boss: { name: n.setting.boss?.name || '' },
  }));

  const fingerprint = nodes.map((n) => [
    n.startTime, n.endTime, n.setting.coopStage.id,
    (n.setting.weapons || []).map((w) => w.__splatoon3ink_id).join(','),
    n.setting.boss?.name || '',
  ].join('~')).join('|');
  const key = crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
  fs.mkdirSync(OUT, { recursive: true });
  const release = acquireLock(OUT);
  const target = path.join(OUT, key + '.png');
  const current = path.join(OUT, 'current.png');

  const meta = {
    key,
    window: { start: nodes[0].startTime, end: nodes[nodes.length - 1].endTime },
    generatedAt: new Date().toISOString(),
    rows: nodes.map((n, i) => ({
      time: `${rows[i].start.md} ${rows[i].start.hm} - ${rows[i].end.md} ${rows[i].end.hm}`,
      startISO: n.startTime, endISO: n.endTime,
      stage: rows[i].stage.name, boss: rows[i].boss.name,
    })),
  };
  const metaFile = path.join(OUT, 'meta.json');
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

    const png = await render(rows);
    // 原子落盘：先写临时文件再 rename，避免桥接在换班瞬间读到半个文件
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, png);
    fs.renameSync(tmp, target);
    const curTmp = current + '.tmp';
    fs.copyFileSync(target, curTmp);
    fs.renameSync(curTmp, current);
    writeMeta();
    // 只保留最近 3 张（当前 + 上一轮 + 余量），别让缓存目录无限长
    try {
      const keep = fs.readdirSync(OUT).filter((n) => /^[0-9a-f]{12}\.png$/.test(n))
        .map((n) => ({ n, at: fs.statSync(path.join(OUT, n)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
      keep.slice(5).forEach((x) => fs.unlinkSync(path.join(OUT, x.n)));
    } catch {}

    console.log(JSON.stringify({ cached: false, key, file: target, current, bytes: png.length }));
  } finally {
    unlock();
  }
})().catch((e) => { console.error('render failed:', e.message); process.exitCode = 1; });
