#!/usr/bin/env node
'use strict';
// sendou.ink 配装卡片渲染器（P3）。
//
// 对外：
//   renderBuildsCard(query) -> {file, bytes, size, weaponName, count}
//     query 可以是武器名（中/英），或者 fetchBuilds 的返回 {weaponName, builds}
//
// 版式（PLAN 第 4 节）：1080×1350，外边距 36，卡片 300×560，间距 24 → 3 列 × 2 行。
//   单卡：标题 26px 粗体（>12 字缩到 21px）→ 次行 16px 灰字「owner · +N · YYYY/M/D」
//         右上武器图标 56×56；三件装备每行：左侧装备图 76×76（圆角），右侧 4 个技能 chip
//         （深色圆角方块 d=46，主技能 2px 暖黄描边，图标 38px）
//   不足 6 条按实际条数排版，不留空卡。
//
// 渲染顺序（三层，保证图标不被文字盖住）：
//   1. 覆盖层 SVG：底色、卡片底、技能圆、占位块、全部文字 → 一次栅格化成 raw
//   2. 图片层：装备图 / 技能图标 / 武器图标，缩放到目标尺寸后按 RGBA 手工合成到 raw 上
//      （比 sharp.composite 少一层 libvips 调用，六卡 ~90 个图层时省一半时间）
//   3. 整张 raw 编码成 PNG
//
// 素材：ensureGear(id, slot)、ensureSkill(code)；缺图一律画占位，不抛错。
// 输出：<XYY_BASE>/cache/cards/builds-<splId>-<8 位 hash>.png，tmp + rename 原子写。
// 数据/素材全失败（拿不到构建数据，或一件素材都拿不到）时抛错，不落半成品。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const BASE = process.env.XYY_BASE || '/opt/xiaoyouyou';
const OUT = path.join(BASE, 'cache', 'cards');
const ASSETS = process.env.XYY_ASSETS
  || (fs.existsSync(path.join(BASE, 'assets', 'builds', 'map.json'))
    ? path.join(BASE, 'assets')
    : path.join(__dirname, 'assets'));

const buildsData = require('./builds-data');
const buildsAssets = require('./builds-assets');

const W = 1080, H = 1350;
const MARGIN = 36, GAP = 24;
const CARD_W = 300, CARD_H = 560, CARD_R = 22;
const COLS = 3, MAX_CARDS = 6;
const COL_X = [MARGIN, MARGIN + CARD_W + GAP, MARGIN + (CARD_W + GAP) * 2];
const GRID_TOP = Math.round((H - (2 * CARD_H + GAP)) / 2);
const ROW_Y = [GRID_TOP, GRID_TOP + CARD_H + GAP];

const BG = '#f0f4ff';
const CARD_BG = '#e6e6fa';
const TEXT = '#1a1a2e';
const MUTED = '#5a5a72';
const PLACEHOLDER = '#cfd3e6';
const ACCENT = '#f5d76e';                       // 主技能高亮描边（暖黄）
const CHIP_BG = '#1b1b28';                      // 技能 chip 深色底
const CHIP_OPACITY = 0.9;
const CHIP_RING = 'rgba(0,0,0,0.18)';           // chip 外描边，和浅紫卡片区分开
const CHIP_EDGE = 'rgba(255,255,255,0.14)';     // chip 内侧很淡的亮边（参考图同款）

// 卡内几何：内宽 300 - 2*12 = 276 = 76 + 8 + 4*46 + 3*2 = 274，余 2px
const CARD_PAD = 12;
const INNER_W = CARD_W - CARD_PAD * 2;
const TITLE_BASELINE = 46;
const META_BASELINE = 74;
const WEAPON_SIZE = 56, WEAPON_TOP = 18;
const GEAR_SIZE = 76, GEAR_RADIUS = 14;
const GEAR_TOP = 118, GEAR_ROW_H = 162;
const SKILL_D = 46, SKILL_GAP = 2, GEAR_SKILL_GAP = 8;
const SKILL_R = SKILL_D / 2;
const SKILL_CORNER = 14;                        // 圆角方块：rx = 30% × 46 ≈ 14
const SKILL_X = CARD_PAD + GEAR_SIZE + GEAR_SKILL_GAP;
const SKILL_SIZE = 38;                          // 图标本体，约 chip 的 82%
const TITLE_SIZES = [26, 21, 17];
const TITLE_SMALL_LEN = 12;
const TITLE_MAX_W = INNER_W - WEAPON_SIZE - 10;  // 给右上武器图标让位

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- 文字排版

