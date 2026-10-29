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
    users.push({
      file: f,
      name: j.name || j.nickname || j.user || f.slice(0, 8),
      messages: Array.isArray(j.history) ? j.history.length : (Array.isArray(j.messages) ? j.messages.length : 0),
      updatedAt: j.updatedAt || j.at || null,
      summary: j.summary || j.profile || '',
    });
  }
  return { dir, group, users };
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      if (unauthorized(req, res)) return;

      if (p === '/api/status' && req.method === 'GET') return json(res, 200, await getStatus());
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
