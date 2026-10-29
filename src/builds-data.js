'use strict';
// sendou.ink 配装数据层（P1）。
//
// 对外：
//   resolveWeapon(query) -> {splId, name, en, slug}   武器名（中/英）→ 站点标识
//   buildSlug(en)        -> string                    '.52 Gal' → '52-gal'
//   fetchBuilds(query)   -> {weaponName, builds:[...], stale?} 带 6h 磁盘缓存
//                           缓存过期且刷新失败时返回旧数据并带 stale:true（不抛错）；
//                           完全没有缓存才抛。
//
// 数据源：https://sendou.ink/builds/<slug>.data（React Router 7 single-fetch，turbo-stream）
// 缓存：<XYY_BASE>/cache/builds/<splId>.json，原子写，TTL 6 小时。
// 失败一律抛 BuildsError，带 code：E_UNKNOWN / E_HTTP / E_PARSE / E_EMPTY / E_SHAPE。
//
// 变更注意（实测 2026-10-22）：
//   PLAN 写的 /builds/<splId>-<slug>.data 在现网是 404，正确形式是 /builds/<slug>.data。
//   这里先按 PLAN 的形式请求，404 再回退到无 splId 形式（见 buildUrls）。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const BASE = process.env.XYY_BASE || '/opt/xiaoyouyou';
const CACHE_DIR = path.join(BASE, 'cache', 'builds');
const CACHE_TTL = Number(process.env.XYY_BUILDS_TTL_MS || 6 * 60 * 60 * 1000);   // 阿里云设成超长，只读本地缓存
const REQUEST_TIMEOUT = 20000;   // 单次请求超时
const RETRY_BUDGET = 60000;      // 首次请求起 60s 内允许重试 1 次
const MAX_BYTES = 4 * 1024 * 1024;
const MIN_RENDERABLE = 3;        // 可渲染卡片少于 3 张判数据源异常

class BuildsError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'BuildsError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------- 武器名匹配

// catalog 在部署环境是 <BASE>/assets/catalog.json；仓库里是 src/assets/catalog.json。
let catalogCache = null;
function catalogPath() {
  const deployed = path.join(BASE, 'assets', 'catalog.json');
  if (fs.existsSync(deployed)) return deployed;
  return path.join(__dirname, 'assets', 'catalog.json');
}
function catalog() {
  if (catalogCache) return catalogCache;
  const file = catalogPath();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new BuildsError('E_SHAPE', '武器目录不可读：' + file + '（' + e.message + '）');
  }
  if (!parsed || !Array.isArray(parsed.weapons)) {
    throw new BuildsError('E_SHAPE', '武器目录结构异常：' + file);
  }
  catalogCache = parsed.weapons.filter((w) => Number.isInteger(w.numericId) && w.en);
  return catalogCache;
}

// 去空格/标点/大小写，用于宽松匹配。＋/ 等一律丢弃而不是换成 -
function normalizeName(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// '.52 Gal' → '52-gal'，'Z+F Splatterscope' → 'zf-splatterscope'，'S-BLAST '92' → 's-blast-92'
// '+' 要直接删掉而不是变连字符：sendou.ink 的 slug 是 zf-splatterscope，不是 z-f-splatterscope（实测 2026-10-22）。
function buildSlug(en) {
  const slug = String(en)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\+/g, '')
    .replace(/[^a-z0-9]+/g, '-')   // 空格、点、引号、/ 等统一成连字符
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new BuildsError('E_SHAPE', '无法从英文名生成 slug：' + JSON.stringify(en));
  return slug;
}

function toWeapon(w) {
  return { splId: w.numericId, name: w.name, en: w.en, slug: buildSlug(w.en) };
}