// 粗略字宽：CJK/全角按 1em，拉丁/数字按 0.56em。只用于判断放不放得下，不追求精确。
function textWidth(s, size) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) >= 0x2e80 ? size : size * 0.56;
  return w;
}

// 按候选字号从大到小挑第一个放得下的；都放不下就用最小字号截断加省略号。
function fitText(s, maxW, sizes) {
  for (const size of sizes) {
    if (textWidth(s, size) <= maxW) return { text: s, size };
  }
  const size = sizes[sizes.length - 1];
  const chars = [...s];
  while (chars.length > 1 && textWidth(chars.join('') + '…', size) > maxW) chars.pop();
  return { text: chars.join('') + '…', size };
}

// ---------------------------------------------------------------- 单条 build 整形

// updatedAt 是 unix 秒；缺失/异常返回空串，不猜日期
function fmtDate(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '';
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function metaLine(b) {
  const parts = [b.owner];
  if (typeof b.plusTier === 'number' && Number.isFinite(b.plusTier)) parts.push('+' + b.plusTier);
  const date = fmtDate(b.updatedAt);
  if (date) parts.push(date);
  return parts.join(' · ');
}

// abilities = [头, 衣, 鞋] 各 4 个（1 主 + 3 副）。缺的返回 null，由调用方画占位。
function skillCodes(b, row) {
  const codes = Array.isArray(b.abilities[row]) ? b.abilities[row] : [];
  return [0, 1, 2, 3].map((k) => (typeof codes[k] === 'string' && codes[k] ? codes[k] : null));
}

function allSkillCodes(b) {
  return [0, 1, 2].flatMap((row) => skillCodes(b, row));
}

// ---------------------------------------------------------------- 武器图标

// 本地武器图按 catalog 的 id（如 sshooter）命名，配装数据给的是 numericId（40），
// 所以需要一张 numericId → id 表；也接受直接以 splId 命名的文件。
let weaponIdMap = null;
function weaponIconFile(splId) {
  if (weaponIdMap === null) {
    weaponIdMap = new Map();
    try {
      const catalog = JSON.parse(fs.readFileSync(path.join(ASSETS, 'catalog.json'), 'utf8'));
      for (const w of catalog.weapons || []) {
        if (Number.isInteger(w.numericId) && w.id) weaponIdMap.set(w.numericId, w.id);
      }
    } catch { /* 没有 catalog 就只试纯数字文件名 */ }
  }
  const candidates = [String(splId)];
  const id = weaponIdMap.get(splId);
  if (id) candidates.push(id);
  for (const name of candidates) {
    const file = path.join(ASSETS, 'weapons', name + '.png');
    if (hasAsset(file)) return file;
  }
  return null;
}

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function hasAsset(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 64) return false;
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(8);
    try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
    return head.equals(PNG_MAGIC);
  } catch { return false; }
}

// ---------------------------------------------------------------- 图片预处理

const RAW_OPTS = { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } };

// 六张卡里同一张图经常重复（热门配装共用装备/技能），进程内按路径+尺寸缓存缩放结果
const resized = new Map();          // `${file}:${size}` -> Promise<{data,w,h}|null>
const MAX_CACHED = 400;

function remember(key, make) {
  const hit = resized.get(key);
  if (hit) return hit;
  const task = make();
  if (resized.size >= MAX_CACHED) resized.clear();   // 粗暴上限：只防止长时间运行涨内存
  resized.set(key, task);
  return task;
}

function resizeRaw(file, size) {
  return remember(`${file}:${size}`, () => sharp(file)
    .resize(size, size, RAW_OPTS)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => ({ data, w: info.width, h: info.height }))
    .catch(() => null));
}

// 技能图标：Leanny 的 126×126 图四周留白很大（实测主体只占 62%~84%），直接缩到 38 会显得小。
// 先按 alpha 裁掉空白，再按长边缩到 size、补透明边成方形画布——主体实际占满 38px，和参考图一致。
function resizeSkillRaw(file, size) {
  return remember(`skill:${file}:${size}`, () => sharp(file)
    .trim({ threshold: 10 })
    .resize(size, size, RAW_OPTS)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => ({ data, w: info.width, h: info.height }))
    .catch(() => null));
}

