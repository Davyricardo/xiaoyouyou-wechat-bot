#!/bin/sh
# 在香橙派上抓数据并推送到阿里云（阿里云直连 splatoon3.ink 会超时）。
#
# ⚠ 契约：缓存文件必须是 {"at": <毫秒>, "data": <原始 payload>}。
# 阿里云侧 net.js 的 cached() 只认这个形状：
#   at     —— 新鲜度判定用（TTL：schedules 35min / festivals 6h / locale 6h）
#   data   —— 原始 payload，valid() 校验的是它
# 旧版只给 schedules 加了包装，festivals.json 原样落地 → at 缺失、valid(data=undefined) 必失败
# → 阿里云侧判定「没有缓存」→ 每 20 秒去连一次 splatoon3.ink（必超时 25 秒）→
#   祭典功能永久不可用，同时一直挂着一个 socket（这是「进程收到 SIGTERM 后不退」的直接推手之一）。
# locale.json 之前根本没有任何脚本在推，6 小时后会静默失效。
#
# 本版：三类数据统一包装、统一校验、统一推送；抓取/校验失败绝不覆盖已有的好文件。
set -eu
cd /home/user/splatoon-data

TMPD=/home/user/splatoon-data/.tmp
mkdir -p "$TMPD"
WRAP="$TMPD/wrap.py"
cat > "$WRAP" <<'PY'
import json, sys, time
raw = json.load(open(sys.argv[1]))
if not eval(sys.argv[3], {'d': raw}):
    raise SystemExit('payload schema mismatch: ' + sys.argv[1])
json.dump({'at': int(time.time() * 1000), 'data': raw}, open(sys.argv[2], 'w'), ensure_ascii=False)
PY

# FETCH <name> <url> <TTL秒> <python 校验表达式（用 d 指代 payload）>
FETCH() {
  name=$1; url=$2; ttl=$3; check=$4
  cur="$name.json"
  if [ -f "$cur" ] && [ $(( $(date +%s) - $(stat -c %Y "$cur") )) -le "$ttl" ]; then
    echo "  $name 仍在 TTL 内，跳过"
    return 0
  fi
  if ! curl -fsS --max-time 25 -o "$TMPD/$name.raw" "$url"; then
    echo "  $name 抓取失败，保留旧文件" >&2
    rm -f "$TMPD/$name.raw"
    return 0
  fi
  if ! python3 "$WRAP" "$TMPD/$name.raw" "$TMPD/$name.wrapped" "$check"; then
    echo "  $name 校验失败，保留旧文件" >&2
    rm -f "$TMPD/$name.raw" "$TMPD/$name.wrapped"
    return 0
  fi
  mv "$TMPD/$name.wrapped" "$cur"
  rm -f "$TMPD/$name.raw"
  echo "  $name 已更新（$(wc -c < "$cur") bytes）"
}

echo "$(date '+%F %T') sync start"
FETCH schedules https://splatoon3.ink/data/schedules.json 1800 \
  "isinstance(d.get('data'),dict) and isinstance(d['data'].get('vsStages'),dict) and isinstance(d['data']['vsStages'].get('nodes'),list)"
FETCH festivals https://splatoon3.ink/data/festivals.json 21600 \
  "any(isinstance(d.get(r),dict) and isinstance(d[r].get('data'),dict) and isinstance(d[r]['data'].get('festRecords'),dict) for r in ('JP','AP','US','EU'))"
FETCH locale https://splatoon3.ink/data/locale/zh-CN.json 21600 \
  "isinstance(d.get('stages'),dict) and isinstance(d.get('weapons'),dict)"

for f in schedules festivals locale; do
  test -s "$f.json" || { echo "  $f.json 为空，中止推送" >&2; exit 1; }
  scp -q -o BatchMode=yes "$f.json" "aliyun-jump:/tmp/xyy-$f.json"
done

ssh -o BatchMode=yes aliyun-jump '
  set -e
  for f in schedules festivals locale; do
    test -s /tmp/xyy-$f.json
    sudo install -o root -g root -m 600 /tmp/xyy-$f.json /opt/xiaoyouyou/cache/schedules/$f.json
    rm -f /tmp/xyy-$f.json
  done
'

echo "$(date '+%F %T') synced schedules=$(wc -c < schedules.json) festivals=$(wc -c < festivals.json) locale=$(wc -c < locale.json)"

# 祭典海报：在 assets.splatoon3.ink（另一个域名），阿里云同样连不上，
# 卡片顶部会画成空占位块。所以海报也在这里抓、一起推过去。
# 失败不影响日程推送，只记一行。
if ! sh /home/user/projects/xyy-review/tools/sync-fest-assets.sh 2>&1 | sed 's/^/  /'; then
  echo "  (祭典海报同步失败，日程不受影响)" >&2
fi