// 顺序：精确中文 → 精确英文（忽略大小写）→ 去空格/标点后包含匹配；多条命中取第一条。
function resolveWeapon(query) {
  const raw = String(query == null ? '' : query).trim();
  if (!raw) throw new BuildsError('E_UNKNOWN', '武器名不能为空');
  const weapons = catalog();

  let hit = weapons.find((w) => w.name === raw);
  if (hit) return toWeapon(hit);

  const lower = raw.toLowerCase();
  hit = weapons.find((w) => w.en.toLowerCase() === lower);
  if (hit) return toWeapon(hit);

  const key = normalizeName(raw);
  if (!key) throw new BuildsError('E_UNKNOWN', '没找到武器：' + raw);
  hit = weapons.find(
    (w) => normalizeName(w.name).includes(key) || normalizeName(w.en).includes(key)
  );
  if (hit) return toWeapon(hit);

  throw new BuildsError('E_UNKNOWN', '没找到武器：' + raw);
}

// ---------------------------------------------------------------- turbo-stream 解码
//
// sendou.ink 的 .data 响应是 turbo-stream 的扁平数组：对象成员写成 {"_<index>": <index>}，
// 负数 index 是特殊值，带类型的值写成 ["D", ...]。以下是从 spike/decode.js 精简后的内联版
// （不依赖 spike/，也不依赖 npm 包）。

const HOLE = -1, NAN = -2, NEG_INF = -3, NEG_ZERO = -4;
const NULL = -5, POS_INF = -6, UNDEFINED = -7;
const TYPE_BIGINT = 'B', TYPE_DATE = 'D', TYPE_REGEXP = 'R', TYPE_URL = 'U';
const TYPE_ERROR = 'E', TYPE_ERROR_RESPONSE = 'ErrorResponse';   // 上游把错误当 200 返回时的载荷

function decodeStream(text) {
  const first = String(text).split('\n').map((s) => s.trim()).find(Boolean);
  if (!first) throw new BuildsError('E_PARSE', '响应为空');
  let values;
  try {
    values = JSON.parse(first);
  } catch (e) {
    throw new BuildsError('E_PARSE', '响应不是 JSON：' + e.message);
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new BuildsError('E_PARSE', '响应不是 turbo-stream（首层不是非空数组）');
  }

  const memo = new Map();
  function hydrate(index) {
    switch (index) {
      case UNDEFINED: return undefined;
      case NULL: return null;
      case NAN: return NaN;
      case POS_INF: return Infinity;
      case NEG_INF: return -Infinity;
      case NEG_ZERO: return -0;
      default: break;
    }
    if (memo.has(index)) return memo.get(index);
    const value = values[index];
    if (value === null || typeof value !== 'object') {
      memo.set(index, value);
      return value;
    }
    if (Array.isArray(value)) {
      if (typeof value[0] === 'string') {
        const [type, a, b] = value;
        let typed;
        if (type === TYPE_DATE) typed = new Date(a);
        else if (type === TYPE_URL) typed = new URL(a);
        else if (type === TYPE_BIGINT) typed = BigInt(a);
        else if (type === TYPE_REGEXP) typed = new RegExp(a, b);
        else if (type === TYPE_ERROR_RESPONSE || type === TYPE_ERROR) {
          // 上游用 200/404 + turbo-stream 的错误段表示「没有这个页面」。
          // 归到 E_HTTP，避免调用方把它当成解码器/数据结构故障。
          throw new BuildsError('E_HTTP', '上游返回错误段：' + type, { status: Number(a) || 404 });
        }
        else throw new BuildsError('E_PARSE', '不支持的 turbo-stream 类型：' + JSON.stringify(type));
        memo.set(index, typed);
        return typed;
      }
      const arr = [];
      memo.set(index, arr);                        // 先占位，兼容自引用
      for (let i = 0; i < value.length; i++) {
        if (value[i] === HOLE) continue;
        arr[i] = hydrate(value[i]);
      }
      return arr;
    }
    const obj = {};
    memo.set(index, obj);
    for (const key of Object.keys(value)) {
      obj[hydrate(Number(key.slice(1)))] = hydrate(value[key]);
    }
    return obj;
  }

  return hydrate(0);
}