// 装备无图：同色圆角块 + 首字。配装数据里没有装备名，优先取 gear-names.json
// （可选，{slot: {splId: name}}），没有就退回部位字（头/衣/鞋），保证不是空块。
let gearNames = null;
function gearName(slot, splId) {
  if (gearNames === null) {
    try {
      gearNames = JSON.parse(fs.readFileSync(path.join(ASSETS, 'builds', 'gear-names.json'), 'utf8'));
    } catch { gearNames = {}; }
  }
  const name = gearNames && gearNames[slot] && gearNames[slot][String(splId)];
  return typeof name === 'string' && name ? name : null;
}

const SLOT_LABEL = { head: '头', clothes: '衣', shoes: '鞋' };

// 一次性把所有卡片需要的素材拿到（Promise.all 并发）；缺的返回 null。
// signal 取消后不再发起新的下载/缩放；已发出的请求照常结束，但结果会被丢弃。
async function collectArt(builds, splId, signal) {
  const iconFile = weaponIconFile(splId);
  const weaponP = iconFile ? resizeRaw(iconFile, WEAPON_SIZE) : Promise.resolve(null);

  const gearP = Promise.all(builds.map((b) => Promise.all([
    buildsAssets.ensureGear(b.gear.head, 'head', signal),
    buildsAssets.ensureGear(b.gear.clothes, 'clothes', signal),
    buildsAssets.ensureGear(b.gear.shoes, 'shoes', signal),
  ]).then((files) => Promise.all(
    files.map((f) => (f && !(signal && signal.aborted) ? resizeRaw(f, GEAR_SIZE) : null))
  ))));

  const skillP = Promise.all(builds.map((b) => Promise.all(
    allSkillCodes(b).map((code) => (code && !(signal && signal.aborted)
      ? buildsAssets.ensureSkill(code, signal).then((f) => (f ? resizeSkillRaw(f, SKILL_SIZE) : null))
      : null))
  )));

  const [weapon, gear, skills] = await Promise.all([weaponP, gearP, skillP]);

  const anyGear = gear.some((row) => row.some(Boolean));
  const anySkill = skills.some((row) => row.some(Boolean));
  // 素材全失败：一件装备图、一个技能图标都没有 → 不生成半成品
  if (!anyGear && !anySkill) {
    throw new Error('配装素材全部不可用（装备图与技能图标均为空）');
  }
  return { weapon, gear, skills };
}

// ---------------------------------------------------------------- 覆盖层 SVG

