'use strict';
// sendou.ink 配装卡片素材层（P2）。
//
// 对外（都是 async，失败一律返回 null，不抛错 —— 调用方画占位）：
//   ensureGear(splId, slot) -> string|null   装备图；slot = 'head' | 'clothes' | 'shoes'
//   ensureSkill(code)       -> string|null   技能图标；code = 'OG' / 'SSU' / 'QSJ' ...
//
// 目录（部署在 <XYY_BASE>/assets/builds/，仓库里是 src/assets/builds/）：
//   map.json          splId / 技能代码 → Leanny 图片文件名（tools/build-maps.js 生成）
//   gear/<key>.png    key = splId 在三个部位含义一致时是 splId，否则是 <slot>-<splId>
//   skill/<code>.png
// 缓存 30 天（按 mtime），下载并发 4，单文件 15s 超时；先写临时文件再 rename，不会留下半个文件。
//
// 装备 splId 在不同部位会重号，所以 ensureGear 必须带 slot：只给 splId 时，
// 只有「各部位同名」的条目能取到，其余返回 null（调用方给占位），绝不拿错部位的图充数。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const dns = require('node:dns');

// 阿里云 VPS 上 raw.githubusercontent.com 走 IPv6 会 ECONNRESET（curl -4 正常）。
// 本进程所有下载都改走 IPv4；不改其它逻辑。
dns.setDefaultResultOrder('ipv4first');

// 素材根：部署时 <XYY_BASE>/assets，仓库里 src/assets（与 weapon-card.js 的约定一致）
const ASSETS = process.env.XYY_ASSETS
  || (fs.existsSync(path.join(process.env.XYY_BASE || '/opt/xiaoyouyou', 'assets', 'builds', 'map.json'))
    ? path.join(process.env.XYY_BASE || '/opt/xiaoyouyou', 'assets')
    : path.join(__dirname, 'assets'));
const BUILD_DIR = path.join(ASSETS, 'builds');

const LEANNY_RAW = 'https://raw.githubusercontent.com/Leanny/splat3';
const TTL = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT = 15000;
const CONCURRENCY = 4;
const MIN_BYTES = 512;                       // 小于这个不可能是可用的装备/技能图
const MAX_BYTES = 2 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SLOTS = new Set(['head', 'clothes', 'shoes']);

// ---------------------------------------------------------------- map.json

let mapCache = null;                         // 读失败后不再反复读盘，进程内负缓存

function loadMap() {
  if (mapCache) return mapCache;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, 'map.json'), 'utf8'));
    mapCache = {
      gear: m && m.gear && typeof m.gear === 'object' ? m.gear : {},
      gearBySlot: m && m.gearBySlot && typeof m.gearBySlot === 'object' ? m.gearBySlot : {},
      skill: m && m.skill && typeof m.skill === 'object' ? m.skill : {},
      commit: m?.source?.leanny?.commit || null,
    };
  } catch {
    mapCache = { gear: {}, gearBySlot: {}, skill: {}, commit: null };
  }
  return mapCache;
}

// 只接受纯文件名的映射值，防止 map.json 里出现 ../ 之类把写盘带出素材目录
function safeFilename(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.-]+\.png$/.test(name) && !name.includes('..');
}

// splId 在三个部位同名 → 公共表；否则按部位取。只给 splId 时不去猜部位。
function gearEntry(splId, slot) {
  const id = String(splId);
  const map = loadMap();
  if (slot == null) {
    return safeFilename(map.gear[id]) ? map.gear[id] : null;
  }
  if (!SLOTS.has(slot)) return null;
  const perSlot = map.gearBySlot[slot];
  if (perSlot && safeFilename(perSlot[id])) return perSlot[id];
  // 公共表里的条目代表各部位同一张图，任何部位都可以用
  return safeFilename(map.gear[id]) ? map.gear[id] : null;
}

// ---------------------------------------------------------------- 文件校验

function validPng(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size <= MIN_BYTES) return false;
    if (Date.now() - st.mtimeMs >= TTL) return false;      // 过期就当没缓存，走重下
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(8);
    try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
    return head.equals(PNG_MAGIC);
  } catch {
    return false;
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件可能没建出来 */ }
    throw e;
  }
}

// ---------------------------------------------------------------- 下载

// 简单的信号量：全进程最多 4 个并发下载
let running = 0;
const waiting = [];
function acquire() {
  if (running < CONCURRENCY) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next();                          // 名额直接转交，running 不变
  else running--;
}

