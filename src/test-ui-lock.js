'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tryAcquireUiLock, acquireUiLock, withUiLock } = require('./ui-lock');

function tempLock(name = 'ui.lock') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xyy-uilock-'));
  return { dir, file: path.join(dir, name) };
}

test('互斥锁：同一时间仅允许一个持有者，释放后可再次获取', () => {
  const { dir, file } = tempLock();
  try {
    const a = tryAcquireUiLock('wx-fast', { lockFile: file, ttlMs: 30000 });
    assert.equal(a.acquired, true);
    const b = tryAcquireUiLock('open-guard', { lockFile: file, ttlMs: 30000 });
    assert.equal(b.acquired, false);
    assert.equal(b.holder.owner, 'wx-fast');
    a.release();
    const c = tryAcquireUiLock('open-guard', { lockFile: file, ttlMs: 30000 });
    assert.equal(c.acquired, true);
    c.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('排队等待：前序锁释放后 withUiLock 按序执行', async () => {
  const { dir, file } = tempLock();
  try {
    const order = [];
    const holder = tryAcquireUiLock('first', { lockFile: file, ttlMs: 30000 });
    assert.equal(holder.acquired, true);
    setTimeout(() => {
      order.push('release-first');
      holder.release();
    }, 80);

    const out = await withUiLock('second', async () => {
      order.push('run-second');
      return 42;
    }, { lockFile: file, waitMs: 2000, pollMs: 20 });

    assert.equal(out, 42);
    assert.deepEqual(order, ['release-first', 'run-second']);
    assert.equal(fs.existsSync(file), false, '执行完成后锁文件应已释放');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('过期锁清理：超过 ttlMs 的锁会被自动接管', () => {
  const { dir, file } = tempLock();
  try {
    let clock = 100000;
    const stale = tryAcquireUiLock('stalled', { lockFile: file, ttlMs: 5000, now: () => clock });
    assert.equal(stale.acquired, true);

    clock += 6000;
    const takeover = tryAcquireUiLock('fresh', { lockFile: file, ttlMs: 5000, now: () => clock });
    assert.equal(takeover.acquired, true);
    // 旧持有者延迟调用 release() 时，因 token 不匹配不应误删新持有者的锁
    stale.release();
    assert.equal(fs.existsSync(file), true, '旧持有者不能误删新锁');
    takeover.release();
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('死进程锁清理：PID 不存在时立即接管', () => {
  const { dir, file } = tempLock();
  try {
    fs.writeFileSync(file, JSON.stringify({
      pid: 9999999,
      owner: 'dead-worker',
      at: Date.now(),
      ttlMs: 60000,
      token: 'dead',
    }));
    const acquired = tryAcquireUiLock('new-worker', { lockFile: file, ttlMs: 30000 });
    assert.equal(acquired.acquired, true);
    acquired.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proceedOnTimeout=false 时超时返回 skipped 不执行回调', async () => {
  const { dir, file } = tempLock();
  try {
    const holder = tryAcquireUiLock('busy', { lockFile: file, ttlMs: 30000 });
    assert.equal(holder.acquired, true);
    let ran = false;
    const res = await withUiLock('late', async () => { ran = true; return 'ok'; }, {
      lockFile: file, waitMs: 60, pollMs: 20, proceedOnTimeout: false,
    });
    assert.equal(ran, false);
    assert.equal(res.skipped, true);
    assert.equal(res.holder.owner, 'busy');
    holder.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireUiLock 超时返回 acquired=false', async () => {
  const { dir, file } = tempLock();
  try {
    const holder = tryAcquireUiLock('blocker', { lockFile: file, ttlMs: 30000 });
    const res = await acquireUiLock('waiter', { lockFile: file, waitMs: 50, pollMs: 20 });
    assert.equal(res.acquired, false);
    holder.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