function overlaySvg(builds, art) {
  const parts = [`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`];
  parts.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);

  builds.forEach((b, i) => {
    const x0 = COL_X[i % COLS];
    const y0 = ROW_Y[Math.floor(i / COLS)];
    parts.push(`<rect x="${x0}" y="${y0}" width="${CARD_W}" height="${CARD_H}" rx="${CARD_R}" fill="${CARD_BG}"/>`);

    // 标题：>12 字先用 21px；仍放不下再降一档，最后截断
    const titleSizes = [...b.title].length > TITLE_SMALL_LEN ? TITLE_SIZES.slice(1) : TITLE_SIZES;
    const title = fitText(b.title, TITLE_MAX_W, titleSizes);
    parts.push(`<text x="${x0 + CARD_PAD}" y="${y0 + TITLE_BASELINE}" font-family="Noto Sans CJK SC"
      font-size="${title.size}" font-weight="700" fill="${TEXT}">${esc(title.text)}</text>`);

    const meta = fitText(metaLine(b), INNER_W, [16, 15, 14]);
    parts.push(`<text x="${x0 + CARD_PAD}" y="${y0 + META_BASELINE}" font-family="Noto Sans CJK SC"
      font-size="16" fill="${MUTED}">${esc(meta.text)}</text>`);

    const slots = ['head', 'clothes', 'shoes'];
    const ids = [b.gear.head, b.gear.clothes, b.gear.shoes];
    for (let row = 0; row < 3; row++) {
      const top = y0 + GEAR_TOP + row * GEAR_ROW_H;
      if (!art.gear[i][row]) {
        // 装备缺图：圆角块 + 首字
        const name = gearName(slots[row], ids[row]);
        const label = esc(name ? [...name][0] : SLOT_LABEL[slots[row]] || '?');
        parts.push(`<rect x="${x0 + CARD_PAD}" y="${top}" width="${GEAR_SIZE}" height="${GEAR_SIZE}"
          rx="${GEAR_RADIUS}" fill="${PLACEHOLDER}"/>`);
        parts.push(`<text x="${x0 + CARD_PAD + GEAR_SIZE / 2}" y="${top + GEAR_SIZE / 2}" dy="0.35em"
          text-anchor="middle" font-family="Noto Sans CJK SC" font-size="34" font-weight="700"
          fill="${MUTED}">${label}</text>`);
      }

      const cy = top + GEAR_SIZE / 2;
      for (let k = 0; k < 4; k++) {
        const cx = x0 + SKILL_X + k * (SKILL_D + SKILL_GAP) + SKILL_R;
        // 深色圆角方块 chip：整块先画（图标层最后覆盖到中心），缺图时直接当底
        parts.push(`<rect x="${cx - SKILL_R}" y="${cy - SKILL_R}" width="${SKILL_D}" height="${SKILL_D}"
          rx="${SKILL_CORNER}" fill="${CHIP_BG}" fill-opacity="${CHIP_OPACITY}"
          stroke="${CHIP_RING}" stroke-width="1"/>`);
        // 参考图里 chip 边缘还有一圈很淡的亮色内描边（外部深色描边负责和浅紫卡片分界）
        parts.push(`<rect x="${cx - SKILL_R + 1}" y="${cy - SKILL_R + 1}"
          width="${SKILL_D - 2}" height="${SKILL_D - 2}" rx="${SKILL_CORNER - 1}"
          fill="none" stroke="${CHIP_EDGE}" stroke-width="1"/>`);
        if (!art.skills[i][row * 4 + k]) {
          // 技能缺图：chip 内画代码文字（白字），不画白底
          const code = skillCodes(b, row)[k];
          const label = esc(code || '?');
          parts.push(`<text x="${cx}" y="${cy}" dy="0.35em" text-anchor="middle"
            font-family="Noto Sans CJK SC" font-size="15" font-weight="700"
            fill="#ffffff">${label}</text>`);
        }
        if (k === 0) {
          // 主技能：2px 暖黄描边（压在 chip 边缘内侧）
          parts.push(`<rect x="${cx - SKILL_R + 1}" y="${cy - SKILL_R + 1}"
            width="${SKILL_D - 2}" height="${SKILL_D - 2}" rx="${SKILL_CORNER}"
            fill="none" stroke="${ACCENT}" stroke-width="2"/>`);
        }
      }
    }
  });
  parts.push('</svg>');
  return Buffer.from(parts.join(''));
}

// ---------------------------------------------------------------- 像素合成

// 圆角矩形 alpha 遮罩（16px 圆角），只算一次
let gearMask = null;
function roundedMask(size, radius) {
  if (gearMask) return gearMask;
  const m = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 到最近圆角圆心的距离；不在圆角区域就是全不透明
      const dx = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0;
      const dy = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0;
      let a = 255;
      if (dx > 0 && dy > 0) {
        const d = Math.hypot(dx, dy);
        a = d <= radius - 1 ? 255 : d >= radius ? 0 : Math.round((radius - d) * 255);
      }
      m[y * size + x] = a;
    }
  }
  gearMask = m;
  return m;
}

// RGBA source-over，把 src 画到 dst 的 (left, top)，可带圆角遮罩
function blit(dst, src, left, top, mask) {
  const { data, w, h } = src;
  const l = Math.round(left), t = Math.round(top);
  for (let y = 0; y < h; y++) {
    const dy = t + y;
    if (dy < 0 || dy >= H) continue;
    for (let x = 0; x < w; x++) {
      const dx = l + x;
      if (dx < 0 || dx >= W) continue;
      const si = (y * w + x) * 4;
      let a = data[si + 3];
      if (a === 0) continue;
      if (mask) {
        a = (a * mask[y * w + x]) / 255;
        if (a === 0) continue;
      }
      const di = (dy * W + dx) * 4;
      if (a === 255) {
        dst[di] = data[si];
        dst[di + 1] = data[si + 1];
        dst[di + 2] = data[si + 2];
        dst[di + 3] = 255;
      } else {
        const ia = 255 - a;
        dst[di] = (data[si] * a + dst[di] * ia) / 255;
        dst[di + 1] = (data[si + 1] * a + dst[di + 1] * ia) / 255;
        dst[di + 2] = (data[si + 2] * a + dst[di + 2] * ia) / 255;
        dst[di + 3] = 255;
      }
    }
  }
}

