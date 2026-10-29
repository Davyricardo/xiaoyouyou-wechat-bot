#!/usr/bin/env node
'use strict';
// 祭典卡片：按官方海报版式（三列阵营）排版。
//
// 参考图结构：深灰底 + 顶部「全服祭典」标签与标题胶囊 + 三列阵营（阵营色块 + 立绘 + 队名）
// + 底部时间。素材来自 SplatNet 的 fest.teams[].image（每个阵营一张带 logo 的立绘，256² 透明底）
// 与 fest.teams[].color（官方阵营色）。
//
// 立绘由香橙派预取（assets/festivals/teams/<主题>-<hash8>.png）。任何一张缺了就 ready() 返回 false，
// 调用方退回「贴整张海报」的老版式 —— 宁可版式旧一点，也不要出现「立绘缺失」的破图。
//
// CLI：node fest-poster.js [输出路径]
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('/opt/xiaoyouyou/node_modules/sharp');

const BASE = process.env.XYY_HOME || '/opt/xiaoyouyou';
const W = 1080, H = 762;
// 版式对齐官方海报：左右 20、列间 6、三列等宽；彩色区 102-528，下面接暗色延伸条到 618，
// 队名压在彩色区底部（不是压在暗条上），时间居中最底部。
const PAD = 20, GAP = 6, COL_TOP = 102, COL_BOT = 618, SPLIT = 528;
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
sharp.concurrency(1);

