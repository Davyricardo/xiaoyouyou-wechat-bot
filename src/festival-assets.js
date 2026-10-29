#!/usr/bin/env node
'use strict';
// 香橙派侧：预取【全部】祭典海报。
//
// 背景（2026-10-23 调研确认）：
//   斯普拉遁 3 自 2024 年 Grand Festival 之后停止新内容更新，祭典改为复刻轮换，
//   而每个季节槽位只有两个主题在 ABAB 交替（Inkipedia: Special Splatfest）。
//   也就是说主题集合已经封闭，不会再出现第 28 个主题——可以一次全抓，之后纯本地。
//
// 为什么要预取：海报在 assets.splatoon3.ink（和 splatoon3.ink 不同域名），阿里云两者都连不上，
// 抓不到就画空占位块（日志 "asset placeholder festivals ... 数据源连接超时"）。
//
// 与旧版（只抓「进行中 + 未来两周」）的区别：
//   1. 不再按时间过滤，遍历 4 个地区的全部 festRecords；
//   2. 按 URL 去重 —— 复刻场次沿用原主题的同一张图（实测 juea-maple 被 2023/2025 两场共用），
//      所以 30 场 × 4 区 = 120 条 manifest 条目，实际只有 27 个文件；
//   3. 每个 region 的 __splatoon3ink_id 都单独写一条（阿里云按 kind:id 查表，JP/AP 的 id 不同）。
//
// 尺寸与阿里云 sync-assets.ensure() 对非武器素材的处理保持一致（width 1080），
// 否则两边算出的 sha256 不同，会反复重下。
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const sharp = require('sharp');

const DATA = process.env.XYY_PI_DATA || '/home/user/splatoon-data';
const OUT = path.join(DATA, 'fest-assets');
const WIDTH = 1080;
const REGIONS = ['JP', 'AP', 'EU', 'US'];
const LOCK = path.join(OUT, '.lock');

sharp.concurrency(1);

function fetchBuffer(url, limit = 12e6, redirects = 4) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(Error('仅支持 HTTPS'));
    const req = https.get(u, { headers: { 'User-Agent': 'XiaoYouyou/3.3 (festival prefetch)' }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && redirects > 0) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, u).href, limit, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(Error('HTTP ' + res.statusCode)); }
      let size = 0; const chunks = [];
      res.on('data', (b) => {
        size += b.length;
        if (size > limit) req.destroy(Error('图片超过大小限制'));
        else chunks.push(b);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('连接超时')));
    req.on('error', reject);
  });
}

// URL 里的目录名就是主题代号（juea-maple / j-chocolate ...），复刻场次共用同一个代号
function slugOf(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[parts.length - 2] || '';
  } catch { return ''; }
}

// 遍历四个地区的全部场次，按 URL 归组
function collect(records) {
  const byUrl = new Map();   // url -> { slug, ids:[{id,region,name,start,end}], first, teams:Map }
  for (const region of REGIONS) {
    for (const node of records?.[region]?.data?.festRecords?.nodes || []) {
      const id = node.__splatoon3ink_id || node.id;
      const url = node.image?.url;
      if (!id || !url) continue;
      const start = node.startTime || '';
      if (!byUrl.has(url)) byUrl.set(url, { url, slug: slugOf(url), ids: [], first: start, teams: new Map() });
      const g = byUrl.get(url);
      g.ids.push({ id, region, name: node.title, start, end: node.endTime });
      if (start && (!g.first || start < g.first)) g.first = start;
      // 阵营立绘：卡片按官方海报版式排三列时要用的素材。
      // 同一主题被复刻时 url 不变，所以按 url 去重即可。
      for (const t of node.teams || []) {
        const tu = t.image?.url;
        if (!tu) continue;
        const key = teamKey(tu);
        if (!g.teams.has(key)) g.teams.set(key, { key, url: tu, slug: slugOf(tu) });
      }
    }
  }
  return byUrl;
}

// 阵营立绘文件名：<主题代号>-<内容 hash 前 8 位>。阿里云侧 fest-poster.js 按同一规则找文件。
function teamKey(url) {
  const slug = slugOf(url);
  const hash = String(url.split('/').pop() || '').split('_')[0].slice(0, 8);
  return slug + '-' + hash;
}