function compositeImages(dst, builds, art) {
  const mask = roundedMask(GEAR_SIZE, GEAR_RADIUS);
  builds.forEach((b, i) => {
    const x0 = COL_X[i % COLS];
    const y0 = ROW_Y[Math.floor(i / COLS)];
    if (art.weapon) {
      blit(dst, art.weapon, x0 + CARD_W - CARD_PAD - WEAPON_SIZE, y0 + WEAPON_TOP);
    }
    for (let row = 0; row < 3; row++) {
      const top = y0 + GEAR_TOP + row * GEAR_ROW_H;
      const gear = art.gear[i][row];
      if (gear) blit(dst, gear, x0 + CARD_PAD, top, mask);
      const iconTop = top + (GEAR_SIZE - SKILL_SIZE) / 2;
      for (let k = 0; k < 4; k++) {
        const icon = art.skills[i][row * 4 + k];
        if (!icon) continue;
        const iconLeft = x0 + SKILL_X + k * (SKILL_D + SKILL_GAP) + (SKILL_D - SKILL_SIZE) / 2;
        blit(dst, icon, iconLeft, iconTop);
      }
    }
  });
}

// ---------------------------------------------------------------- 对外入口

function hashOf(weaponName, builds) {
  const key = JSON.stringify([
    weaponName,
    builds.map((b) => [b.id, b.title, b.owner, b.plusTier, b.updatedAt, b.gear, b.abilities]),
  ]);
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能没建出来 */ }
    throw e;
  }
}

// signal：调用方超时/取消后置 abort。每一步之间检查，取消后不再继续占 CPU/内存，
// 也不会把半成品的图写进缓存（否则下一次 hash 命中会把这张图发出去）。
function abortedError() {
  return Object.assign(Error('渲染已取消'), { code: 'E_TIMEOUT' });
}

async function renderBuildsCard(query, opts = {}) {
  const signal = opts.signal || null;
  const checkAbort = () => { if (signal && signal.aborted) throw abortedError(); };
  const started = Date.now();
  // 允许直接传 fetchBuilds 的结果，省一次解析/缓存读
  const data = query && typeof query === 'object' && Array.isArray(query.builds)
    ? query
    : await buildsData.fetchBuilds(query);
  checkAbort();

  const builds = data.builds.slice(0, MAX_CARDS);
  if (!builds.length) throw new Error('没有可渲染的配装');
  const { splId } = buildsData.resolveWeapon(data.weaponName);

  const tAssets = Date.now();
  const art = await collectArt(builds, splId, signal);
  checkAbort();
  const assetsMs = Date.now() - tAssets;

  const tRender = Date.now();
  const { data: pixels, info } = await sharp(overlaySvg(builds, art))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== W || info.height !== H) {
    throw new Error(`覆盖层尺寸异常：${info.width}x${info.height}`);
  }
  compositeImages(pixels, builds, art);
  const png = await sharp(pixels, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const renderMs = Date.now() - tRender;

  // 写盘前最后一道检查：超时后不落半成品
  checkAbort();
  const hash = hashOf(data.weaponName, builds);
  const file = path.join(OUT, `builds-${splId}-${hash}.png`);
  atomicWrite(file, png);

  if (process.env.XYY_PROFILE) {
    console.error(JSON.stringify({
      assetsMs, renderMs, totalMs: Date.now() - started, bytes: png.length,
    }));
  }
  return {
    file,
    bytes: png.length,
    size: `${W}x${H}`,
    weaponName: data.weaponName,
    count: builds.length,
  };
}

module.exports = { renderBuildsCard };

// 命令行入口：node builds-card.js <武器名> [--warm]
if (require.main === module) {
  const args = process.argv.slice(2).filter((a) => a !== '--warm');
  const warm = process.argv.includes('--warm');
  (async () => {
    const t0 = Date.now();
    const info = await renderBuildsCard(args.join(' '));
    console.log(JSON.stringify({ ...info, ms: Date.now() - t0 }));
    if (warm) {
      // 预热：再渲染一次，验证进程内素材缓存命中后的耗时
      const t1 = Date.now();
      const again = await renderBuildsCard(args.join(' '));
      console.log(JSON.stringify({ ...again, ms: Date.now() - t1 }));
    }
  })().catch((e) => { console.error('render failed:', e.message); process.exitCode = 1; });
}