// ---------- 颜色 ----------
function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return t.map((n) => Math.round((n + m) * 255));
}
const hex = (a) => '#' + a.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
// 阵营色是 SplatNet 的墨汁色，比官方海报的印刷色暗一档，提一点亮度再上版面
function vivid(c) {
  const [h, s, v] = rgb2hsv(c.r, c.g, c.b);
  return hex(hsv2rgb(h, Math.min(0.88, s * 1.05), Math.min(0.88, Math.max(0.72, v * 1.25))));
}
function darken(colorHex, k) {
  const n = parseInt(colorHex.slice(1), 16);
  return hex([(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.round(x * k)));
}

// ---------- 时间 ----------
function bj(iso) {
  const t = new Date(Date.parse(iso) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getUTCMonth() + 1)}.${p(t.getUTCDate())} ${WD[t.getUTCDay()]} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

// ---------- 立绘定位 ----------
// 与香橙派 festival-assets.js 的 teamKey() 必须一致：<主题代号>-<url 文件名 hash 前 8 位>
function teamFile(url) {
  if (!url) return null;
  const parts = String(url).split('/');
  const slug = parts[parts.length - 2] || '';
  const hash = String(parts.pop() || '').split('_')[0].slice(0, 8);
  const f = path.join(BASE, 'assets/festivals/teams', `${slug}-${hash}.png`);
  return fs.existsSync(f) ? f : null;
}

// model.teams 里每项：{ name, color:{r,g,b} | '#rrggbb', url }
function ready(model) {
  const teams = (model && model.teams) || [];
  return teams.length > 0 && teams.every((t) => teamFile(t.url));
}

async function renderPoster(model, out) {
  const teams = (model.teams || []).map((t) => ({
    name: t.name,
    color: typeof t.color === 'string' ? t.color : vivid(t.color || { r: 0.5, g: 0.5, b: 0.5 }),
    url: t.url,
  }));
  const slot = (W - PAD * 2 - GAP * (teams.length - 1)) / Math.max(teams.length, 1);
  const svg = [];
  const push = (s) => svg.push(s);
  push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`);
  push(`<style>text{font-family:'Noto Sans CJK SC','Noto Sans CJK JP',sans-serif}</style>`);
  push(`<defs><pattern id="ink" width="132" height="132" patternUnits="userSpaceOnUse">`
    + `<circle cx="66" cy="66" r="38" fill="none" stroke="#000" stroke-opacity="0.10" stroke-width="11"/>`
    + `<circle cx="66" cy="66" r="12" fill="#000" fill-opacity="0.06"/></pattern></defs>`);
  push(`<rect width="${W}" height="${H}" fill="#4b4d4f"/>`);
  push(`<rect width="${W}" height="${H}" fill="url(#ink)"/>`);

  // 顶部：左标签 + 标题胶囊
  const tw = [...String(model.title)].reduce((n, ch) => n + (/[\x20-\x7e]/.test(ch) ? 0.56 : 1) * 36, 0);
  const capW = Math.min(W - 280, tw + 64);
  const capX = (W - capW) / 2 + 46;
  push(`<text x="36" y="66" font-size="27" font-weight="700" fill="#ffe24d">全服祭典:</text>`);
  push(`<rect x="${capX}" y="24" width="${capW}" height="58" rx="29" fill="#161719"/>`);
  push(`<text x="${capX + capW / 2}" y="63" font-size="36" font-weight="700" fill="#f4f7fa" text-anchor="middle">${esc(model.title)}</text>`);

  // 三列：阵营色块（上）+ 暗色延伸条（下），队名压在色块底部
  const overlays = [];
  for (let i = 0; i < teams.length; i++) {
    const t = teams[i];
    const x = PAD + i * (slot + GAP);
    push(`<defs><clipPath id="c${i}"><rect x="${x}" y="${COL_TOP}" width="${slot}" height="${COL_BOT - COL_TOP}" rx="18"/></clipPath></defs>`);
    push(`<g clip-path="url(#c${i})">`);
    push(`<rect x="${x}" y="${COL_TOP}" width="${slot}" height="${SPLIT - COL_TOP}" fill="${t.color}"/>`);
    push(`<rect x="${x}" y="${SPLIT}" width="${slot}" height="${COL_BOT - SPLIT}" fill="${darken(t.color, 0.45)}"/>`);
    push('</g>');
    push(`<text x="${x + slot / 2}" y="${SPLIT - 30}" font-size="50" font-weight="700" fill="#ffffff" text-anchor="middle">${esc(t.name)}</text>`);
    const file = teamFile(t.url);
    if (file) {
      const w = Math.round(slot);
      const buf = await sharp(file)
        .resize({ width: w, height: w, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      overlays.push({ input: buf, left: Math.round(x), top: COL_TOP + 8 });
    }
  }
  // 底部时间
  push(`<text x="${W / 2}" y="694" font-size="47" font-weight="700" fill="#ffe24d" text-anchor="middle">${esc(bj(model.start) + ' — ' + bj(model.end))}</text>`);
  push(`<text x="${W / 2}" y="744" font-size="20" fill="#b9c2cc" text-anchor="middle">小鱿鱿 · 数据 splatoon3.ink · 以游戏内公告为准</text>`);
  push('</svg>');

  const tmp = out + '.tmp';
  await sharp(Buffer.from(svg.join(''))).composite(overlays).png({ compressionLevel: 9 }).toFile(tmp);
  fs.renameSync(tmp, out);
  return out;
}
const esc = (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- CLI ----------
function pickFestival() {
  const raw = JSON.parse(fs.readFileSync(path.join(BASE, 'cache/schedules/festivals.json'), 'utf8'));
  const rec = raw.data || raw;
  const now = Date.now();
  const all = [];
  for (const region of ['JP', 'AP', 'EU', 'US']) {
    for (const n of rec?.[region]?.data?.festRecords?.nodes || []) all.push({ ...n, region });
  }
  const live = all.filter((f) => Date.parse(f.endTime) > now && Date.parse(f.startTime) < Date.parse(f.endTime));
  const f = live.sort((a, b) => (a.region === 'JP' ? -1 : 1) - (b.region === 'JP' ? -1 : 1)
    || Date.parse(a.startTime) - Date.parse(b.startTime))[0];
  if (!f) throw Error('当前没有进行中/未来的祭典');
  let loc = {};
  try { loc = JSON.parse(fs.readFileSync(path.join(BASE, 'cache/schedules/locale.json'), 'utf8')); } catch {}
  const z = loc.data?.festivals?.[f.__splatoon3ink_id] || loc.festivals?.[f.__splatoon3ink_id];
  return {
    id: f.__splatoon3ink_id || f.id,
    title: z?.title || f.title,
    start: f.startTime,
    end: f.endTime,
    teams: (f.teams || []).map((t, i) => ({
      name: z?.teams?.[i]?.teamName || t.teamName,
      color: t.color,
      url: t.image && t.image.url,
    })),
  };
}

// 只有「直接 node fest-poster.js」时才跑 CLI。
// 不能用 require.main === module：`node -e "require('./fest-poster')"` 时这个判断会成立，
// 于是只 require 也会顺手渲染一张图（实测把父进程的 stdout 搞得乱七八糟）。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (invokedDirectly) {
  (async () => {
    const f = pickFestival();
    const out = process.argv[2] || path.join(BASE, 'cache/cards', 'festival-poster.png');
    console.log('场次:', f.id, f.title, '| 立绘齐备:', ready(f));
    await renderPoster(f, out);
    console.log('输出:', out, fs.statSync(out).size, 'bytes');
  })().catch((e) => { console.error('fest-poster failed:', e.message); process.exitCode = 1; });
}

module.exports = { renderPoster, ready, teamFile, pickFestival, bj };
