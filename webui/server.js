#!/usr/bin/env node
'use strict';
/**
 * 小鱿鱿 WebUI 后端
 * 零依赖（Node 22+ 原生 http），只读写本地文件 + 代理微信容器 API。
 *
 * 默认只监听 127.0.0.1:8088，需要外部访问请用 SSH 隧道或反代 + WEBUI_TOKEN。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const PORT = Number(process.env.WEBUI_PORT) || 8088;
const HOST = process.env.WEBUI_HOST || '127.0.0.1';
const TOKEN = process.env.WEBUI_TOKEN || '';
const BASE = process.env.XYY_BASE || '/opt/xiaoyouyou';
const PRIVATE = process.env.XYY_PRIVATE || path.join(BASE, 'private');
const WX_API = process.env.WX_API_BASE || 'http://127.0.0.1:6174';
const PUBLIC_DIR = path.join(__dirname, 'public');

const P = {
  botConfig: path.join(BASE, 'bot-config.json'),
  persona: path.join(PRIVATE, 'persona.md'),
  env: path.join(PRIVATE, 'wechat.env'),
  llmEnv: path.join(PRIVATE, 'llm.env'),
  memoryDir: process.env.XYY_LLM_MEMORY_DIR || path.join(PRIVATE, 'llm-memory'),
  events: path.join(PRIVATE, '.local/state/splatoon-bridge/recovery-events.jsonl'),
};

// ---------- 工具 ----------
function wxToken() {
  if (process.env.AGENT_WECHAT_TOKEN) return process.env.AGENT_WECHAT_TOKEN;
  try {
    const env = fs.readFileSync(P.env, 'utf8');
    const m = env.match(/^AGENT_WECHAT_TOKEN=(.*)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

async function wxGet(p) {
  const token = wxToken();
  const r = await fetch(WX_API + p, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`容器返回 ${r.status}`);
  return r.json();
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function atomicWrite(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/** 读 env 文件成对象（保留注释行） */
function readEnvFile(file) {
  const out = { __lines: [] };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    out.__lines.push(line);
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** XYY_LLM 的取值归一化：1/on/all → all */
function normMode(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === '1' || s === 'on' || s === 'all') return 'all';
  if (s === 'admin') return 'admin';
  return 'off';
}

/** 合并两个 env 文件，后者覆盖前者 */
function readEnvMerged() {
  const a = readEnvFile(P.env);
  const b = readEnvFile(P.llmEnv);
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (k !== '__lines') out[k] = v;
  return out;
}