// 轮换记录：只陈述事实——每个主题在数据里的历次出场日期，以及相邻两次的间隔。
//
// 不要按月份猜「哪个主题属于哪个季节」：2023-01 的 Spicy vs Sweet vs Sour（juea-taste）
// 和 FrostyFest 同月，但它是普通祭典。季节归属只在 docs 里按 Inkipedia 的表说明。
function rotation(byUrl) {
  const out = [];
  for (const g of byUrl.values()) {
    const runs = [...new Set(g.ids.map((i) => (i.start || '').slice(0, 10)).filter(Boolean))].sort();
    if (runs.length < 2) continue;              // 只列「已经复刻过」的主题
    const span = Date.parse(runs[runs.length - 1]) - Date.parse(runs[0]);
    out.push({
      slug: g.slug,
      title: g.ids[0]?.name,
      runs,
      periodDays: Math.round(span / (runs.length - 1) / 86400000),
    });
  }
  return out.sort((a, b) => a.runs[0].localeCompare(b.runs[0]));
}

function lock() {
  fs.mkdirSync(OUT, { recursive: true, mode: 0o755 });
  for (let i = 0; i < 50; i++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const pid = Number(fs.readFileSync(LOCK, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') fs.unlinkSync(LOCK); } }
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  return false;
}

async function main() {
  if (!lock()) { console.error('另一个 festival-assets 正在跑，跳过本轮'); return; }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'festivals.json'), 'utf8'));
    const records = raw.data || raw;                    // 兼容 {at,data} 包装与裸 payload
    const byUrl = collect(records);
    console.log('全部祭典海报:', byUrl.size, '张（覆盖', [...byUrl.values()].reduce((n, g) => n + g.ids.length, 0), '条场次记录）');

    const entries = {};
    const existing = new Map();   // slug -> {file, sha256, bytes}
    let fetched = 0, reused = 0, failed = 0;

    // 先把已经抓好的登记进 existing，避免重复下载
    for (const f of fs.readdirSync(OUT)) {
      if (!f.endsWith('.png')) continue;
      existing.set(f.replace(/\.png$/, ''), { file: 'assets/festivals/' + f });
    }

    const order = [...byUrl.values()].sort((a, b) => (a.first || '').localeCompare(b.first || ''));
    for (const g of order) {
      if (!g.slug) { console.error('  跳过：URL 解析不出主题代号', g.url); failed++; continue; }
      const file = 'assets/festivals/' + g.slug + '.png';
      const dest = path.join(OUT, g.slug + '.png');
      let buf = null;
      if (existing.has(g.slug)) {
        // 已抓过且能解码就直接复用，别每次同步都重下
        try {
          const meta = await sharp(dest).metadata();
          if (meta.width && meta.height) { buf = fs.readFileSync(dest); reused++; }
        } catch { buf = null; }
      }
      if (!buf) {
        try {
          const src = await fetchBuffer(g.url);
          buf = await sharp(src).resize({ width: WIDTH, withoutEnlargement: true }).png().toBuffer();
          const meta = await sharp(buf).metadata();
          if (!meta.width || !meta.height) throw Error('图片无效');
          const tmp = dest + '.tmp';
          fs.writeFileSync(tmp, buf); fs.renameSync(tmp, dest);
          fetched++;
          console.log('  抓取', g.slug, meta.width + 'x' + meta.height, Math.round(buf.length / 1024) + 'KB',
            '(' + g.ids.length + ' 场)');
        } catch (e) {
          failed++;
          console.error('  失败', g.slug, e.message);
          // 失败就沿用旧文件（如果有），宁可给旧图也别给空块
          if (fs.existsSync(dest)) { buf = fs.readFileSync(dest); console.error('    沿用旧文件', g.slug); }
        }
      }
      if (!buf) continue;
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const rec = { name: g.ids[0]?.name, url: g.url, file, sha256, bytes: buf.length, slug: g.slug, first: g.first };
      for (const it of g.ids) entries['festivals:' + it.id] = { ...rec, id: it.id, name: it.name, region: it.region, start: it.start };
    }

    // 阵营立绘：卡片按官方海报版式排三列时要用。立绘本身 256²，不缩放（渲染时再按列宽 resize）。
    const teamDir = path.join(OUT, 'teams');
    fs.mkdirSync(teamDir, { recursive: true, mode: 0o755 });
    const teams = {};
    const seen = new Set();
    let tFetched = 0, tReused = 0, tFailed = 0;
    for (const g of order) {
      for (const t of g.teams.values()) {
        if (seen.has(t.key)) continue;
        seen.add(t.key);
        const dest = path.join(teamDir, t.key + '.png');
        let buf = null;
        if (fs.existsSync(dest)) { buf = fs.readFileSync(dest); tReused++; }
        if (!buf) {
          try {
            const src = await fetchBuffer(t.url);
            const meta = await sharp(src).metadata();
            if (!meta.width || !meta.height) throw Error('图片无效');
            const png = await sharp(src).png().toBuffer();
            fs.writeFileSync(dest + '.tmp', png);
            fs.renameSync(dest + '.tmp', dest);
            buf = png; tFetched++;
            console.log('  立绘', t.key, meta.width + 'x' + meta.height, Math.round(png.length / 1024) + 'KB');
          } catch (e) {
            tFailed++;
            console.error('  立绘失败', t.key, e.message);
          }
        }
        if (!buf) continue;
        teams[t.key] = {
          url: t.url, file: 'assets/festivals/teams/' + t.key + '.png',
          sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length,
        };
      }
    }
    for (const f of fs.readdirSync(teamDir)) {
      if (f.endsWith('.png') && !teams[f.replace(/\.png$/, '')]) {
        fs.unlinkSync(path.join(teamDir, f)); console.log('  清理立绘', f);
      }
    }
    console.log(`立绘 ${Object.keys(teams).length} 张：新增 ${tFetched} / 复用 ${tReused} / 失败 ${tFailed}`);

    // 清理：只删「曾经由本脚本生成、现在已不在全部场次里」的文件。
    // 现在主题集合已封闭，正常情况下一个都不会删。
    const keep = new Set(Object.values(entries).map((e) => path.basename(e.file)));
    for (const f of fs.readdirSync(OUT)) {
      // 注意必须拼全路径：readdirSync 返回的是文件名，旧版这里直接 unlink(f) 会以 cwd 为基准
      if (f.endsWith('.png') && !keep.has(f)) { fs.unlinkSync(path.join(OUT, f)); console.log('  清理', f); }
    }

    // 内容没变就不重写 —— at 字段每次都变，否则 sync 侧算出的 hash 永远不等，
    // 「7 天无变化就跳过推送」那层保护会形同虚设。
    // 比较时必须只比「内容体」：带上 at 或者换一种键顺序，字符串就永远不相等。
    const writeIfChanged = (name, body, core) => {
      const file = path.join(OUT, name);
      let prevCore = null;
      try { prevCore = JSON.stringify(core(JSON.parse(fs.readFileSync(file, 'utf8')))); } catch {}
      const nextCore = JSON.stringify(core(body()));
      if (prevCore === nextCore) return false;
      fs.writeFileSync(file, JSON.stringify({ ...body(), at: Date.now() }, null, 2));
      return true;
    };
    const eChanged = writeIfChanged('entries.json',
      () => ({ schema: 3, mode: 'full', entries, teams }),
      (o) => ({ entries: o.entries || {}, teams: o.teams || {} }));
    const rChanged = writeIfChanged('rotation.json',
      () => ({ schema: 2, themes: rotation(byUrl) }), (o) => o.themes || []);
    console.log('索引文件:', eChanged ? 'entries.json 已更新' : 'entries.json 无变化',
      '/', rChanged ? 'rotation.json 已更新' : 'rotation.json 无变化');

    const total = fs.readdirSync(OUT).filter((f) => f.endsWith('.png'))
      .reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
    console.log(`完成：新增 ${fetched} / 复用 ${reused} / 失败 ${failed}；`
      + `manifest 条目 ${Object.keys(entries).length}，磁盘 ${(total / 1048576).toFixed(1)}MB`);
  } finally {
    try { fs.unlinkSync(LOCK); } catch {}
  }
}

main().catch((e) => { console.error('festival-assets failed:', e.message); process.exitCode = 1; });