// 根对象里有多个 route 段；配装详情段的特征是该段有 data.builds 数组。
function findBuildsPayload(root) {
  if (!root || typeof root !== 'object') {
    throw new BuildsError('E_SHAPE', 'turbo-stream 根节点不是对象');
  }
  for (const key of Object.keys(root)) {
    const seg = root[key];
    if (seg && typeof seg === 'object' && seg.data && Array.isArray(seg.data.builds)) {
      return seg.data;
    }
  }
  throw new BuildsError('E_SHAPE', '响应里没有 data.builds（数据源结构可能已变化）');
}

// ---------------------------------------------------------------- HTTP

function requestOnce(url) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new BuildsError('E_HTTP', 'URL 无效：' + url));
    }
    if (u.protocol !== 'https:') return reject(new BuildsError('E_HTTP', '只允许 HTTPS：' + url));
    const req = https.get(u, {
      headers: {
        'User-Agent': 'XiaoYouyou/3.3 (personal splatoon schedule bot)',
        Accept: 'text/x-script, application/json;q=0.9, */*;q=0.8',
      },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (b) => {
        size += b.length;
        if (size > MAX_BYTES) req.destroy(new BuildsError('E_HTTP', '响应过大'));
        else chunks.push(b);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new BuildsError('E_HTTP', '请求超时：' + url)));
    req.on('error', (e) => reject(e instanceof BuildsError
      ? e
      : new BuildsError('E_HTTP', '网络错误：' + e.message)));
  });
}

// 现网路由是 /builds/<slug>.data；PLAN 记的 /builds/<splId>-<slug>.data 先试一次，404 回退。
function buildUrls(splId, slug) {
  return [
    `https://sendou.ink/builds/${splId}-${slug}.data`,
    `https://sendou.ink/builds/${slug}.data`,
  ];
}

// 对同一 URL 在 60s 预算内重试 1 次（仅网络错误 / 5xx）；404 直接换下一种 URL 形式。
// 预算按 URL 分别计时：第一种形式超时不该吃掉第二种形式的重试机会。
// 每个 URL 的失败都保留下来，最终抛出时带上全部尝试记录，便于区分「路由 404」和「网络故障」。
async function fetchText(urls) {
  const attempts = [];
  for (const url of urls) {
    const urlStarted = Date.now();
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0 && Date.now() - urlStarted > RETRY_BUDGET) break;
      try {
        const res = await requestOnce(url);
        if (res.status === 200) return res;
        last = new BuildsError('E_HTTP', 'sendou.ink HTTP ' + res.status, { status: res.status, url });
        if (res.status === 404) break;               // 换 URL 形式，不重试
        // 5xx / 429 等：预算内重试一次
      } catch (e) {
        last = e instanceof BuildsError && e.code === 'E_HTTP'
          ? e
          : new BuildsError('E_HTTP', '网络错误：' + (e && e.message || e));
      }
    }
    if (last) attempts.push({ url, code: last.code, status: last.status || null, message: last.message });
  }
  const detail = attempts.map((a) => a.url + ' → ' + a.message).join('；');
  throw new BuildsError('E_HTTP', '请求失败：' + (detail || '无可用 URL'), {
    urls: attempts.map((a) => a.url),
    attempts,
    status: attempts.length ? attempts[attempts.length - 1].status : null,
  });
}

// ---------------------------------------------------------------- 缓存

function cacheFile(splId) {
  return path.join(CACHE_DIR, splId + '.json');
}

// 只返回结构合法的缓存，不判过期：过期缓存要留给 stale-while-error 兜底。
function readCacheRaw(splId) {
  try {
    const v = JSON.parse(fs.readFileSync(cacheFile(splId), 'utf8'));
    if (!v || typeof v.at !== 'number' || !Array.isArray(v.builds)) return null;
    return v;
  } catch {
    return null;
  }
}

function readCache(splId) {
  const v = readCacheRaw(splId);
  if (!v || Date.now() - v.at >= CACHE_TTL) return null;
  return v;
}

function writeCache(splId, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = cacheFile(splId);
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);                          // 原子替换
}