function download(url) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(Error('URL 无效'));
    }
    if (u.protocol !== 'https:') return reject(Error('仅支持 HTTPS'));
    const req = https.get(u, {
      headers: { 'User-Agent': 'XiaoYouyou/3.3 (personal splatoon schedule bot)' },
      timeout: TIMEOUT,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(Error('HTTP ' + res.statusCode));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (b) => {
        size += b.length;
        if (size > MAX_BYTES) req.destroy(Error('文件过大'));
        else chunks.push(b);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Error('下载超时')));
    req.on('error', reject);
  });
}

// 同一资源的并发请求合并成一个 Promise，避免六张卡同时要同一张图时下载六遍
const inflight = new Map();

// 失败负缓存：上游短时不可达或映射项 404 时，不要让每条消息都重新打网络。
// 404/无效图 10 分钟，网络/写盘失败 60 秒。key 与 inflight 相同（目标文件路径）。
const FAIL_TTL_NOT_FOUND = 10 * 60 * 1000;
const FAIL_TTL_TRANSIENT = 60 * 1000;
const failedUntil = new Map();
const FAILED_MAX = 2000;                     // 小内存机：上限，超出时清掉已过期的键

function failedRecently(file) {
  const until = failedUntil.get(file);
  if (until == null) return false;
  if (until > Date.now()) return true;
  failedUntil.delete(file);
  return false;
}

function rememberFailure(file, ttl) {
  if (failedUntil.size >= FAILED_MAX) {
    const now = Date.now();
    for (const [k, v] of failedUntil) if (v <= now) failedUntil.delete(k);
  }
  failedUntil.set(file, Date.now() + ttl);
}

// 下载失败原因：404/映射文件本身不存在属于确定失败，网络错误/写盘失败属于临时失败
function failureTtl(e) {
  const msg = String((e && e.message) || '');
  return /HTTP 404|HTTP 403|HTTP 410/.test(msg) ? FAIL_TTL_NOT_FOUND : FAIL_TTL_TRANSIENT;
}

function ensureFile(file, filename, subdir, signal) {
  if (validPng(file)) return Promise.resolve(file);
  if (signal && signal.aborted) return Promise.resolve(null);
  if (failedRecently(file)) return Promise.resolve(null);
  if (inflight.has(file)) return inflight.get(file);

  const { commit } = loadMap();
  if (!safeFilename(filename) || !commit || !/^[0-9a-f]{40}$/.test(commit)) {
    return Promise.resolve(null);            // 映射缺失或 map.json 没记录来源 commit：不猜
  }

  const task = (async () => {
    await acquire();
    try {
      // 排队期间可能被取消，或别的调用已经把文件写好了
      if (signal && signal.aborted) return null;
      if (validPng(file)) return file;
      const buf = await download(`${LEANNY_RAW}/${commit}/images/${subdir}/${filename}`);
      if (buf.length <= MIN_BYTES || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
        rememberFailure(file, FAIL_TTL_NOT_FOUND);      // 上游给的不是有效 PNG，重试没意义
        return null;
      }
      if (signal && signal.aborted) return null;
      writeAtomic(file, buf);
      failedUntil.delete(file);
      return file;
    } catch (e) {
      rememberFailure(file, failureTtl(e));
      return null;                           // 网络/写盘失败：调用方画占位
    } finally {
      release();
    }
  })().finally(() => inflight.delete(file));
  inflight.set(file, task);
  return task;
}

// ---------------------------------------------------------------- 对外入口

function ensureGear(splId, slot, signal) {
  try {
    const id = Number(splId);
    if (!Number.isSafeInteger(id) || id <= 0) return Promise.resolve(null);
    const filename = gearEntry(id, slot);
    if (!filename) return Promise.resolve(null);
    // 公共条目用 splId 当键（三个部位共用一份文件），按部位条目用 <slot>-<splId>
    const map = loadMap();
    const shared = safeFilename(map.gear[String(id)]);
    const key = shared === filename ? String(id) : `${slot}-${id}`;
    return ensureFile(path.join(BUILD_DIR, 'gear', key + '.png'), filename, 'gear', signal);
  } catch {
    return Promise.resolve(null);
  }
}

function ensureSkill(code, signal) {
  try {
    const key = String(code == null ? '' : code).trim();
    if (!/^[A-Z]{1,4}$/.test(key)) return Promise.resolve(null);
    const filename = loadMap().skill[key];
    if (!safeFilename(filename)) return Promise.resolve(null);
    return ensureFile(path.join(BUILD_DIR, 'skill', key + '.png'), filename, 'skill', signal);
  } catch {
    return Promise.resolve(null);
  }
}

module.exports = { ensureGear, ensureSkill, BUILD_DIR };
