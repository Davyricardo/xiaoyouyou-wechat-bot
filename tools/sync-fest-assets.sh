#!/bin/sh
# 在香橙派上跑：抓祭典海报 -> 打包【增量】-> 推到阿里云 -> 安装
#
# 2026-10-23 改：祭典改成全量预取（27 张 / ~25MB）。不能每 30 分钟把 25MB 整个传一遍，
# 也不能每 30 分钟为「什么都没变」去问一次远端。三层收敛：
#   1. 索引（entries.json / rotation.json）内容没变时不重写 → 下面算出的 H 就不变；
#   2. H 和上次推送相同、且上次推送在 7 天内 → 直接退出，不碰网络（实测 0.7 秒）；
#   3. 要走网络时，先取远端 sha256，只打包「缺的或内容不同的」图。
# 7 天强制复核一次，防的是远端被人手删了文件而这边一直以为同步好了。
#
# 安装器自己也在包里，远端先覆盖再执行 —— 否则改了安装逻辑却永远跑旧的那份
# （踩过：加了「全量模式清旧条目」，但 /opt 里还是老文件，僵尸条目一直清不掉）。
# 手动全量重发：FORCE=1 sh sync-fest-assets.sh
set -eu
# cron 的默认 PATH 只有 /usr/bin:/bin，node 装在 /usr/local/bin，不补会报 node: not found。
export PATH="/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"
TOOLS=/home/user/projects/xyy-review/tools
cd /home/user/projects/xyy-review/src || exit 1
node festival-assets.js

D=/home/user/splatoon-data/fest-assets
test -f "$D/entries.json" || { echo "没有 entries.json，跳过推送"; exit 0; }

# 注意：续行的 | 和 && 必须留在上一行末尾，dash 不接受行首的管道符/连接符
H=$(sha256sum "$D/entries.json" "$D/rotation.json" "$TOOLS/festival-assets-install.js" | \
  sha256sum | cut -d' ' -f1)
STAMP="$D/.pushed"
NOW=$(date +%s)
LAST_AT=0
LAST_H=""
if [ -f "$STAMP" ]; then
  LAST_AT=$(cut -d' ' -f1 < "$STAMP")
  LAST_H=$(cut -d' ' -f2 < "$STAMP")
fi

if [ "${FORCE:-0}" != "1" ] && [ "$H" = "$LAST_H" ] && [ -n "$LAST_AT" ] && \
   [ $((NOW - LAST_AT)) -lt 604800 ]; then
  echo "海报与索引均无变化（上次推送 $(( (NOW - LAST_AT) / 3600 )) 小时前），跳过"
  exit 0
fi

# 远端现有文件的指纹（目录还不存在时给空）
REMOTE=$(ssh -o BatchMode=yes aliyun-jump \
  'cd /opt/xiaoyouyou/assets/festivals 2>/dev/null && sha256sum *.png teams/*.png 2>/dev/null' || true)

# 只传「缺的或内容不同的」。海报在根目录、阵营立绘在 teams/ 子目录，两份循环分开写
# （函数里带 $1/$2 的 awk 一行在 dash 下会报 "word unexpected"，不折腾）
NEED=""
for p in "$D"/*.png; do
  [ -f "$p" ] || continue
  f=$(basename "$p")
  want=$(sha256sum "$p" | cut -d' ' -f1)
  have=$(printf '%s\n' "$REMOTE" | awk -v n="$f" '$2==n{print $1; exit}')
  if [ "$want" != "$have" ]; then NEED="$NEED $f"; fi
done
for p in "$D"/teams/*.png; do
  [ -f "$p" ] || continue
  f=$(basename "$p")
  want=$(sha256sum "$p" | cut -d' ' -f1)
  have=$(printf '%s\n' "$REMOTE" | awk -v n="teams/$f" '$2==n{print $1; exit}')
  if [ "$want" != "$have" ]; then NEED="$NEED teams/$f"; fi
done

if [ -z "$NEED" ]; then
  echo "海报无变化（云端已是最新），只同步索引与安装器"
else
  echo "需要推送:$(printf '%s' "$NEED" | wc -w) 个文件"
fi

# shellcheck disable=SC2086
tar -czf /tmp/xyy-fest.tgz -C "$D" entries.json rotation.json $NEED \
  -C "$TOOLS" festival-assets-install.js

scp -q -o BatchMode=yes /tmp/xyy-fest.tgz aliyun-jump:/tmp/xyy-fest.tgz
ssh -o BatchMode=yes aliyun-jump '
  set -e
  rm -rf /tmp/xyy-fest && mkdir -p /tmp/xyy-fest && tar -xzf /tmp/xyy-fest.tgz -C /tmp/xyy-fest
  sudo install -m 644 /tmp/xyy-fest/festival-assets-install.js /opt/xiaoyouyou/festival-assets-install.js
  sudo /usr/bin/node /opt/xiaoyouyou/festival-assets-install.js /tmp/xyy-fest
  sudo install -m 644 /tmp/xyy-fest/rotation.json /opt/xiaoyouyou/cache/festival-rotation.json
  rm -rf /tmp/xyy-fest /tmp/xyy-fest.tgz
'
printf '%s %s\n' "$NOW" "$H" > "$STAMP"
echo "祭典海报已推送"
