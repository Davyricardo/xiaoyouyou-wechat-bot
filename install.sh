#!/usr/bin/env bash
# 小鱿鱿一键部署（全新机器）
#
#   sudo bash install.sh                # 自动装依赖 → 部署 → 起容器 → 起面板
#   sudo bash install.sh --local        # 面板只监听 127.0.0.1（SSH 隧道访问）
#   sudo bash install.sh --dry-run      # 只打印将要执行的动作，不改系统
#   sudo bash install.sh --no-deps      # 跳过依赖安装（docker/node 已就绪时）
#   sudo bash install.sh --base /srv/xyy --port 9000
#   sudo bash install.sh --image registry.cn-hangzhou.aliyuncs.com/<ns>/agent-wechat:0.12.0-mentions.6
#
# 装完只差两步：打开面板 → 微信扫码 → 选群设为授权群（会自动启用桥接）。
set -euo pipefail

DEST="${XYY_BASE:-/opt/xiaoyouyou}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBUI_HOST="0.0.0.0"
WEBUI_PORT="8088"
DRY=0
SKIP_DEPS=0
CONF_ONLY=0
IMAGE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --base) DEST="$2"; shift 2 ;;
    --port) WEBUI_PORT="$2"; shift 2 ;;
    --host) WEBUI_HOST="$2"; shift 2 ;;
    --local) WEBUI_HOST="127.0.0.1"; shift ;;
    --dry-run) DRY=1; shift ;;
    --no-deps) SKIP_DEPS=1; shift ;;
    --configure-only) CONF_ONLY=1; shift ;;
    --image) IMAGE="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '  [dry] %s\n' "$*"; else "$@"; fi; }

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# ---------------------------------------------------------------- 0. 前置检查
say "检查运行环境"
[ "$(id -u)" = 0 ] || [ "$CONF_ONLY" = 1 ] || die "请用 root 运行：sudo bash install.sh"
[ -f "$SRC/src/package.json" ] || die "没找到 src/package.json，请在仓库根目录运行"
[ -f "$SRC/docker-compose.yml" ] || die "没找到 docker-compose.yml"
case "$(uname -m)" in
  x86_64|aarch64|arm64) : ;;
  *) die "不支持的架构：$(uname -m)（需要 x86_64 或 aarch64）" ;;
esac
ok "root / $(uname -m) / $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo Linux)"

MEM_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
[ "$MEM_MB" -ge 1900 ] || warn "内存只有 ${MEM_MB}MB，微信客户端可能吃紧（建议 2GB+）"

# ---------------------------------------------------------------- 1. 依赖
install_node() {
  local ver arch tmp
  arch="$(uname -m)"; case "$arch" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; esac
  ver="$(curl -fsSL -m 20 https://nodejs.org/dist/latest-v22.x/ | grep -oE 'node-v22\.[0-9]+\.[0-9]+' | head -1 || true)"
  [ -n "$ver" ] || die "下载 Node.js 版本信息失败，请手动安装 Node 22+ 后重跑（--no-deps）"
  tmp="$(mktemp -d)"
  say "下载 ${ver}-linux-${arch}"
  curl -fsSL -m 300 -o "$tmp/node.tar.xz" "https://nodejs.org/dist/latest-v22.x/${ver}-linux-${arch}.tar.xz" \
    || die "下载 Node.js 失败（网络受限？）可手动安装 Node 22+ 后加 --no-deps"
  tar -xJf "$tmp/node.tar.xz" -C "$tmp"
  run install -d /usr/local/lib/nodejs
  run cp -a "$tmp/${ver}-linux-${arch}/." /usr/local/lib/nodejs/
  run ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  run ln -sf /usr/local/lib/nodejs/bin/npm /usr/local/bin/npm
  run ln -sf /usr/local/lib/nodejs/bin/npx /usr/local/bin/npx
  rm -rf "$tmp"
  hash -r
}

install_docker() {
  say "安装 Docker（官方脚本）"
  command -v curl >/dev/null 2>&1 || die "缺少 curl，无法自动安装 Docker"
  run bash -c 'curl -fsSL https://get.docker.com | sh' || die "Docker 安装失败，请手动安装后加 --no-deps"
}

if [ "$CONF_ONLY" = 1 ]; then
  say "仅生成配置（--configure-only）：跳过依赖安装、容器与 systemd"
elif [ "$SKIP_DEPS" = 1 ]; then
  say "跳过依赖安装（--no-deps）"