// ---------------------------------------------------------------- 数据整形 / 判据

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// 单条 build 缺 title / owner.username / 三个 gear splId → 不可渲染（PLAN 第 5 节第 4 条）。
function renderable(b) {
  if (!b || typeof b !== 'object') return null;
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const owner = b.owner && typeof b.owner.username === 'string' ? b.owner.username.trim() : '';
  const head = num(b.headGearSplId);
  const clothes = num(b.clothesGearSplId);
  const shoes = num(b.shoesGearSplId);
  if (!title || !owner || head === null || clothes === null || shoes === null) return null;
  const abilities = Array.isArray(b.abilities)
    ? b.abilities.filter(Array.isArray).slice(0, 3).map((a) => a.filter((x) => typeof x === 'string'))
    : [];
  if (abilities.length < 3 || abilities.some((a) => a.length < 4)) return null;
  const weapons = Array.isArray(b.weapons)
    ? b.weapons.filter((w) => w && Number.isInteger(w.weaponSplId)).map((w) => ({
      weaponSplId: w.weaponSplId,
      isTop500: w.isTop500 ? 1 : 0,
    }))
    : [];
  return {
    id: b.id,
    title,
    owner,
    plusTier: num(b.plusTier),
    updatedAt: num(b.updatedAt),                     // unix 秒，按 PLAN 保持原样
    gear: { head, clothes, shoes },
    abilities,
    weapons,
  };
}

function shapePayload(data, splId) {
  if (!data || typeof data !== 'object') {
    throw new BuildsError('E_SHAPE', '配装数据段不是对象');
  }
  if (Number.isInteger(data.weaponId) && data.weaponId !== splId) {
    // slug 回退命中了别的武器：宁可报错也不返回错武器的配装
    throw new BuildsError('E_SHAPE', '返回的武器 id 与请求不符：' + data.weaponId + ' != ' + splId);
  }
  const builds = (Array.isArray(data.builds) ? data.builds : []).map(renderable).filter(Boolean);
  if (!builds.length) throw new BuildsError('E_EMPTY', '该武器暂无配装数据');
  if (builds.length < MIN_RENDERABLE) {
    throw new BuildsError('E_SHAPE', '可渲染配装只有 ' + builds.length + ' 条，数据源结构可能已变化');
  }
  const weaponName = typeof data.weaponName === 'string' && data.weaponName
    ? data.weaponName
    : null;
  if (!weaponName) throw new BuildsError('E_SHAPE', '响应缺少 weaponName');
  return { weaponName, builds };
}

// ---------------------------------------------------------------- 对外入口

const pending = new Map();   // splId -> Promise，合并并发请求

async function fetchBuilds(weaponQuery, opts = {}) {
  const weapon = resolveWeapon(weaponQuery);
  // opts.force=true 供预取脚本使用：跳过缓存，强制回源
  const hit = opts.force ? null : readCache(weapon.splId);
  if (hit) return { weaponName: hit.weaponName, builds: hit.builds };

  if (pending.has(weapon.splId)) return pending.get(weapon.splId);
  const task = (async () => {
    let out;
    try {
      const res = await fetchText(buildUrls(weapon.splId, weapon.slug));
      out = shapePayload(findBuildsPayload(decodeStream(res.body)), weapon.splId);
    } catch (e) {
      // stale-while-error：有过期缓存就先用旧数据渲染，只有完全没缓存才抛
      const old = readCacheRaw(weapon.splId);
      if (old) return { weaponName: old.weaponName, builds: old.builds, stale: true };
      throw e;
    }
    writeCache(weapon.splId, {
      at: Date.now(),
      weaponName: out.weaponName,
      slug: weapon.slug,
      builds: out.builds,
    });
    return { weaponName: out.weaponName, builds: out.builds };
  })().finally(() => pending.delete(weapon.splId));
  pending.set(weapon.splId, task);
  return task;
}

module.exports = { fetchBuilds, resolveWeapon, buildSlug, BuildsError };
