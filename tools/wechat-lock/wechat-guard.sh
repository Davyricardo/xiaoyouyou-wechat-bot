#!/usr/bin/env bash
# 微信版本守卫（阿里云侧，每 10 分钟一次 + 开机一次）
#
# 做两件事：
#   1. 确保容器内 /etc/hosts 屏蔽了更新下载域名（entrypoint 里已经有一份，
#      这里兜底：万一下次重建镜像丢了 entrypoint 补丁，最迟 10 分钟内补回来）。
#   2. 记录 /opt/wechat/wechat 的 sha256 指纹；一旦变化就往事件日志写一条
#      needs_scan（reason=version_changed），由香橙派的通知器推给本人。
#      客户端装在 root 所有的目录里、wechat 用户不可写，所以「正常情况永远不会变」——
#      变了就说明镜像被换过或被 docker cp 覆盖过，必须人看一眼。
set -uo pipefail
umask 077

C=splatoon-wechat-test
BASE=/opt/xiaoyouyou
STATE=$BASE/private/wechat-version.json
EVENTS=$BASE/private/.local/state/splatoon-bridge/recovery-events.jsonl
BIN=/opt/wechat/wechat

log(){ printf '%s %s\n' "$(date '+%F %T')" "$*"; }

running=$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null || echo false)
if [ "$running" != "true" ]; then
  log "容器未运行，跳过"
  exit 0
fi

# ---- 1. 域名拦截（幂等，失败不影响后续）----
docker exec "$C" sh -c "grep -q 'dldir1.qq.com' /etc/hosts 2>/dev/null || printf '0.0.0.0 dldir1.qq.com\n0.0.0.0 dldir1v6.qq.com\n' >> /etc/hosts" 2>/dev/null

# ---- 2. 指纹比对 ----
# 平时只取 size+mtime（一次 stat，代价可以忽略）。整份 141MB 二进制算 sha256 每 10 分钟
# 读一遍，对这台 2GB 内存、跑着 1GiB 微信容器的机器是白白的 IO 与 page cache 压力 ——
# 而「客户端被压到 unresponsive 然后被杀」正是这里最贵的一种故障。
# 只有 size/mtime 变了才去算 sha256 确认，确认变了才告警。
meta=$(docker exec "$C" stat -c '%s:%Y' "$BIN" 2>/dev/null)
if [ -z "${meta:-}" ]; then
  log "取不到 $BIN 的状态（容器刚起？），本轮跳过"
  exit 0
fi

# 快路径：meta 没变就直接结束，连 python 都不启动，更不碰那 141MB。
old_meta=$(python3 -c "import json,sys;print((json.load(open(sys.argv[1])) or {}).get('meta',''))" "$STATE" 2>/dev/null || true)
if [ -n "${old_meta:-}" ] && [ "$old_meta" = "$meta" ]; then
  log "unchanged $meta"
  exit 0
fi

# 只有 meta 变了才校验内容，避免"仅时间戳被 touch"被误报成换版本。
verify=""
if [ -n "${old_meta:-}" ]; then
  verify=$(docker exec "$C" sha256sum "$BIN" 2>/dev/null | cut -d' ' -f1)
fi

python3 - "$STATE" "$EVENTS" "$meta" "${verify:-}" <<'PY'
import json, secrets, sys, time
from pathlib import Path

state_path, events_path, meta = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
new_sha = sys.argv[4] if len(sys.argv) > 4 else ''
old = {}
try:
    old = json.loads(state_path.read_text())
except Exception:
    pass

def save(**kw):
    state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_path.write_text(json.dumps({**kw, 'at': int(time.time()*1000)}, ensure_ascii=False))

old_meta = old.get('meta')
old_sha = old.get('sha256')

if old_meta is None:
    # 老版本的 state 只存了 sha256：补上 meta，不告警
    save(meta=meta, sha256=new_sha or old_sha)
    print('baseline recorded', meta)
    raise SystemExit(0)

if old_meta == meta:
    print('unchanged', meta)
    raise SystemExit(0)

# meta 变了但内容 sha 一样：只是时间戳被动过，不算换版本
if new_sha and old_sha and new_sha == old_sha:
    save(meta=meta, sha256=new_sha)
    print('meta touched, content unchanged', meta)
    raise SystemExit(0)

at = int(time.time() * 1000)
event = {
    'id': '%d-%s' % (at, secrets.token_hex(4)),
    'type': 'result',
    'at': at,
    'result': 'needs_scan',
    'reason': 'version_changed',
    'notify': True,
    'detail': '微信客户端指纹变化 %s -> %s' % (old_meta, meta),
    'host': 'aliyun',
}
events_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
with events_path.open('a', encoding='utf-8') as fh:
    fh.write(json.dumps(event, ensure_ascii=False) + '\n')
save(meta=meta, sha256=new_sha, previous=old_meta)
print('CHANGED', old_meta, '->', meta)
PY

