#!/usr/bin/env node
// 一次性：把所有缓存配装用到的装备图与技能图下载到 assets/builds/
// 用法：XYY_BASE=<repo>/src node tools/prefetch-assets.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.XYY_BASE || path.join(__dirname, '..', 'src');
const assets = require(path.join(BASE, 'builds-assets.js'));

(async () => {
  const dir = path.join(BASE, 'cache', 'builds');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const gear = new Set();
  const skills = new Set();
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const b of j.builds || []) {
      gear.add('head:' + b.gear.head);
      gear.add('clothes:' + b.gear.clothes);
      gear.add('shoes:' + b.gear.shoes);
      for (const row of b.abilities || []) for (const c of row) skills.add(c);
    }
  }

  const tasks = [
    ...[...gear].map((p) => {
      const [slot, id] = p.split(':');
      return () => assets.ensureGear(Number(id), slot);
    }),
    ...[...skills].map((c) => () => assets.ensureSkill(c)),
  ];

  let ok = 0, fail = 0;
  const failed = [];
  const t0 = Date.now();
  const queue = tasks.slice();
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      try {
        const r = await job();
        if (r) ok++; else { fail++; failed.push(String(job).slice(0, 40)); }
      } catch { fail++; }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  const out = { gear: gear.size, skill: skills.size, ok, fail, elapsedMs: Date.now() - t0, failed: failed.slice(0, 10) };
  console.log(JSON.stringify(out));
  process.exitCode = fail ? 1 : 0;
})();
