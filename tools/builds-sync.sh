#!/usr/bin/env bash
# 配装数据同步：香橙派预取 → rsync 到阿里云 VPS。
#
#   prefetch-builds.js 全量跑一遍（sendou.ink、raw.githubusercontent 在香橙派可达）
#   rsync -a --delete cache/builds/ → aliyun-jump:/opt/xiaoyouyou/cache/builds/
#   日志追加到 ~/builds-sync.log，只保留最近 200 行
#
# 用法：tools/builds-sync.sh
# 退出码：预取或 rsync 任一非 0 则非 0。单把武器取不到数据只记进摘要，不算失败。
# 预取失败也照常 rsync：把现有缓存（含过期数据）同步过去，好过远端什么都没有。
set -uo pipefail
# cron 的默认 PATH 只有 /usr/bin:/bin，node 装在 /usr/local/bin，不补会报 node: not found。
export PATH="/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/cache/builds"
DEST="aliyun-jump:/opt/xiaoyouyou/cache/builds/"
LOG="$HOME/builds-sync.log"
KEEP=200

mkdir -p "$SRC"

rcfile="$(mktemp)"
trap 'rm -f "$rcfile"' EXIT

{
  echo "=== $(date '+%F %T') builds-sync start"

  node "$REPO/tools/prefetch-builds.js"
  prefetch_rc=$?
  echo "prefetch exit=$prefetch_rc"

  rsync -a --delete "$SRC/" "$DEST"
  rsync_rc=$?
  echo "rsync exit=$rsync_rc"

  echo "=== $(date '+%F %T') builds-sync done (prefetch=$prefetch_rc rsync=$rsync_rc)"
  echo "$prefetch_rc $rsync_rc" > "$rcfile"
} 2>&1 | tee -a "$LOG" >/dev/null

# 日志只留最近 KEEP 行：先写临时文件再替换，避免 tail 读到正在写的文件
tail_tmp="$(mktemp)"
tail -n "$KEEP" "$LOG" > "$tail_tmp" && mv "$tail_tmp" "$LOG"

read -r prefetch_rc rsync_rc < "$rcfile" || { echo "builds-sync: 没拿到退出码，见 $LOG" >&2; exit 1; }
[ "$prefetch_rc" -eq 0 ] && [ "$rsync_rc" -eq 0 ]
