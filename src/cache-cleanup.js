#!/usr/bin/env node
'use strict';
// 排班图缓存清理：按 TTL + 保留份数双条件删除，永远保留当前在用的那张。
// 定时器每天跑一次；也可以 --dry-run 看会删什么。
//
// 为什么要单独一个任务：脚本自己只在「重画时」顺带清理，
// 一旦某轮不再换班（数据源挂了、定时器停了），旧图就会一直躺着。

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.XYY_BASE || '/opt/xiaoyouyou';
const DRY = process.argv.includes('--dry-run');
const NOW = Date.now();

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const TARGETS = [
  { name: 'battle-schedule', dir: path.join(BASE, 'cache', 'battle-schedule'), ttl: 3 * DAY, keep: 5, pattern: /^[0-9a-f]{12}\.png$/ },
  { name: 'salmon-schedule', dir: path.join(BASE, 'cache', 'salmon-schedule'), ttl: 14 * DAY, keep: 5, pattern: /^[0-9a-f]{12}\.png$/ },
  { name: 'cards', dir: path.join(BASE, 'cache', 'cards'), ttl: 48 * HOUR, keep: 96, pattern: /^(maps|salmon|random|festival)-[a-f0-9]+\.png$/ },
];

const report = [];

for (const t of TARGETS) {
  const entry = { name: t.name, removed: 0, bytes: 0, kept: 0, skipped: 'missing' };
  if (!fs.existsSync(t.dir)) { report.push(entry); continue; }
  entry.skipped = null;

  // 当前在用的那张：meta.key 指向的文件，任何情况下都不删
  let currentFile = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(t.dir, 'meta.json'), 'utf8'));
    if (meta && meta.key) currentFile = meta.key + '.png';
  } catch {}

  // 1) 过期临时文件（写一半被杀掉留下的）
  for (const f of fs.readdirSync(t.dir)) {
    if (!f.endsWith('.tmp')) continue;
    const p = path.join(t.dir, f);
    try {
      const st = fs.statSync(p);
      if (NOW - st.mtimeMs > HOUR) {
        entry.bytes += st.size;
        if (!DRY) fs.unlinkSync(p);
        entry.removed++;
      }
    } catch {}
  }

  // 2) 正常图片：TTL 到期 或 超出保留份数
  const files = fs.readdirSync(t.dir)
    .filter((f) => t.pattern.test(f))
    .map((f) => {
      const p = path.join(t.dir, f);
      try { const st = fs.statSync(p); return { f, p, at: st.mtimeMs, size: st.size }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);

  files.forEach((x, i) => {
    if (x.f === currentFile) { entry.kept++; return; }
    const expired = NOW - x.at > t.ttl;
    const overflow = i >= t.keep;
    if (!expired && !overflow) { entry.kept++; return; }
    entry.bytes += x.size;
    if (!DRY) { try { fs.unlinkSync(x.p); } catch {} }
    entry.removed++;
  });

  report.push(entry);
}

const total = report.reduce((a, r) => a + r.bytes, 0);
console.log(JSON.stringify({
  dryRun: DRY,
  removed: report.reduce((a, r) => a + r.removed, 0),
  freedMB: +(total / 1048576).toFixed(1),
  detail: report,
}));
