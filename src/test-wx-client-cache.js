'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setupEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyy-wxcache-'));
  const cacheFile = path.join(dir, 'auth-cache.json');
  const eventsFile = path.join(dir, 'recovery-events.jsonl');
  process.env.XYY_AUTH_CACHE_FILE = cacheFile;
  process.env.XYY_EVENTS_FILE = eventsFile;
  process.env.AGENT_WECHAT_TOKEN = 'test-token-only';
  return { dir, cacheFile, eventsFile };
}

test('statusCached：新鲜的 logged_in 缓存命中且不请求远端', async () => {
  const { dir, cacheFile, eventsFile } = setupEnv();
  const oldFetch = globalThis.fetch;
  let fetchCalls = 0;
  let liveRes = { status: 'logged_in', loggedInUser: 'wxid_bot_account' };
  globalThis.fetch = async () => {
    fetchCalls++;
    return { ok: true, json: async () => liveRes };
  };
  try {
    const client = require('./wx-client');
    const first = await client.statusCached({ maxAgeMs: 240000 });
    assert.equal(first.status, 'logged_in');
    assert.equal(fetchCalls, 1);
    assert.equal(fs.existsSync(cacheFile), true);

    const second = await client.statusCached({ maxAgeMs: 240000 });
    assert.equal(second.status, 'logged_in');
    assert.equal(second.cached, true);
    assert.equal(fetchCalls, 1, '命中缓存不应发起 HTTP 请求');

    // force=true 强制绕过缓存
    const forced = await client.statusCached({ maxAgeMs: 240000, force: true });
    assert.equal(forced.cached, undefined);
    assert.equal(fetchCalls, 2);

    // 写入晚于 cache.at 的异常事件后，必须绕过缓存
    const cached = client.readAuthCache();
    fs.writeFileSync(eventsFile, JSON.stringify({ id: '1-aa', type: 'send_timeout', at: cached.at + 10 }) + '\n');
    const afterBad = await client.statusCached({ maxAgeMs: 240000 });
    assert.equal(afterBad.cached, undefined);
    assert.equal(fetchCalls, 3);

    // logged_out 状态绝不命中缓存（每次实查）
    liveRes = { status: 'logged_out' };
    const out1 = await client.statusCached({ maxAgeMs: 240000, force: true });
    assert.equal(out1.status, 'logged_out');
    assert.equal(fetchCalls, 4);
    const out2 = await client.statusCached({ maxAgeMs: 240000 });
    assert.equal(out2.status, 'logged_out');
    assert.equal(fetchCalls, 5, 'logged_out 不应走缓存');
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.XYY_AUTH_CACHE_FILE;
    delete process.env.XYY_EVENTS_FILE;
    delete process.env.AGENT_WECHAT_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
