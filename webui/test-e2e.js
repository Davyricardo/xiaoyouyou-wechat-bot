#!/usr/bin/env node
'use strict';
/**
 * WebUI 端到端验收（不需要真实微信容器）。
 *
 *   node webui/test-e2e.js            # 跑测试
 *   node webui/test-e2e.js --mock     # 只起假容器 API（测试内部也这样用）
 *
 * 假容器 API（HTTP + 登录 WebSocket）+ 假 systemctl + 临时 XYY_BASE。
 * 覆盖：登录二维码 → 账号锁定、绑定群即启用桥接、LLM 预设与自动重启、密钥不回显。
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = process.env.XYY_TEST_ROOT || path.join(require('node:os').tmpdir(), 'xyy-webui-e2e');
const BASE = path.join(ROOT, 'base');
const PRIV = path.join(BASE, 'private');
const API_PORT = Number(process.env.XYY_TEST_API_PORT) || 16174;
const WEBUI_PORT = Number(process.env.XYY_TEST_WEBUI_PORT) || 18088;
const API = 'http://127.0.0.1:' + WEBUI_PORT;

// ---------- 假容器 ----------
function runMock() {
  const TOKEN = process.env.TOKEN || 'test-token';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!(req.headers.authorization || '').includes(TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/api/status') {
      return send({ container: 'running', loginState: { status: 'logged_out' }, capabilities: ['group-mentions-v1'], version: '0.12.0-mentions.6' });
    }
    if (u.pathname === '/api/status/auth') return send({ status: 'logged_out', loggedInUser: null });
    if (u.pathname === '/api/chats') {
      return send([{ id: '123456789@chatroom', name: '测试群', isGroup: true, lastMessagePreview: '你好', lastActivityAt: new Date().toISOString(), unreadCount: 0 }]);
    }
    if (u.pathname.startsWith('/api/messages/')) {
      return send([{ localId: 7, timestamp: new Date().toISOString(), senderName: '甲', isSelf: false, isMentioned: true, content: '@小鱿鱿 地图' }]);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });

  const frame = (obj) => {
    const p = Buffer.from(JSON.stringify(obj));
    let head;
    if (p.length < 126) head = Buffer.from([0x81, p.length]);
    else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(p.length, 2); }
    return Buffer.concat([head, p]);
  };

  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const send = (o) => socket.write(frame(o));
    setTimeout(() => send({ type: 'qr', qrData: 'https://login.weixin.qq.com/l/mock-qr-token' }), 150);
    setTimeout(() => send({ type: 'phone_confirm' }), 700);
    setTimeout(() => send({ type: 'login_success', userId: 'wxid_testbot_1234' }), 1200);
    socket.on('data', () => { });
    socket.on('error', () => { });
  });

  server.listen(API_PORT, '127.0.0.1', () => console.log('mock container api on ' + API_PORT));
}

// ---------- 假 systemctl ----------
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
S=${ROOT}/svc-state
echo "$*" >> ${ROOT}/systemctl-calls.log
[ -f "$S" ] || printf 'inactive\\ndead\\ndisabled\\n' > "$S"
a=$(sed -n 1p "$S"); s=$(sed -n 2p "$S"); u=$(sed -n 3p "$S")
case "$1" in
  show) printf 'ActiveState=%s\\nSubState=%s\\nUnitFileState=%s\\n' "$a" "$s" "$u" ;;
  enable) printf '%s\\n%s\\nenabled\\n' "$a" "$s" > "$S" ;;
  disable) printf '%s\\n%s\\ndisabled\\n' "$a" "$s" > "$S" ;;
  start|restart) printf 'active\\nrunning\\n%s\\n' "$u" > "$S" ;;
  stop) printf 'inactive\\ndead\\n%s\\n' "$u" > "$S" ;;
esac
exit 0
`;

// ---------- 测试 ----------
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p, opts) => (await fetch(API + p, opts)).json();

function nodeModulesPath() {
  const candidates = [
    path.join(__dirname, 'node_modules'),
    path.join(__dirname, '..', 'node_modules'),
    path.join(__dirname, '..', 'src', 'node_modules'),
  ];
  return candidates.find((p) => fs.existsSync(path.join(p, 'sharp'))) || '';
}

function seed() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(PRIV, '.local/state/splatoon-bridge'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'bin/systemctl'), SYSTEMCTL_STUB.replace(/\$\{ROOT\}/g, ROOT));
  fs.chmodSync(path.join(ROOT, 'bin/systemctl'), 0o755);
  fs.writeFileSync(path.join(PRIV, 'wechat.env'), 'AGENT_WECHAT_TOKEN=test-token\n');
  fs.writeFileSync(path.join(PRIV, 'llm.env'), '# 注释必须保留\nXYY_LLM=off\nXYY_LLM_KEY=\n');
  fs.writeFileSync(path.join(PRIV, 'persona.md'), '测试人设\n');
  fs.writeFileSync(path.join(BASE, 'bot-config.json'),
    JSON.stringify({ chatId: '123456789@chatroom', chatName: '测试群', botNick: '小鱿鱿' }, null, 2));
}

async function main() {
  seed();
  const mock = spawn(process.execPath, [__filename, '--mock'], {
    env: { ...process.env, PORT: String(API_PORT), TOKEN: 'test-token' }, stdio: 'inherit',
  });
  const webui = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      PATH: path.join(ROOT, 'bin') + ':' + process.env.PATH,
      NODE_PATH: nodeModulesPath(),
      XYY_BASE: BASE,
      WX_API_BASE: 'http://127.0.0.1:' + API_PORT,
      WEBUI_HOST: '127.0.0.1',
      WEBUI_PORT: String(WEBUI_PORT),
      WEBUI_TOKEN: '',
    },
    stdio: 'inherit',
  });

  try {
    // 等 webui 起来并且假容器已可达（mock 与 webui 是并发启动的）
    for (let i = 0; i < 60; i++) {
      try {
        const d = await get('/api/status');
        if (d.container && d.container.ok) break;
      } catch { }
      await sleep(250);
    }

    const st = await get('/api/status');
    check('状态接口返回容器信息', Boolean(st.container && st.container.ok), st.container && st.container.version);
    check('状态接口返回桥接服务态', st.service && st.service.active === 'inactive', JSON.stringify(st.service));

    const pre = await get('/api/presets');
    const ids = (pre.presets || []).map((p) => p.id);
    check('厂商预设 >= 8 家', ids.length >= 8, ids.join(','));
    for (const want of ['deepseek', 'qwen', 'kimi', 'glm', 'doubao', 'siliconflow', 'magpie']) {
      check('预设包含 ' + want, ids.includes(want));
    }

    const chats = await get('/api/chats');
    check('群列表可读', chats.ok === true && chats.chats.length === 1, chats.chats && chats.chats[0] && chats.chats[0].name);

    const s1 = await get('/api/login/start', { method: 'POST' });
    check('登录会话启动', ['connecting', 'waiting_scan', 'success'].includes(s1.login.state), s1.login.state);

    let login = s1.login;
    let sawQr = false;
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      login = (await get('/api/login/status')).login;
      if (login.qr && login.qr.startsWith('data:image/png;base64,')) sawQr = true;
      if (login.state === 'success') break;
    }
    check('二维码已生成 PNG data URL', sawQr);
    check('登录流程走到 success', login.state === 'success', login.state + ' ' + (login.error || ''));
    check('登录拿到账号', login.user === 'wxid_testbot_1234', login.user);

    const lockFile = path.join(PRIV, 'expected-user.txt');
    check('账号自动锁定到 expected-user.txt',
      fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8').trim() === 'wxid_testbot_1234');

    const cfg = await get('/api/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: '123456789@chatroom', chatName: '测试群', apply: true }),
    });
    check('绑定群返回 applied', cfg.ok === true && cfg.applied === true, String(cfg.note));
    const calls1 = fs.readFileSync(path.join(ROOT, 'systemctl-calls.log'), 'utf8');
    check('启用桥接调用了 systemctl enable', calls1.includes('enable --now xiaoyouyou-aliyun.service'));
    check('同时启用了自动登录 timer', calls1.includes('enable --now xiaoyouyou-auto-relogin.timer'));

    const llm = await get('/api/llm', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'all', url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', key: 'sk-test-123', apply: true }),
    });
    check('LLM 保存成功', llm.ok === true, JSON.stringify(llm.updated));
    const envText = fs.readFileSync(path.join(PRIV, 'llm.env'), 'utf8');
    check('llm.env 写入模式与模型', /^XYY_LLM=all$/m.test(envText) && /^XYY_LLM_MODEL=deepseek-chat$/m.test(envText));
    check('llm.env 写入密钥', /^XYY_LLM_KEY=sk-test-123$/m.test(envText));
    check('llm.env 注释未被抹掉', envText.startsWith('# 注释必须保留'));
    const calls2 = fs.readFileSync(path.join(ROOT, 'systemctl-calls.log'), 'utf8');
    check('LLM 保存触发重启', calls2.includes('restart xiaoyouyou-aliyun.service'));

    const llmRead = await get('/api/llm');
    check('密钥不回显（只给 keySet）',
      llmRead.llm.keySet === true && !JSON.stringify(llmRead).includes('sk-test-123'));
  } finally {
    await sleep(150);
    webui.kill('SIGKILL');
    mock.kill('SIGKILL');
  }

  const fail = results.filter((r) => !r.ok);
  console.log('\n===== ' + (results.length - fail.length) + '/' + results.length + ' 通过 =====');
  if (fail.length) {
    console.log('失败：' + fail.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}

if (process.argv.includes('--mock')) runMock();
else main().catch((e) => { console.error('测试异常', e); process.exitCode = 1; });