else
  command -v docker >/dev/null 2>&1 || install_docker
  command -v docker >/dev/null 2>&1 || die "docker 不可用"
  if ! docker compose version >/dev/null 2>&1; then
    say "安装 docker compose 插件"
    if command -v apt-get >/dev/null 2>&1; then
      run apt-get update -qq || true
      run apt-get install -y -qq docker-compose-plugin || run apt-get install -y -qq docker-compose-v2 || true
    fi
    docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件，请手动安装后重跑"
  fi
  ok "docker $(docker --version | awk '{print $3}' | tr -d ,) / compose $(docker compose version --short 2>/dev/null || echo ok)"

  command -v node >/dev/null 2>&1 || install_node
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 22 ]; then
    say "当前 Node $(node -v) 低于 22，安装 Node 22 到 /usr/local"
    install_node
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$NODE_MAJOR" -ge 22 ] || die "Node.js 仍是 $(node -v)，需要 22+"
  fi
  ok "node $(node -v)"
fi

NODE_BIN="$(command -v node || true)"
if [ "$CONF_ONLY" != 1 ]; then
  [ -n "$NODE_BIN" ] || die "找不到 node"
  command -v systemctl >/dev/null 2>&1 || die "需要 systemd（本脚本用 systemd 管进程）"
fi

# ---------------------------------------------------------------- 2. 安装代码
say "安装到 $DEST"
run install -d -m 755 "$DEST" "$DEST/cache" "$DEST/backups"
run install -d -m 700 "$DEST/private"
# 代码扁平放到 $DEST（与历史部署布局一致）；private/ 单独保留，绝不覆盖。
# 用 tar 排除 node_modules：从本地工作副本跑时不要把开发依赖一起搬过去。
copy_src() {
  if [ "$DRY" = 1 ]; then
    printf '  [dry] 复制 src/ → %s（排除 node_modules/private）\n' "$DEST"
    return 0
  fi
  tar -C "$SRC/src" --exclude=node_modules --exclude=private -cf - . | tar -C "$DEST" -xf -
}
copy_src
for d in tools webui assets refs; do
  [ -d "$SRC/$d" ] && run cp -a "$SRC/$d" "$DEST/"
done
for f in docker-compose.yml .env.example ARCHITECTURE.md NOTICE.md README.md; do
  [ -f "$SRC/$f" ] && run cp -a "$SRC/$f" "$DEST/"
done
ok "代码已就位（保留已有的 private/ 配置）"

say "安装 Node 依赖"
if [ "$DRY" = 1 ] || [ "$CONF_ONLY" = 1 ]; then
  printf '  [skip] npm install（%s）\n' "$([ "$DRY" = 1 ] && echo dry-run || echo configure-only)"
else
  ( cd "$DEST" && npm install --omit=dev --no-audit --no-fund >/tmp/xyy-npm-install.log 2>&1 ) \
    || die "npm install 失败，日志：/tmp/xyy-npm-install.log"
fi
ok "依赖安装完成"

# ---------------------------------------------------------------- 3. 配置
# 3.1 微信容器 token：只在缺失时生成，重跑不换 token（换了容器要重建）
ENV_FILE="$DEST/private/wechat.env"
if [ ! -f "$ENV_FILE" ]; then
  say "生成 private/wechat.env"
  if [ "$DRY" = 1 ]; then
    printf '  [dry] 写入 %s（含随机 AGENT_WECHAT_TOKEN）\n' "$ENV_FILE"
  else
    TOKEN="$(rand_hex 32)"
    sed "s|^AGENT_WECHAT_TOKEN=.*|AGENT_WECHAT_TOKEN=$TOKEN|" "$SRC/.env.example" > "$ENV_FILE"
    grep -q '^AGENT_WECHAT_TOKEN=' "$ENV_FILE" || printf 'AGENT_WECHAT_TOKEN=%s\n' "$TOKEN" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
else
  ok "private/wechat.env 已存在，保留（token 不轮换）"
fi

# 3.1b 自定义镜像仓库（阿里云 ACR 等），写进 wechat.env 供 compose 插值
if [ -n "$IMAGE" ]; then
  say "使用自定义镜像：$IMAGE"
  if [ "$DRY" != 1 ]; then
    if grep -q '^XYY_IMAGE=' "$ENV_FILE"; then
      sed -i "s|^XYY_IMAGE=.*|XYY_IMAGE=$IMAGE|" "$ENV_FILE"
    else
      printf 'XYY_IMAGE=%s\n' "$IMAGE" >> "$ENV_FILE"
    fi
  fi
