#!/usr/bin/env python3
"""香橙派侧：读取阿里云的事件日志，只投递判定端标记了 notify=true 的 result 事件。

由 xiaoyouyou-relogin-notify.timer 每 5 分钟拉起。责任边界（ARCHITECTURE.md）：
这里不做任何「是不是掉线 / 要不要提醒」的判断，只按事件 id 去重后投递。
通知频率由阿里云侧的 recovery-core.notifyDecision() 在写事件时决定，
所以持续失败时不会每轮刷一条（旧实现连发 30 条 needs_scan 就是这个原因）。
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/home/user/.local/state/xiaoyouyou-aliyun')
MARK = ROOT / 'relogin-notify.json'
# 唯一仲裁者：pi-aliyun-monitor.py 的状态。它正在处理事故时由它负责通知，
# 这里只推进水位线不说话——这是「两条通知链合并成一条」的开关。
MONITOR = ROOT / 'monitor.json'
MONITOR_STALE_MS = 10 * 60 * 1000
# 远端事件日志（阿里云）。ssh 命令保持短：别名承担地址/密钥，参数用列表拼，不嵌套引号。
REMOTE_LOG = '/opt/xiaoyouyou/private/.local/state/splatoon-bridge/recovery-events.jsonl'
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'aliyun-jump', 'tail', '-n', '200', REMOTE_LOG]
HERMES = os.environ.get('XYY_HERMES_BIN') or '/home/user/.hermes/hermes-agent/.hermes/bin/hermes'
HERMES_HOME = os.environ.get('XYY_HERMES_HOME') or '/home/user/.hermes'
# 通知目标（管理员 IM ID / Telegram chat id）不再写死在代码里。
# 读取顺序：进程环境变量（systemd EnvironmentFile）→ private 目录下的 *.env。
# 环境变量名与 Node 侧 env-config.js 保持一致：
#   XYY_ADMIN_IM_ID / XYY_ADMIN_IM_IDS / XYY_ADMIN_IM_PLATFORM（默认 weixin）
#   XYY_TELEGRAM_CHAT_ID
_env_cache = None


def _private_dirs():
    # 每次都按当前环境算：测试和 systemd EnvironmentFile 都可能在中途改变取值
    return [d for d in (
        os.environ.get('XYY_PRIVATE_DIR'),
        os.path.join(os.environ['XYY_HOME'], 'private') if os.environ.get('XYY_HOME') else None,
        os.path.join(os.path.expanduser('~'), 'private'),
    ) if d]


def _private_env():
    # .env 文件：KEY=VALUE，忽略注释/空行/export 前缀，支持引号包裹
    global _env_cache
    if _env_cache is not None:
        return _env_cache
    merged = {}
    for directory in _private_dirs():
        try:
            names = sorted(n for n in os.listdir(directory) if n.endswith('.env'))
        except OSError:
            continue
        for name in names:
            try:
                with open(os.path.join(directory, name), encoding='utf-8') as handle:
                    text = handle.read()
            except OSError:
                continue
            for line in text.splitlines():
                body = line.strip()
                if not body or body.startswith('#'):
                    continue
                if body.startswith('export '):
                    body = body[len('export '):].strip()
                if '=' not in body:
                    continue
                key, value = body.split('=', 1)
                value = value.strip()
                if len(value) > 1 and value[0] == value[-1] and value[0] in ('"', "'"):
                    value = value[1:-1]
                if key.strip():
                    merged[key.strip()] = value
    _env_cache = merged
    return merged


def secret(*names):
    # 进程环境变量优先，其次 private/*.env；都读不到返回 None（由调用方跳过或报错）
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    files = _private_env()
    for name in names:
        value = files.get(name)
        if value and value.strip():
            return value.strip()
    return None


def notify_targets():
    # 返回 (通道列表, 缺失的变量名列表)。缺哪个就明说哪个，不要静默跳过。
    targets, missing = [], []
    platform = secret('XYY_ADMIN_IM_PLATFORM') or 'weixin'
    user = secret('XYY_ADMIN_IM_IDS', 'XYY_ADMIN_IM_ID')
    if user:
        targets.append('%s:%s' % (platform, user.split(',')[0].strip()))
    else:
        missing.append('XYY_ADMIN_IM_ID')
    chat = secret('XYY_TELEGRAM_CHAT_ID')
    if chat:
        targets.append('telegram:%s' % chat)
    else:
        missing.append('XYY_TELEGRAM_CHAT_ID')
    return targets, missing
# needs_scan 是个筐，里面是不同原因：登录失败要人扫码，桥接起不来只需要等。
# 判定端在事件里写 reason，这里按 reason 选文案，缺 reason 时退回按 result 的兜底文案。
REASON_TEXTS = {
    'login_failed': '小鱿鱿掉线且自动登录失败，需要你扫码',
    'login_unconfirmed': '小鱿鱿自动登录未确认成功，可能需要你扫码',
    'recycle_login_failed': '小鱿鱿内存回收后自动登录失败，需要你扫码',
    'bridge_not_active': '小鱿鱿已登录，但桥接没能启动，正在自动重试',
    'bridge_restart_failed': '小鱿鱿桥接反复重启失败，已暂停重试等下一轮',
    'version_changed': '小鱿鱿的微信客户端指纹变了（可能被更新或被替换），请检查是否需要重新登录',
}
TEXTS = {
    'recovered': '小鱿鱿掉线后已自动登录并恢复',
    'needs_scan': '小鱿鱿自动登录失败，需要你扫码',
    'restarted': '小鱿鱿桥接曾停止，已自动重启',
    'gate_cleared': '小鱿鱿恢复流程的登录闸门已自动放行',
    'recycled': '小鱿鱿内存过高，已主动重启并恢复',
}


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temp.chmod(0o600)
    temp.replace(path)


def parse_events(text):
    """按行解析 JSONL；跳过半行/坏行/缺字段的行，一行损坏不影响投递。"""
    out = []
    for line in (text or '').splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and isinstance(value.get('at'), int) and isinstance(value.get('id'), str):
            out.append(value)
    return out


def text_for(event):
    """按 reason 选文案；没有 reason 或未知 reason 时退回 result 的兜底文案。"""
    reason = event.get('reason')
    if reason in REASON_TEXTS:
        return REASON_TEXTS[reason]
    return TEXTS.get(event.get('result'))


def pick_pending(events, last_id=None, last_at=None, now=None, max_age_ms=30*60*1000):
    """返回「判定端要求通知、尚未投递、且不过期」的最新一条事件；没有就返回 None。纯函数。

    只看 type=result 且 notify is True：检测事件（send_timeout）和 noop 不进通知渠道。
    去重用水位线 (last_at, last_id)：只处理晚于水位线的事件。旧实现只跳过「恰好等于
    last_id」的那一条，于是最新一条已投递后，循环会回退到更早的一条并重复发送
    （实测同一条 recovered 被发了三次）。
    超过 max_age_ms 的历史事件一律不发：避免重启或补跑时把几小时前的事翻出来。
    """
    pending = None
    for event in events:
        if event.get('type') != 'result' or event.get('notify') is not True:
            continue
        if event.get('result') not in TEXTS:
            continue
        at = event.get('at')
        if not isinstance(at, int):
            continue
        if last_id is not None and event.get('id') == last_id:
            continue
        if last_at is not None and at < last_at:
            continue
        if now is not None and now - at > max_age_ms:
            continue
        pending = event
    return pending


def send(message):
    # 通道顺序照 pi-aliyun-monitor.py：微信优先 → Telegram(chat_id)，每通道重试一次。
    # 单次超时必须 ≥30s：实测 hermes send 冷启动约 18s（CLI 启动 + 网关往返），
    # 12s 会让每次投递都超时失败。预算 2 通道 x 2 次 x 30s = 120s，落在 TimeoutStartSec=180 内。
    targets, missing = notify_targets()
    if not targets:
        print('relogin-notify: 未配置通知目标（缺 %s），跳过投递' % '、'.join(missing),
              file=sys.stderr, flush=True)
        return False
    for target in targets:
        for attempt in (1, 2):
            try:
                p = subprocess.run([HERMES, 'send', '--to', target, '--json', message],
                                   cwd=HERMES_HOME,
                                   env={**os.environ, 'HERMES_HOME': HERMES_HOME},
                                   capture_output=True, text=True, timeout=30)
            except subprocess.TimeoutExpired:
                if attempt == 1:
                    time.sleep(1)
                continue
            try:
                value = json.loads(p.stdout.strip())
                if p.returncode == 0 and value.get('success') is True:
                    return True
            except json.JSONDecodeError:
                for line in reversed(p.stdout.strip().splitlines()):
                    try:
                        value = json.loads(line)
                        if p.returncode == 0 and value.get('success') is True:
                            return True
                    except json.JSONDecodeError:
                        pass
    return False


def remote_events():
    # 短命令 + 8s 连接超时；远端文件还没生成时 tail 非 0，按「没消息」处理。
    p = subprocess.run(SSH, capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        return []
    return parse_events(p.stdout)


def load_mark():
    try:
        return json.loads(MARK.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def incident_active(now=None, path=None, max_age_ms=MONITOR_STALE_MS):
    """pi-aliyun-monitor 是否正在处理一次事故（status != online 且心跳新鲜）。纯函数式，便于测试。

    合并通知链的判据：一次事故里，掉线/恢复/二维码/升级提醒全部由 pi-aliyun-monitor 发；
    事件通知器只在「监控没有事故在途」时才说话——它补的是监控看不见的短故障
    （重启 9 秒就自愈，30 秒采样根本抓不到，但事件日志里有 recovered）。
    监控超过 max_age_ms 没心跳视作它自己挂了，这时不压制，宁可多发也不要全静默。
    """
    try:
        state = json.loads((path or MONITOR).read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False
    checked = state.get('checkedAt')
    if not isinstance(checked, int):
        return False
    if now is not None and now - checked > max_age_ms:
        return False
    return state.get('status') != 'online'


def main():
    now = int(time.time() * 1000)
    mark = load_mark()
    line = pick_pending(remote_events(), mark.get('lastId'), mark.get('lastAt'), now)
    if not line:
        return 0
    if incident_active(now):
        # 监控正在处理这次事故，它自己会告知。只推进水位线，不重复发。
        atomic(MARK, {'lastId': line['id'], 'lastAt': line['at'], 'result': line['result'],
                      'suppressed': True})
        print('XYY_NOTIFY relogin suppressed', line['result'], line['id'], flush=True)
        return 0
    text = text_for(line)
    if not text:
        return 0
    if not send(text):
        print('relogin-notify: delivery failed, retry next tick', file=sys.stderr, flush=True)
        return 1
    atomic(MARK, {'lastId': line['id'], 'lastAt': line['at'], 'result': line['result'],
                  'suppressed': False})
    print('XYY_NOTIFY relogin', line['result'], line['id'], flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
