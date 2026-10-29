#!/usr/bin/env node
'use strict';
// 配装数据预取（在能访问 sendou.ink 的机器上跑，即香橙派）。
//
// 阿里云 VPS 访问 sendou.ink 被 Cloudflare 403，所以数据在香橙派取好，
// 再由 tools/builds-sync.sh 把 cache/builds/*.json rsync 到 VPS。
//
// 用法：
//   node tools/prefetch-builds.js                全量
//   node tools/prefetch-builds.js --limit 5      只跑前 5 把（自测）
//   node tools/prefetch-builds.js --publish DIR  跑完后把 cache/builds/*.json 复制到 DIR
//
// stdout 只输出一行 JSON 摘要：
//   {ok, fail, skipped, elapsedMs, failed:[{splId, en, code, message}]}
//     ok      拿到数据（新取或命中未过期缓存）
//     fail    请求失败且没有可用缓存，或只有过期缓存（code=E_STALE）
//     skipped isCoopRare 武器数（不请求）
// 进度和 publish 结果写 stderr，方便 shell 日志和 JSON 消费分开。
//
// 缓存位置由 XYY_BASE 决定（<XYY_BASE>/cache/builds/<splId>.json）；未设置时
// 用仓库根目录，和 tools/builds-sync.sh 的 rsync 源保持一致。

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
// fetchBuilds 的默认 BASE 是 /opt/xiaoyouyou（部署机路径），香橙派上没有这个目录
if (!process.env.XYY_BASE) process.env.XYY_BASE = REPO;
const BASE = process.env.XYY_BASE;
const CACHE_DIR = path.join(BASE, 'cache', 'builds');
const CATALOG = path.join(__dirname, '..', 'src', 'assets', 'catalog.json');

const CONCURRENCY = 3;

function parseArgs(argv) {
  const opts = { limit: 0, publish: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw Error('--limit 需要一个正整数');
      opts.limit = n;
    } else if (a === '--publish') {
      const dir = argv[++i];
      if (!dir) throw Error('--publish 需要一个目录');
      opts.publish = path.resolve(dir);
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else {
      throw Error('未知参数：' + a);
    }
  }
  return opts;
}

// 简单并发池：最多 n 个 worker 同时跑，单个任务抛错由调用方自己吞掉。
async function pool(items, n, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function publish(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!name.endsWith('.json')) continue;
    fs.copyFileSync(path.join(CACHE_DIR, name), path.join(dir, name));
    n++;
  }
  return n;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stderr.write('用法：node tools/prefetch-builds.js [--limit N] [--publish DIR]\n');
    return;
  }

  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  if (!Array.isArray(catalog.weapons)) throw Error('武器目录结构异常：' + CATALOG);

  const skipped = catalog.weapons.filter((w) => w.isCoopRare).length;
  let weapons = catalog.weapons.filter((w) => !w.isCoopRare && Number.isInteger(w.numericId) && w.en);
  if (opts.limit) weapons = weapons.slice(0, opts.limit);

  // 在 require 之后再读 BASE，保证上面的默认值已生效
  const { fetchBuilds } = require('../src/builds-data');

  const failed = [];
  let ok = 0;
  let done = 0;
  const started = Date.now();
  process.stderr.write(`prefetch: ${weapons.length} 把武器（跳过 ${skipped} 把合作稀有），缓存 ${CACHE_DIR}\n`);

  await pool(weapons, CONCURRENCY, async (w) => {
    try {
      // 英文名最稳：中文名可能撞同义词，且 sendou.ink 的 slug 由英文名生成
      const r = await fetchBuilds(w.en, { force: true });
      if (r.stale) {
        failed.push({ splId: w.numericId, en: w.en, code: 'E_STALE', message: '请求失败，仅有过期缓存' });
      } else {
        ok++;
      }
    } catch (e) {
      failed.push({
        splId: w.numericId,
        en: w.en,
        code: (e && e.code) || 'E_UNKNOWN',
        message: (e && e.message) || String(e),
      });
    }
    done++;
    if (done % 10 === 0 || done === weapons.length) {
      process.stderr.write(`prefetch: ${done}/${weapons.length}\n`);
    }
  });

  const summary = {
    ok,
    fail: failed.length,
    skipped,
    elapsedMs: Date.now() - started,
    failed,
  };

  if (opts.publish) {
    const n = publish(opts.publish);
    process.stderr.write(`publish: ${n} 个文件 → ${opts.publish}\n`);
  }

  process.stdout.write(JSON.stringify(summary) + '\n');
})().catch((e) => {
  process.stderr.write('prefetch 失败：' + ((e && e.stack) || e) + '\n');
  process.exitCode = 1;
});
