'use strict';
// 容器看门狗：只负责把「被停掉 / 意外退出」的微信容器拉起来。
// 绝不登录、绝不生成二维码、绝不发送二维码；登录仍走人工审批流程。
//
// 关于 login-gate：gate 的作用是暂停桥接发送，避免干扰扫码/校验。
// 容器已经停止时不存在可被干扰的扫描流程，gate 反而会把系统锁死在停机状态
// （真实故障：旧事件残留 gate + 容器被停 = 永久卡死），因此容器停止时不看 gate。
// 需要人工长时间停机时，创建 watchdog-disabled 标记文件。
process.env.HOME = '/opt/xiaoyouyou/private';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const infra = require('./recovery-infrastructure');

const CONTAINER = 'splatoon-wechat-test';
const HOUR = 3600000;
const MAX_PER_HOUR = 3;

function running() {
  try {
    return execFileSync('docker', ['inspect', CONTAINER, '--format', '{{.State.Running}}'], {
      encoding: 'utf8', timeout: 8000,
    }).trim() === 'true';
  } catch {
    return null; // null = 容器不存在
  }
}

function maintenance() {
  return fs.existsSync(path.join(infra.ROOT, 'watchdog-disabled'));
}

function out(value, code = 0) {
  console.log(JSON.stringify(value));
  process.exit(code);
}

const now = Date.now();
const state = running();

if (state === null) out({ ok: false, action: 'skip', reason: 'container_missing' }, 1);
if (state === true) out({ ok: true, action: 'none', reason: 'container_running' });
if (maintenance()) out({ ok: true, action: 'skip', reason: 'maintenance_flag' });

let s;
try {
  s = infra.read('watchdog.json') || {};
} catch {
  s = {};
}
s.starts = (Array.isArray(s.starts) ? s.starts : []).filter((t) => now - t < HOUR);
if (s.starts.length >= MAX_PER_HOUR) {
  out({ ok: false, action: 'skip', reason: 'rate_limited', starts: s.starts.length }, 1);
}

try {
  execFileSync('docker', ['start', CONTAINER], { encoding: 'utf8', timeout: 30000 });
  s.starts.push(now);
  infra.write('watchdog.json', s);
  out({ ok: true, action: 'started', at: now, startsInLastHour: s.starts.length });
} catch (e) {
  s.starts.push(now);
  infra.write('watchdog.json', s);
  out({ ok: false, action: 'start_failed', error: e.message }, 1);
}
