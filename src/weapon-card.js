#!/usr/bin/env node
'use strict';
// 随机武器图卡：上下两条色带（粉 / 绿），各 4 张卡；每张卡 = 主武器立绘 + 名称 + 副武器图标 + 特殊武器图标。
// 参考图的版式：卡内主武器占大部分，名称是深色小标签，副/特殊图标分列卡片底部左右。
//
// 用法：node weapon-card.js <id1> ... <id8>
//   前 4 个 = 粉带（A 队），后 4 个 = 绿带（B 队）
// 输出：cache/cards/random-<hash>.png（该目录在发送白名单里）

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const BASE = process.env.XYY_BASE || '/opt/xiaoyouyou';
const ASSETS = path.join(BASE, 'assets');
const OUT = path.join(BASE, 'cache', 'cards');

const W = 1080, H = 810, PAD = 24, GAP = 16;
const BAND_H = Math.floor((H - PAD * 2 - GAP) / 2);
const CARD_W = Math.floor((W - PAD * 2 - GAP * 3) / 4);
const CARD_H = BAND_H - 24;

// 卡片内版式（见 VISUAL-SPEC 3）：上 22 / 左右 13 / 下 12；名称与武器图间隔 14
const CARD_PAD_TOP = 22, CARD_PAD_X = 13, CARD_PAD_BOTTOM = 12;
const ICON_R = 24, ICON_SIZE = 42;
const ICON_BG_R = ICON_R;                      // 底圈半径 24 = 42px 图标 + 3px 留白
const ICON_BG_SIZE = (ICON_BG_R + 2) * 2;      // 画布 50px：给 2px 描边留 1px 边距，不被裁切
const NAME_SIZE = 22, NAME_GAP = 14, NAME_ASCENT = 19;   // ASCENT ≈ 22px 字号的字面上沿
const NAME_BASE_FROM_BOTTOM = 88;                        // 名称基线距卡片底边（保持原有基线）
const ART_MAX_W = 200, ART_H = 168;

const BANDS = [
  { fill: '#f2b3c9', card: '#fbd9e4', chip: '#2b1a22' },   // 粉
  { fill: '#b4e2c3', card: '#d7f1df', chip: '#16251c' },   // 绿
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

const catalog = JSON.parse(fs.readFileSync(path.join(ASSETS, 'catalog.json'), 'utf8'));
const byId = new Map(catalog.weapons.map((w) => [w.id, w]));
const iconMap = JSON.parse(fs.readFileSync(path.join(ASSETS, 'subspe', 'map.json'), 'utf8'));


// 卡内几何（frameSvg 与图标/文字层共用，保证三层对齐）
const cardTop = (y) => y + 12;
const iconCy = (y) => cardTop(y) + CARD_H - CARD_PAD_BOTTOM - ICON_R;
const nameBaseline = (y) => cardTop(y) + CARD_H - NAME_BASE_FROM_BOTTOM;
const artTopMin = (y) => cardTop(y) + CARD_PAD_TOP;
const artBottomMax = (y) => nameBaseline(y) - NAME_ASCENT - NAME_GAP;

function frameSvg(teams) {
  const parts = [`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`];
  // 2% 噪点（纸感）：单色分形噪声，仅叠加在两条色带上，不改主色
  parts.push(`<defs><filter id="noise" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/>
    <feColorMatrix type="saturate" values="0"/></filter></defs>`);
  BANDS.forEach((b, bi) => {
    const y = PAD + bi * (BAND_H + GAP);
    parts.push(`<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${BAND_H}" rx="26" fill="${b.fill}"/>`);
    parts.push(`<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${BAND_H}" rx="26" filter="url(#noise)" opacity="0.02"/>`);
    for (let i = 0; i < 4; i++) {
      const x = PAD + i * (CARD_W + GAP);
      parts.push(`<rect x="${x}" y="${cardTop(y)}" width="${CARD_W}" height="${CARD_H}" rx="20" fill="${b.card}"/>`);
      // 图标底圈不再画在 frame 上：颜色要按图标明暗自适应，见 iconBackdropSvg()
    }
  });
  // 中缝的分隔装饰
  const my = PAD + BAND_H + GAP / 2;
  parts.push(`<g transform="translate(${W / 2},${my})" fill="#ffffff" fill-opacity="0.9">
    <path d="M-16 -9 L-2 0 L-16 9 Z"/><path d="M16 -9 L2 0 L16 9 Z"/></g>`);
  parts.push('</svg>');
  return Buffer.from(parts.join(''));
}

function nameChipSvg(teams) {
  const parts = [`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`];
  teams.forEach((team, bi) => {
    const b = BANDS[bi];
    const y = PAD + bi * (BAND_H + GAP);
    team.forEach((id, i) => {
      const w = byId.get(id);
      if (!w) return;
      const x = PAD + i * (CARD_W + GAP);
      // 名称放在武器正下方、水平居中：不用色块，靠字重和字距区分层级
      const cx = x + CARD_W / 2;
      const ny = nameBaseline(y);
      parts.push(`<text x="${cx}" y="${ny}" text-anchor="middle" font-family="Noto Sans CJK SC"
        font-size="${NAME_SIZE}" font-weight="700" letter-spacing="0.5" fill="${b.chip}">${esc(w.name)}</text>`);
      parts.push(`<rect x="${cx - 18}" y="${ny + 8}" width="36" height="3" rx="1.5" fill="${b.chip}" fill-opacity="0.35"/>`);
    });
  });
  parts.push('</svg>');
  return Buffer.from(parts.join(''));
}

const ART_CACHE = path.join(BASE, 'cache', 'weapon-art');
async function cachedArt(id, src, w, h) {
  const target = path.join(ART_CACHE, `${id}-${w}x${h}.png`);
  try {
    const st = fs.statSync(target), ss = fs.statSync(src);
    if (st.mtimeMs >= ss.mtimeMs && st.size > 1000) return fs.readFileSync(target);
  } catch {}
  const buf = await contain(src, w, h, false);
  try {
    fs.mkdirSync(ART_CACHE, { recursive: true });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
  } catch {}
  return buf;
}

async function contain(p, w, h, sharpen = false) {
  let img = sharp(p).resize(w, h, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } });
  if (sharpen) img = img.sharpen({ sigma: 0.6 });
  return img.png().toBuffer();
}

