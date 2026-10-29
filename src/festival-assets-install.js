#!/usr/bin/env node
'use strict';
// 阿里云侧：把香橙派推过来的祭典海报装进 assets/，并合并 manifest。
//
// 用法：node festival-assets-install.js /tmp/xyy-fest      （目录里要有 entries.json 和要装的 *.png）
//
// 只做三件事：校验 → 落盘（原子）→ 合并 manifest（带锁，和 sync-assets.commit 用同一个锁文件，
// 避免和手工跑的素材同步互相覆盖）。
//
// 2026-10-23 改：祭典改成全量预取后，entries 里是「一场次一条 key」，但复刻场次共用同一张图
// （30 场 × 4 区 = 120 条 key，只有 27 个文件）。所以这里要：
//   1. 同一张图只落盘一次（否则每轮白写 120 次 ~1MB）；
//   2. 包里没带这张图、但云端已经有一模一样的（sha256 相同）时，只登记不重传 ——
//      这样香橙派可以增量推送，稳态下每次只传几十 KB 的 entries.json。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE = process.env.XYY_HOME || '/opt/xiaoyouyou';
const SRC = process.argv[2];
if (!SRC) { console.error('用法: festival-assets-install.js <目录>'); process.exit(2); }

const manifestFile = path.join(BASE, 'assets', 'manifest.json');
const lockFile = path.join(BASE, 'assets', '.manifest.lock');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const atomic = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

function withLock(fn) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let held = false;
  for (let i = 0; i < 500 && !held; i++) {
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 }); held = true; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const pid = Number(fs.readFileSync(lockFile, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 1) {
          try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') fs.unlinkSync(lockFile); }
        }
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      // 拿不到锁就等一下（同步工具是串行的，最多等 5 秒）
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (!held) throw Error('manifest 锁被占用');
  try { return fn(); } finally { try { fs.unlinkSync(lockFile); } catch {} }
}

function main() {
  const fragment = JSON.parse(fs.readFileSync(path.join(SRC, 'entries.json'), 'utf8'));
  const entries = fragment.entries || {};
  const installed = [];
  const reused = [];      // 云端已有同内容文件，只登记 manifest
  const skipped = [];
  const verified = new Map();   // file -> 已确认云端内容正确的 sha256

  for (const [key, entry] of Object.entries(entries)) {
    try {
      if (!key.startsWith('festivals:') || !entry.file || !entry.sha256) throw Error('条目字段不完整');
      const dest = path.join(BASE, entry.file);

      // 同一个文件被多个场次引用：已经确认过就不再碰磁盘
      if (verified.get(entry.file) === entry.sha256) { installed.push({ key, entry }); continue; }

      const src = path.join(SRC, path.basename(entry.file));
      if (fs.existsSync(src)) {
        const buf = fs.readFileSync(src);
        if (sha(buf) !== entry.sha256) throw Error('sha256 不匹配');
        if (buf.length < 2000) throw Error('图片过小 ' + buf.length);
        atomic(dest, buf);
        verified.set(entry.file, entry.sha256);
        installed.push({ key, entry });
      } else if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === entry.sha256) {
        // 增量推送：这张图之前就装过了
        verified.set(entry.file, entry.sha256);
        reused.push(key);
        installed.push({ key, entry });
      } else {
        throw Error('缺文件 ' + path.basename(entry.file));
      }
    } catch (e) {
      skipped.push(key + ': ' + e.message);
    }
  }

  // 阵营立绘：不进 manifest（manifest 只按 kind:id 查表），单独落盘到 assets/festivals/teams/
  const teamOk = [];
  const teamSkipped = [];
  for (const [key, t] of Object.entries(fragment.teams || {})) {
    try {
      if (!t.file || !t.sha256) throw Error('立绘字段不完整');
      const dest = path.join(BASE, t.file);
      const src = path.join(SRC, 'teams', path.basename(t.file));
      if (verified.get(t.file) === t.sha256) { teamOk.push(key); continue; }
      if (fs.existsSync(src)) {
        const buf = fs.readFileSync(src);
        if (sha(buf) !== t.sha256) throw Error('sha256 不匹配');
        atomic(dest, buf);
        verified.set(t.file, t.sha256);
        teamOk.push(key);
      } else if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === t.sha256) {
        verified.set(t.file, t.sha256);
        teamOk.push(key);
      } else {
        throw Error('缺文件 teams/' + path.basename(t.file));
      }
    } catch (e) {
      teamSkipped.push(key + ': ' + e.message);
    }
  }

  if (installed.length) {
    withLock(() => {
      const manifest = (() => {
        try { return JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; return { schema: 1, entries: {} }; }
      })();
      manifest.entries = manifest.entries || {};
      // 全量模式：香橙派这次带的是「至今为止的全部场次」，所以先清掉旧条目再整体写入。
      // 不这么做的话，改过一次文件命名规则就会留下永远没人引用的僵尸条目
      // （实测：2026-10-24 切换成按主题代号命名后，manifest 里还留着旧的 festivals:JUEA-00108）。
      //
      // 但只清「历史命名」的那些：本脚本产出的文件名一律是小写主题代号（juea-* / j-* / uea-*），
      // 大写 JUEA-xxx.png 是旧版按场次 id 命名的残留。festival-announcements.json 里手工公告用的图
      // （splatoween-2026-official.png 之类）不是本脚本产的，数据源万一挂了它是唯一兜底，不能误删。
      // 另外「一条都没跳过」才替换 —— 有 skip 说明这次数据不全，宁可保留旧条目。
      if (fragment.mode === 'full' && skipped.length === 0) {
        for (const [k, v] of Object.entries(manifest.entries)) {
          if (!k.startsWith('festivals:')) continue;
          if (/JUEA-\d+\.png$/.test(String(v.file))) delete manifest.entries[k];
        }
      }
      for (const { key, entry } of installed) manifest.entries[key] = entry;
      atomic(manifestFile, JSON.stringify(manifest, null, 2));
    });
  }

  console.log(JSON.stringify({
    ok: skipped.length === 0 && teamSkipped.length === 0,
    entries: Object.keys(entries).length,
    written: [...verified.keys()].length,
    installed: installed.length,
    reused: reused.length,
    teams: teamOk.length,
    skipped,
    teamSkipped,
  }, null, 2));
  if (!installed.length && skipped.length) process.exitCode = 1;
  if (!teamOk.length && teamSkipped.length) process.exitCode = 1;
}

main();