fi

# 3.2 LLM 配置单独一个文件（env-config 会合并 private/*.env）
LLM_FILE="$DEST/private/llm.env"
if [ ! -f "$LLM_FILE" ]; then
  say "生成 private/llm.env（LLM 闲聊配置，面板里可改）"
  if [ "$DRY" != 1 ]; then
    cat > "$LLM_FILE" <<'LLMENV'
# 小鱿鱿 LLM 闲聊配置（WebUI「聊天」页会改写这个文件）
# 面板里选厂商会自动填好 URL/模型；也可以手动填任意 OpenAI 兼容网关。
XYY_LLM=off
XYY_LLM_URL=
XYY_LLM_MODEL=
XYY_LLM_KEY=
XYY_LLM_USERS=
XYY_LLM_MEMORY=1
XYY_LLM_CHIME=0
XYY_LLM_CHIME_DAILY=12
XYY_LLM_MAX_CHARS=300
LLMENV
    chmod 600 "$LLM_FILE"
  fi
else
  ok "private/llm.env 已存在，保留"
fi

# 3.3 默认人设
PERSONA="$DEST/private/persona.md"
if [ ! -f "$PERSONA" ]; then
  if [ "$DRY" != 1 ]; then
    cat > "$PERSONA" <<'PERSONA'
你是一只住在群里的鱿鱼，说话简短、有点毒舌但不刻薄。
遇到技术问题会认真回答，遇到闲聊会接梗，不装可爱也不刷屏。

群友：今天打工好累
小鱿鱿：那就别打了，来我这儿摸鱼
PERSONA
    chmod 600 "$PERSONA"
  fi
  ok "已写入默认人设（面板「人设」页可改）"
fi

# 3.4 面板访问配置
WEBUI_ENV="$DEST/private/webui.env"
if [ ! -f "$WEBUI_ENV" ]; then
  say "生成 private/webui.env（面板地址与访问令牌）"
  if [ "$DRY" != 1 ]; then
    WUI_TOKEN="$(rand_hex 16)"
    cat > "$WEBUI_ENV" <<WEBUIENV
# 小鱿鱿 WebUI：面板能改配置、重启服务，等于半个管理员权限
WEBUI_HOST=$WEBUI_HOST
WEBUI_PORT=$WEBUI_PORT
WEBUI_TOKEN=$WUI_TOKEN
XYY_BASE=$DEST
WX_API_BASE=http://127.0.0.1:6174
WEBUIENV
    chmod 600 "$WEBUI_ENV"
  fi
else
  ok "private/webui.env 已存在，保留（访问令牌不轮换）"
fi

# 3.5 群配置占位：桥接由面板绑定群后才启用
CFG="$DEST/bot-config.json"
if [ ! -f "$CFG" ]; then
  if [ "$DRY" != 1 ]; then
    cat > "$CFG" <<'JSON'
{
  "chatId": "123456789@chatroom",
  "chatName": "待绑定",
  "botNick": "小鱿鱿"
}
JSON
    chmod 644 "$CFG"
  fi
  ok "已写入 bot-config.json 占位（面板「群聊」页绑定真实群）"
fi

# ---------------------------------------------------------------- 4. 起容器
if [ "$CONF_ONLY" != 1 ]; then
say "启动微信容器"
if [ "$DRY" = 1 ]; then
  printf '  [dry] cd %s && docker compose --env-file private/wechat.env up -d\n' "$DEST"
else
  ( cd "$DEST" && docker compose --env-file private/wechat.env up -d ) || die "容器启动失败：docker compose logs"
fi

say "等待容器就绪（首次拉镜像可能要几分钟）"
if [ "$DRY" != 1 ]; then
  TOKEN_VAL="$(sed -n 's/^AGENT_WECHAT_TOKEN=//p' "$ENV_FILE" | head -1)"
  ready=0
  for i in $(seq 1 60); do
    if curl -sf -m 3 -H "Authorization: Bearer $TOKEN_VAL" \
         http://127.0.0.1:6174/api/status >/dev/null 2>&1; then
      ok "容器已就绪"; ready=1; break
    fi
    sleep 5
  done
  [ "$ready" = 1 ] || die "容器 5 分钟内未就绪，看日志：cd $DEST && docker compose logs --tail=50"
fi
fi