// 图标专用：缩放后轻度锐化，让细线图标（洒水器、Tacticooler 这类）的笔画不糊成灰雾。
// 不做对比度拉伸：那套参数是为深底调的，放在统一米白底上会把图标原色压脏。
async function containIcon(p, w, h) {
  return sharp(p)
    .resize(w, h, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .sharpen({ sigma: 0.7 })
    .png()
    .toBuffer();
}

// 图标描边层：同尺寸缩放后把不透明像素整体染成深色（纯色图做底、图标 alpha 用 dest-in 挖出形状）。
// 亮图标压在米白底上时，用它叠 6 个 ±1px 偏移副本形成 1px 细描边。
async function iconOutline(p, w, h) {
  const icon = await sharp(p)
    .resize(w, h, { fit: 'contain', kernel: 'lanczos3', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });
  const buf = await sharp({
    create: { width: icon.info.width, height: icon.info.height, channels: 4, background: '#161e26' },
  })
    .composite([{ input: icon.data, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return { buf, w: icon.info.width, h: icon.info.height };
}

// 图标平均亮度：只用于判断亮图标要不要加描边。结果按文件名缓存在进程内 Map，
// 同一张卡同一图标只算一次（不落盘）。
const ICON_LUM = new Map();
async function iconLuminance(p) {
  const key = path.basename(p);
  if (ICON_LUM.has(key)) return ICON_LUM.get(key);
  const { data, info } = await sharp(p)
    .resize(24, 24, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0, n = 0;
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    if (data[i + 3] <= 40) continue;   // 只统计不透明像素，透明留白不参与
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    n++;
  }
  const lum = n ? sum / n : 0;
  ICON_LUM.set(key, lum);
  return lum;
}

// 底圈统一米白：不再按图标亮度翻深底/浅底（一半深一半浅会让 8 张卡风格割裂）。
// 亮图标靠 1px 深色描边分离，暗图标靠自身颜色对比，见 iconOutline()。
function iconBackdrop() {
  return { fill: '#fbf7ec', fillOpacity: 0.97, stroke: '#1b1207', strokeOpacity: 0.16 };
}

function iconBackdropSvg(c) {
  const s = ICON_BG_SIZE, c0 = s / 2;
  return Buffer.from(`<svg width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${c0}" cy="${c0}" r="${ICON_BG_R}" fill="${c.fill}" fill-opacity="${c.fillOpacity}"
      stroke="${c.stroke}" stroke-opacity="${c.strokeOpacity}" stroke-width="2.5"/></svg>`);
}

async function renderCard(ids) {
  if (!Array.isArray(ids) || ids.length !== 8) throw new Error('need 8 weapon ids');
  const teams = [ids.slice(0, 4), ids.slice(4, 8)];
  const P = process.env.XYY_PROFILE ? () => { const t = process.hrtime.bigint(); return () => Number(process.hrtime.bigint() - t) / 1e6; } : () => () => 0;
  const layers = [];
  const tArt = P();
  // 8 把武器并行处理（之前是串行 await，占了 60% 的时间）
  const jobs = [];
  for (let bi = 0; bi < 2; bi++) {
    for (let i = 0; i < 4; i++) jobs.push({ bi, i, id: teams[bi][i] });
  }
  const arts = await Promise.all(jobs.map(async ({ bi, i, id }) => {
    const art = path.join(ASSETS, 'weapons', id + '.png');
    if (!hasAsset(art)) return null;
    const aw = Math.min(CARD_W - CARD_PAD_X * 2, ART_MAX_W), ah = ART_H;
    const buf = await cachedArt(id, art, aw, ah);
    const m = await sharp(buf).metadata();
    return { bi, i, buf, w: m.width, h: m.height };
  }));
  for (const a of arts) {
    if (!a) continue;
    const y = PAD + a.bi * (BAND_H + GAP);
    const x = PAD + a.i * (CARD_W + GAP);
    // 视觉重心：满宽武器贴上内边距；宽度不足卡宽 60% 的细长武器在图区内垂直居中，避免顶到名称
    const top = a.w < CARD_W * 0.6
      ? Math.round(artTopMin(y) + (artBottomMax(y) - artTopMin(y) - a.h) / 2)
      : artTopMin(y);
    layers.push({ input: a.buf, left: Math.round(x + (CARD_W - a.w) / 2), top });
  }
  for (let bi = 0; bi < 2; bi++) {
    const y = PAD + bi * (BAND_H + GAP);
    for (let i = 0; i < 4; i++) {
      const id = teams[bi][i];
      const w = byId.get(id);
      if (!w) continue;
      const x = PAD + i * (CARD_W + GAP);
      const icons = iconMap[id] || {};
      const slot = [
        { file: icons.sub, cx: x + CARD_PAD_X + ICON_R },
        { file: icons.special, cx: x + CARD_W - CARD_PAD_X - ICON_R },
      ];
      for (const s of slot) {
        if (!s.file) continue;
        const p = path.join(ASSETS, 'subspe', s.file);
        if (!hasAsset(p)) continue;
        // 合成顺序：统一米白底圈 →（亮图标）1px 深色描边 → 图标本体（保留原色）
        layers.push({
          input: iconBackdropSvg(iconBackdrop()),
          left: Math.round(s.cx - ICON_BG_SIZE / 2),
          top: Math.round(iconCy(y) - ICON_BG_SIZE / 2),
        });
        const iconTop = Math.round(iconCy(y) - ICON_SIZE / 2);
        const iconLeft = Math.round(s.cx - ICON_SIZE / 2);
        if (await iconLuminance(p) >= 140) {
          const o = await iconOutline(p, ICON_SIZE, ICON_SIZE);
          const ol = Math.round(s.cx - o.w / 2), ot = Math.round(iconCy(y) - o.h / 2);
          for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            layers.push({ input: o.buf, left: ol + dx, top: ot + dy });
          }
        }
        layers.push({ input: await containIcon(p, ICON_SIZE, ICON_SIZE), left: iconLeft, top: iconTop });
      }
    }
  }
  layers.push({ input: nameChipSvg(teams), left: 0, top: 0 });
  const artMs = tArt();

  const tFrame = P();
  // 文件名带版本：frame 不再画图标底圈，旧缓存里的白圈会让新底圈失效
  const frameFile = path.join(BASE, 'cache', 'weapon-frame-v2.png');
  let frame;
  try { frame = fs.readFileSync(frameFile); } catch { frame = await sharp(frameSvg(teams)).png().toBuffer(); try { fs.writeFileSync(frameFile, frame); } catch {} }
  const frameMs = tFrame();

  const tComp = P();
  const enc = process.env.XYY_ENC || 'true';   // 真彩编码：合成 104ms / 300KB，比调色板快 8 倍
  const base = sharp(frame).composite(layers);
  const png = enc === 'true'
    ? await base.png({ compressionLevel: 6 }).toBuffer()
    : enc === 'pal3'
      ? await base.png({ compressionLevel: 6, palette: true, quality: 85, effort: 3 }).toBuffer()
      : await base.png({ compressionLevel: 6, palette: true, quality: 90, effort: 7 }).toBuffer();
  const compMs = tComp();
  if (process.env.XYY_PROFILE) console.error(JSON.stringify({ artMs: +artMs.toFixed(0), frameMs: +frameMs.toFixed(0), compMs: +compMs.toFixed(0), layers: layers.length, bytes: png.length }));
  fs.mkdirSync(OUT, { recursive: true });
  const key = crypto.createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 24);
  const file = path.join(OUT, 'random-' + key + '.png');
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, png);
  fs.renameSync(tmp, file);
  return { file, bytes: png.length, size: `${W}x${H}` };
}

module.exports = { renderCard };

// 命令行入口（测试/手动生成用；桥接进程内直接 require，省掉 ~530ms 的 node+sharp 启动）
if (require.main === module) {
  renderCard(process.argv.slice(2, 10))
    .then((info) => console.log(JSON.stringify(info)))
    .catch((e) => { console.error('render failed:', e.message); process.exitCode = 1; });
}