/** 只改指定 key，保留注释与顺序 */
function writeEnvKeys(file, patch) {
  const cur = readEnvFile(file);
  const seen = new Set();
  const lines = cur.__lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && Object.hasOwn(patch, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${patch[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(patch)) {
    if (!seen.has(k)) lines.push(`${k}=${v}`);
  }
  atomicWrite(file, lines.join('\n').replace(/\n+$/, '') + '\n');
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function unauthorized(req, res) {
  if (!TOKEN) return false;
  const got = req.headers['x-webui-token'] || new URL(req.url, 'http://x').searchParams.get('token');
  if (got === TOKEN) return false;
  json(res, 401, { ok: false, error: '需要 WEBUI_TOKEN' });
  return true;
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('请求体不是合法 JSON'); }
}

// ---------- 业务 ----------
async function getStatus() {
  let container = { ok: false };
  try {
    const s = await wxGet('/api/status');
    container = { ok: true, ...s };
  } catch (e) { container = { ok: false, error: e.message }; }
  const cfg = readJson(P.botConfig, {});
  const env = readEnvMerged();
  // loginState 会滞后：用「最近一条消息时间」作为在线旁证
  let lastActivity = null;
  try {
    const chats = await wxGet('/api/chats');
    lastActivity = (Array.isArray(chats) ? chats : [])
      .map((c) => c.lastActivityAt).filter(Boolean).sort().pop() || null;
  } catch { }
  return {
    container,
    lastActivity,
    service: await serviceState(),
    login: { state: LOGIN.state, user: LOGIN.user },
    bridge: {
      authorizedChat: cfg.chatId || '',
      chatName: cfg.chatName || '',
      botNick: cfg.botNick || '',
    },
    llm: {
      mode: normMode(env.XYY_LLM),
      model: env.XYY_LLM_MODEL || '',
      url: env.XYY_LLM_URL || '',
      chime: env.XYY_LLM_CHIME || '0',
      users: env.XYY_LLM_USERS || '',
      keySet: Boolean(env.XYY_LLM_KEY),
    },
    personaBytes: (() => { try { return fs.statSync(P.persona).size; } catch { return 0; } })(),
  };
}

async function getChats() {
  const list = await wxGet('/api/chats');
  const cfg = readJson(P.botConfig, {});
  return (Array.isArray(list) ? list : []).map((c) => ({
    id: c.id,
    name: c.name,
    isGroup: Boolean(c.isGroup),
    lastMessage: c.lastMessagePreview || '',
    lastSender: c.lastMessageSender || '',
    lastAt: c.lastActivityAt || '',
    unread: c.unreadCount || 0,
    selected: c.id === cfg.chatId,
  })).sort((a, b) => (b.isGroup - a.isGroup) || String(b.lastAt).localeCompare(String(a.lastAt)));
}

async function getMessages(chatId, limit = 30) {
  const list = await wxGet(`/api/messages/${encodeURIComponent(chatId)}?limit=${limit}`);
  const arr = Array.isArray(list) ? list : (list.messages || []);
  return arr.slice(-limit).map((m) => ({
    id: m.localId,
    at: m.timestamp,
    from: m.senderName || m.sender || '',
    self: Boolean(m.isSelf),
    mentioned: m.isMentioned === true,
    text: String(m.content || '').slice(0, 500),
  }));
}

function getPersona() {
  try { return fs.readFileSync(P.persona, 'utf8'); } catch { return ''; }
}

function getMemory() {
  const dir = P.memoryDir;
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { dir, users: [], group: null }; }
  const users = [];
  let group = null;
  for (const f of files) {
    const j = readJson(path.join(dir, f), null);
    if (!j) continue;
    if (f === '_group.json') { group = j; continue; }
    const slots = j.slots || {};
    const items = [];
    for (const [cat, arr] of Object.entries(slots)) {
      if (!Array.isArray(arr)) continue;
      for (const x of arr) if (x && x.t) items.push({ cat, text: x.t, at: x.at || null });
    }
    items.sort((a, b) => (b.at || 0) - (a.at || 0));
    users.push({
      file: f,
      name: j.nick || f.slice(0, 8),
      count: j.count || 0,
      facts: items.length,
      items: items.slice(0, 12),
      updatedAt: j.last || j.summarizedAt || null,
      pending: Array.isArray(j.pending) ? j.pending.length : 0,
      milestones: Array.isArray(j.milestones) ? j.milestones.filter((x) => x && x.t).map((x) => x.t) : [],
    });
  }
  users.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { dir, group, users };
}

// ---------- 服务控制（桥接 / 自动登录）----------
// 面板以 root 运行，固定参数调 systemctl；不接受任何用户拼接的命令。
const SERVICE = 'xiaoyouyou-aliyun.service';
const RELOGIN_TIMER = 'xiaoyouyou-auto-relogin.timer';

function execFileAsync(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || ''),
      });
    });
  });
}

async function serviceState() {
  const r = await execFileAsync('systemctl', ['show', SERVICE, '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState']);
  const kv = {};
  for (const line of r.out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return { active: kv.ActiveState || 'unknown', sub: kv.SubState || '', enabled: kv.UnitFileState || 'unknown' };
}

async function enableBridge() {
  const a = await execFileAsync('systemctl', ['enable', '--now', SERVICE], 60000);
  const b = await execFileAsync('systemctl', ['enable', '--now', RELOGIN_TIMER], 30000);
  return { ok: a.code === 0, error: a.code === 0 ? '' : (a.err || '').trim().slice(0, 300), timer: b.code === 0 };
}

async function restartBridge() {
  const st = await serviceState();
  if (st.enabled === 'disabled' && st.active !== 'active') {
    return { ok: false, skipped: true, error: '桥接还没启用（先在「群聊」里绑定授权群）' };
  }
  const r = await execFileAsync('systemctl', ['restart', SERVICE], 90000);
  return { ok: r.code === 0, error: r.code === 0 ? '' : (r.err || '').trim().slice(0, 300) };
}

// 恢复流程可能留下 blocked 的登录网关：登录成功后放行（写 resume，不删文件）
const GATE = path.join(PRIVATE, '.local/state/splatoon-bridge/login-gate.json');
function clearGate() {
  const g = readJson(GATE, null);
  if (!g || g.phase !== 'blocked') return false;
  atomicWrite(GATE, JSON.stringify({ ...g, phase: 'resume' }) + '\n', 0o600);
  return true;
}

// ---------- 扫码登录 ----------
// 走容器 WebSocket（与恢复流程同一入口），把二维码转成 PNG data URL 直接显示在面板里，
// 不需要 SSH 隧道到 6174，也不需要容器内的截图工具。
const LOGIN = { state: 'idle', startedAt: 0, qrAt: 0, qr: '', user: '', error: '', socket: null, timer: null };

function loginSnapshot() {
  return {
    state: LOGIN.state,
    startedAt: LOGIN.startedAt,
    qrAt: LOGIN.qrAt,
    qrAgeMs: LOGIN.qrAt ? Date.now() - LOGIN.qrAt : 0,
    qr: LOGIN.qr,
    user: LOGIN.user,
    error: LOGIN.error,
  };
}

async function qrDataUrl(text) {
  const QR = require('qrcode-terminal/vendor/QRCode');
  const level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  const qr = new QR(-1, level.M);
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + 8) * 8;
  let pixels = '';
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) if (qr.isDark(y, x)) pixels += `M${x + 4} ${y + 4}h1v1h-1z`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${count + 8} ${count + 8}"><rect width="100%" height="100%" fill="white"/><path d="${pixels}" fill="black" shape-rendering="crispEdges"/></svg>`;
  const png = await require('sharp')(Buffer.from(svg)).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