# ---------------------------------------------------------------- 5. systemd
if [ "$CONF_ONLY" != 1 ]; then
say "安装 systemd 服务"
UNIT_SRC="$DEST/tools/systemd"
[ "$DRY" = 1 ] && UNIT_SRC="$SRC/tools/systemd"
[ -d "$UNIT_SRC" ] || die "缺少 tools/systemd"
install_unit() {
  local name="$1"
  [ -f "$UNIT_SRC/$name" ] || { warn "缺少单元 $name，跳过"; return 0; }
  if [ "$DRY" = 1 ]; then
    printf '  [dry] 安装 %s → /etc/systemd/system/\n' "$name"
  else
    sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__DEST__|$DEST|g" \
      "$UNIT_SRC/$name" > "/etc/systemd/system/$name"
    chmod 644 "/etc/systemd/system/$name"
  fi
}
for u in xiaoyouyou-aliyun.service xiaoyouyou-webui.service \
         xiaoyouyou-watchdog.service xiaoyouyou-watchdog.timer \
         xiaoyouyou-auto-relogin.service xiaoyouyou-auto-relogin.timer; do
  install_unit "$u"
done
run systemctl daemon-reload

say "启用面板与看门狗"
run systemctl enable --now xiaoyouyou-webui.service
run systemctl enable --now xiaoyouyou-watchdog.timer
# 已绑定真实群（重跑安装）就顺手把桥接和自动登录拉起来；
# 还是占位群就保持未启用，等面板里选群后再 enable —— 避免重启机器后桥接悄悄不自启。
if [ -f "$CFG" ] && ! grep -q '123456789@chatroom' "$CFG"; then
  ok "检测到已绑定授权群，启用桥接与自动登录"
  run systemctl enable --now xiaoyouyou-aliyun.service
  run systemctl enable --now xiaoyouyou-auto-relogin.timer
else
  run systemctl disable xiaoyouyou-aliyun.service 2>/dev/null || true
  run systemctl disable xiaoyouyou-auto-relogin.timer 2>/dev/null || true
fi
fi

# ---------------------------------------------------------------- 6. 输出
if [ "$CONF_ONLY" = 1 ]; then
  say "配置已生成到 $DEST（未安装依赖、未起容器、未装 systemd）"
  cat <<EOF

 目录结构：
   $DEST/private/wechat.env   容器 token（已随机生成）
   $DEST/private/llm.env      LLM 配置（面板「聊天」页改写）
   $DEST/private/webui.env    面板地址与访问令牌
   $DEST/private/persona.md   人设
   $DEST/bot-config.json      群配置占位

 补完剩余步骤：sudo bash install.sh --no-deps（同一目录，配置不会被覆盖）
EOF
  exit 0
fi

if [ "$DRY" = 1 ]; then
  say "dry-run 结束，未改动系统"
  exit 0
fi

WUI_TOKEN="$(sed -n 's/^WEBUI_TOKEN=//p' "$WEBUI_ENV" | head -1)"
HOST_SHOW="$WEBUI_HOST"
if [ "$HOST_SHOW" = "0.0.0.0" ] || [ "$HOST_SHOW" = "::" ]; then
  PUB_IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || true)"
  [ -n "$PUB_IP" ] || PUB_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  HOST_SHOW="${PUB_IP:-<服务器IP>}"
fi
URL="http://${HOST_SHOW}:${WEBUI_PORT}/?token=${WUI_TOKEN}"

cat <<EOF

============================================================
 部署完成，接下来只有两步：

 1) 打开管理面板（已带访问令牌，直接点）
      $URL

    面板里点「登录」→ 用要当机器人的微信小号扫码 → 手机确认。

 2) 面板「群聊」→ 选一个群 → 「设为授权群并启用」
    桥接会自动启动，之后群里 @机器人 就能用了。

 面板地址与令牌存在：$WEBUI_ENV
 改端口/只允许本机访问：编辑该文件后 systemctl restart xiaoyouyou-webui

 常用命令：
   systemctl status xiaoyouyou-aliyun.service     # 桥接
   systemctl status xiaoyouyou-webui.service      # 面板
   journalctl -u xiaoyouyou-aliyun -f             # 桥接日志
   cd $DEST && docker compose logs --tail=50      # 微信容器日志

 ⚠️ 面板能改配置、重启服务，等于半个管理员权限：
    公网使用时务必保留 token，或改 --local 只走 SSH 隧道。
============================================================
EOF
