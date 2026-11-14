'use strict';
// 跨进程 UI 操作锁（wx-fast 发送 / open_guard 开窗 / auto-relogin 触发登录串行化）。
// 通过 O_CREAT|O_EXCL 原子锁文件避免多个进程同时操作微信 a11y / 窗口焦点或触发假草稿校验失败。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockFilePath(customPath) {
  if (customPath) return customPath;
  if (process.env.XYY_UI_LOCK_FILE) return process.env.XYY_UI_LOCK_FILE;
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.local/state/splatoon-bridge/ui.lock');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function readHolder(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { missing: true, data: null };
    return { missing: false, data: null, corrupt: true };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { missing: false, data: null, corrupt: true };
    return { missing: false, data, corrupt: false };
  } catch {
    return { missing: false, data: null, corrupt: true };
  }
}

function tryAcquireUiLock(owner, { ttlMs = 45000, lockFile, now = Date.now } = {}) {
  const file = lockFilePath(lockFile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(8).toString('hex');
  const write = () => {
    const payload = JSON.stringify({
      pid: process.pid,
      owner: String(owner || 'unknown'),
      at: now(),
      ttlMs,
      token,
    });
    fs.writeFileSync(file, payload, { flag: 'wx', mode: 0o600 });
  };
  const release = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cur && cur.token === token) fs.unlinkSync(file);
    } catch {}
  };

  try {
    write();
    return { acquired: true, lockFile: file, release };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  const info = readHolder(file);
  let stale = false;
  if (info.missing) {
    stale = false; // just released concurrently; retry once below
  } else if (info.corrupt) {
    try {
      const st = fs.statSync(file);
      stale = Date.now() - st.mtimeMs > 2000;
    } catch (err) {
      stale = err && err.code === 'ENOENT';
    }
  } else if (info.data) {
    const limit = Number(info.data.ttlMs) > 0 ? Number(info.data.ttlMs) : ttlMs;
    const expired = Number.isFinite(info.data.at) && (now() - info.data.at > limit);
    const dead = Boolean(info.data.pid) && !isPidAlive(Number(info.data.pid));
    stale = expired || dead;
  }

  if (info.missing || stale) {
    if (stale) {
      try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    try {
      write();
      return { acquired: true, lockFile: file, release };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }

  const latest = readHolder(file);
  return { acquired: false, lockFile: file, holder: latest.data || null };
}

async function acquireUiLock(owner, { waitMs = 15000, pollMs = 150, ttlMs = 45000, lockFile, now = Date.now } = {}) {
  const start = Date.now();
  let last = tryAcquireUiLock(owner, { ttlMs, lockFile, now });
  while (!last.acquired && Date.now() - start < waitMs) {
    await sleep(pollMs);
    last = tryAcquireUiLock(owner, { ttlMs, lockFile, now });
  }
  return last;
}

async function withUiLock(owner, fn, { waitMs = 15000, pollMs = 150, ttlMs = 45000, lockFile, proceedOnTimeout = true, now = Date.now } = {}) {
  const res = await acquireUiLock(owner, { waitMs, pollMs, ttlMs, lockFile, now });
  if (!res.acquired && !proceedOnTimeout) {
    return { skipped: true, holder: res.holder || null };
  }
  try {
    return await fn();
  } finally {
    if (res.acquired) res.release();
  }
}

module.exports = {
  lockFilePath,
  isPidAlive,
  tryAcquireUiLock,
  acquireUiLock,
  withUiLock,
};