function loginFail(msg) {
  if (LOGIN.timer) clearTimeout(LOGIN.timer);
  LOGIN.timer = null;
  try { if (LOGIN.socket) LOGIN.socket.close(); } catch { }
  LOGIN.socket = null;
  LOGIN.state = 'failed';
  LOGIN.error = String(msg || '登录失败');
  LOGIN.qr = '';
}

// 首次部署没有锁定账号：登录成功后把真实 wxid 写下来，之后换号会被识别为异常。
function lockAccount(userId) {
  const id = String(userId || '');
  if (!/^wxid_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)?$/.test(id)) return false;
  const file = path.join(PRIVATE, 'expected-user.txt');
  try { if (fs.readFileSync(file, 'utf8').trim()) return false; } catch { }
  atomicWrite(file, id + '\n', 0o600);
  return true;
}

function loginOk(userId) {
  if (LOGIN.timer) clearTimeout(LOGIN.timer);
  LOGIN.timer = null;
  try { if (LOGIN.socket) LOGIN.socket.close(); } catch { }
  LOGIN.socket = null;
  LOGIN.state = 'success';
  LOGIN.user = String(userId || '');
  LOGIN.qr = '';
  LOGIN.error = '';
  lockAccount(LOGIN.user);
  clearGate();
}

function startLogin() {
  if (LOGIN.state === 'connecting' || LOGIN.state === 'waiting_scan' || LOGIN.state === 'phone_confirm') {
    return loginSnapshot();
  }
  if (typeof WebSocket !== 'function') {
    LOGIN.state = 'failed'; LOGIN.error = '需要 Node.js 22+（内置 WebSocket）';
    return loginSnapshot();
  }
  const token = wxToken();
  if (!token) {
    LOGIN.state = 'failed'; LOGIN.error = '读不到 AGENT_WECHAT_TOKEN（private/wechat.env）';
    return loginSnapshot();
  }
  Object.assign(LOGIN, { state: 'connecting', startedAt: Date.now(), qrAt: 0, qr: '', user: '', error: '' });
  const wsBase = WX_API.replace(/^http/, 'ws').replace(/\/+$/, '');
  const url = wsBase + '/api/ws/login?' + new URLSearchParams({ timeoutMs: '180000', newAccount: 'false', token });
  let ws;
  try { ws = new WebSocket(url); } catch (e) {
    LOGIN.state = 'failed'; LOGIN.error = e.message;
    return loginSnapshot();
  }
  LOGIN.socket = ws;
  LOGIN.timer = setTimeout(() => loginFail('扫码超时（3 分钟），请重新生成'), 185000);
  ws.addEventListener('message', async (ev) => {
    let v;
    try { v = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (v.type === 'qr') {
      const text = v.qrBinaryData ? Buffer.from(v.qrBinaryData).toString('utf8') : v.qrData;
      try {
        LOGIN.qr = await qrDataUrl(text);
        LOGIN.qrAt = Date.now();
        LOGIN.state = 'waiting_scan';
      } catch (e) { loginFail('二维码生成失败：' + e.message); }
    } else if (v.type === 'phone_confirm') {
      LOGIN.state = 'phone_confirm';
    } else if (v.type === 'login_success') {
      loginOk(v.userId);
    } else if (v.type === 'login_timeout') {
      loginFail('扫码超时，请重新生成');
    } else if (v.type === 'error') {
      loginFail('微信登录接口返回错误');
    }
  });
  ws.addEventListener('error', (ev) => {
    const m = (ev && ev.error && ev.error.message) || (ev && ev.message) || '';
    loginFail('登录连接失败' + (m ? '：' + m : '（容器没就绪？）'));
  });
  ws.addEventListener('close', () => {
    if (LOGIN.state !== 'success' && LOGIN.state !== 'failed') loginFail('登录连接结束，未确认成功');
  });
  return loginSnapshot();
}

function cancelLogin() {
  loginFail('已取消');
  LOGIN.state = 'idle';
  LOGIN.error = '';
  return loginSnapshot();
}

// ---------- 国内厂商预设 ----------
// 端点以厂商文档为准；面板里都可以手改，所以这里只负责「少填几个字段」。
const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', note: '官方 API，性价比高' },
  { id: 'qwen', name: '通义千问（阿里百炼）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', note: '百炼 OpenAI 兼容模式' },
  { id: 'kimi', name: 'Kimi（月之暗面）', url: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', note: '长上下文' },
  { id: 'glm', name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', note: 'glm-4-flash 免费额度多' },
  { id: 'hunyuan', name: '腾讯混元', url: 'https://api.hunyuan.cloud.tencent.com/v1/chat/completions', model: 'hunyuan-lite', note: 'OpenAI 兼容接口' },
  { id: 'doubao', name: '火山方舟（豆包）', url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'ep-xxxxxxxx', note: '模型填方舟「推理接入点 ID」（ep- 开头）' },
  { id: 'siliconflow', name: '硅基流动', url: 'https://api.siliconflow.cn/v1/chat/completions', model: 'Qwen/Qwen2.5-7B-Instruct', note: '聚合多家开源模型' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'deepseek/deepseek-chat', note: '需要外网' },
  { id: 'magpie', name: '自建 magpie / 本地网关', url: 'http://127.0.0.1:3430/v1/chat/completions', model: '', note: '本机或内网聚合网关' },
  { id: 'custom', name: '自定义（任意 OpenAI 兼容）', url: '', model: '', note: '自己填完整 URL' },
];

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (unauthorized(req, res)) return;

      if (p === '/api/status' && req.method === 'GET') return json(res, 200, await getStatus());
      if (p === '/api/login/status' && req.method === 'GET') return json(res, 200, { ok: true, login: loginSnapshot() });
      if (p === '/api/login/start' && req.method === 'POST') return json(res, 200, { ok: true, login: startLogin() });
      if (p === '/api/login/cancel' && req.method === 'POST') return json(res, 200, { ok: true, login: cancelLogin() });
      if (p === '/api/presets' && req.method === 'GET') return json(res, 200, { ok: true, presets: PRESETS });
      if (p === '/api/service' && req.method === 'GET') return json(res, 200, { ok: true, service: await serviceState() });
      if (p === '/api/chats' && req.method === 'GET') {
        try { return json(res, 200, { ok: true, chats: await getChats() }); }
        catch (e) { return json(res, 200, { ok: false, error: e.message, chats: [] }); }
      }
      if (p === '/api/messages' && req.method === 'GET') {
        try { return json(res, 200, { ok: true, messages: await getMessages(url.searchParams.get('chatId'), Number(url.searchParams.get('limit')) || 30) }); }
        catch (e) { return json(res, 200, { ok: false, error: e.message, messages: [] }); }
      }
      if (p === '/api/config' && req.method === 'GET') {
        return json(res, 200, { ok: true, config: readJson(P.botConfig, {}) });
      }
      if (p === '/api/config' && req.method === 'PUT') {
        const b = await body(req);
        const cur = readJson(P.botConfig, {});
        const next = {
          chatId: String(b.chatId ?? cur.chatId ?? ''),
          chatName: String(b.chatName ?? cur.chatName ?? ''),
          botNick: String(b.botNick ?? cur.botNick ?? '小鱿鱿'),
        };
        if (!/^\d+@chatroom$/.test(next.chatId)) return json(res, 400, { ok: false, error: '群 ID 必须是 xxx@chatroom' });
        if (!next.chatName.trim()) return json(res, 400, { ok: false, error: '群名不能为空' });
        atomicWrite(P.botConfig, JSON.stringify(next, null, 2) + '\n', 0o644);
        if (b.apply) {
          const r = await enableBridge();
          const service = await serviceState();
          return json(res, 200, {
            ok: true,
            config: next,
            service,
            applied: r.ok,
            note: r.ok ? '已启用桥接，几秒后开始工作' : ('配置已保存，但桥接启动失败：' + (r.error || '未知原因')),
          });
        }
        return json(res, 200, { ok: true, config: next, note: '需要重启桥接生效' });
      }
      if (p === '/api/persona' && req.method === 'GET') {
        return json(res, 200, { ok: true, persona: getPersona() });
      }
      if (p === '/api/persona' && req.method === 'PUT') {
        const b = await body(req);
        const text = String(b.persona ?? '');
        if (text.length > 8000) return json(res, 400, { ok: false, error: '人设超过 8000 字符' });
        atomicWrite(P.persona, text);
        return json(res, 200, { ok: true, bytes: Buffer.byteLength(text), note: '热加载，下一条消息生效' });
      }
      if (p === '/api/llm' && req.method === 'GET') {
        const env = readEnvMerged();
        return json(res, 200, {
          ok: true,
          llm: {
            mode: normMode(env.XYY_LLM),
            url: env.XYY_LLM_URL || '',
            model: env.XYY_LLM_MODEL || '',
            users: env.XYY_LLM_USERS || '',
            chime: env.XYY_LLM_CHIME || '0',
            chimeDaily: env.XYY_LLM_CHIME_DAILY || '',
            maxChars: env.XYY_LLM_MAX_CHARS || '',
            memory: env.XYY_LLM_MEMORY || '1',
            keySet: Boolean(env.XYY_LLM_KEY),
          },
        });
      }
      if (p === '/api/llm' && req.method === 'PUT') {
        const b = await body(req);
        const patch = {};
        if (b.mode !== undefined) {
          if (!['off', 'all', 'admin'].includes(b.mode)) return json(res, 400, { ok: false, error: 'mode 只能是 off/all/admin' });
          patch.XYY_LLM = b.mode;
        }
        for (const [k, key] of [['url', 'XYY_LLM_URL'], ['model', 'XYY_LLM_MODEL'], ['users', 'XYY_LLM_USERS'],
          ['chime', 'XYY_LLM_CHIME'], ['chimeDaily', 'XYY_LLM_CHIME_DAILY'], ['maxChars', 'XYY_LLM_MAX_CHARS'],
          ['memory', 'XYY_LLM_MEMORY']]) {
          if (b[k] !== undefined) patch[key] = String(b[k]);
        }
        // 密钥只在显式提供时覆盖，空字符串表示保持原值
        if (typeof b.key === 'string' && b.key.trim()) patch.XYY_LLM_KEY = b.key.trim();
        // LLM 配置写在 private/llm.env（桥接的 env-config 会加载 private/*.env）
        if (!fs.existsSync(P.llmEnv)) {
          atomicWrite(P.llmEnv, '# 小鱿鱿 LLM 闲聊配置\n');
        }
        writeEnvKeys(P.llmEnv, patch);
        if (b.apply) {
          const r = await restartBridge();
          return json(res, 200, {
            ok: true,
            file: 'llm.env',
            updated: Object.keys(patch),
            applied: r.ok,
            skipped: Boolean(r.skipped),
            service: await serviceState(),
            note: r.ok ? '已保存并重启桥接' : (r.skipped ? r.error : ('已保存，重启桥接失败：' + (r.error || '未知原因'))),
          });
        }
        return json(res, 200, { ok: true, file: 'llm.env', updated: Object.keys(patch), note: '需要重启桥接生效' });
      }
      if (p === '/api/memory' && req.method === 'GET') return json(res, 200, { ok: true, ...getMemory() });
      if (p === '/api/memory' && req.method === 'DELETE') {
        const file = url.searchParams.get('file') || '';
        if (!/^[a-f0-9]{24}\.json$|^_group\.json$/.test(file)) return json(res, 400, { ok: false, error: '非法文件名' });
        try { fs.unlinkSync(path.join(P.memoryDir, file)); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 404, { ok: false, error: e.message }); }
      }
      if (p === '/api/events' && req.method === 'GET') {
        let lines = [];
        try { lines = fs.readFileSync(P.events, 'utf8').trim().split('\n').slice(-30); } catch { }
        return json(res, 200, { ok: true, events: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
      }
      return json(res, 404, { ok: false, error: '未知接口' });
    }

    // 静态文件
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(full);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`小鱿鱿 WebUI: http://${HOST}:${PORT}`);
  console.log(`部署目录: ${BASE}${TOKEN ? ' | 已启用 WEBUI_TOKEN' : ' | 未设 WEBUI_TOKEN（仅本机可访问）'}`);
});
