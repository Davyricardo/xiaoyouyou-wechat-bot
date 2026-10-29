#!/usr/bin/env bash
# 小鱿鱿 一键部署：检查依赖 → 装代码 → 起容器 → 提示扫码
set -euo pipefail

DEST="${XYY_BASE:-/opt/xiaoyouyou}"
SRC="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 1. 依赖检查 ----------
say "检查依赖"
command -v docker >/dev/null || die "未安装 docker"
docker compose version >/dev/null 2>&1 || die "未安装 docker compose 插件"
command -v node >/dev/null || die "未安装 Node.js（需要 22+）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 版本过低：$(node -v)，需要 22+"

MEM_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
[ "$MEM_MB" -ge 1900 ] || say "警告：内存只有 ${MEM_MB}MB，微信客户端可能吃紧（建议 2GB+）"

# ---------- 2. 安装代码 ----------
say "安装到 $DEST"
mkdir -p "$DEST/private"
cp -r "$SRC/src/." "$DEST/"
cp -r "$SRC/tools" "$DEST/"
[ -d "$SRC/assets" ] && cp -r "$SRC/assets" "$DEST/"
[ -d "$SRC/refs" ] && cp -r "$SRC/refs" "$DEST/"
cp "$SRC/docker-compose.yml" "$SRC/.env.example" "$DEST/"
cp "$SRC/ARCHITECTURE.md" "$DEST/" 2>/dev/null || true

cd "$DEST"
[ -f node_modules ] || true
say "安装 Node 依赖"
(cd "$DEST" && npm install --omit=dev --no-audit --no-fund)

# ---------- 3. 配置 ----------
if [ ! -f "$DEST/private/wechat.env" ]; then
  say "生成 private/wechat.env（请按需修改）"
  cp "$DEST/.env.example" "$DEST/private/wechat.env"
  TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s|^AGENT_WECHAT_TOKEN=.*|AGENT_WECHAT_TOKEN=$TOKEN|" "$DEST/private/wechat.env"
  chmod 600 "$DEST/private/wechat.env"
  say "已生成容器 token 并写入 private/wechat.env"
else
  say "private/wechat.env 已存在，跳过"
fi

if [ ! -f "$DEST/bot-config.json" ]; then
  cat > "$DEST/bot-config.json" <<'JSON'
{
  "chatId": "123456789@chatroom",
  "chatName": "示例交流群",
  "botNick": "小鱿鱿"
}
JSON
  say "已生成 bot-config.json 模板，请填入真实群 ID / 群名"
fi

# ---------- 4. 起容器 ----------
say "启动微信容器"
set -a; . "$DEST/private/wechat.env"; set +a
docker compose up -d

say "等待容器就绪（首次拉镜像可能需要几分钟）"
for i in $(seq 1 60); do
  if curl -sf -m 3 -H "Authorization: Bearer ${AGENT_WECHAT_TOKEN}" \
       http://127.0.0.1:6174/api/status >/dev/null 2>&1; then
    say "容器已就绪"; break
  fi
  sleep 5
  [ "$i" = 60 ] && die "容器 5 分钟内未就绪，看日志：docker logs splatoon-wechat-test"
done

cat <<EOF

========================================
 部署完成，还差两步：

 1) 扫码登录微信（首次必须）
    容器起来后在浏览器打开：
      http://127.0.0.1:6174
    （或在本机用 ssh -L 6174:127.0.0.1:6174 转发后打开）

 2) 填入真实群 ID 后启动桥接：
    vim $DEST/bot-config.json
    cd $DEST && node bridge-v3.3.js

 保活（可选）：
    cp tools/systemd/*.service tools/systemd/*.timer /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now xiaoyouyou-auto-relogin.timer
========================================
EOF
