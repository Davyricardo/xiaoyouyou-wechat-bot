# 小鱿鱿 · XiaoYouyou

> 一个跑在 **2GB 内存**云服务器上的微信群聊机器人：群友 @ 它就能查斯普拉遁 3 的赛程、打工排班、随机武器和配装，也能在群里闲聊。
> 代码结构上它是一套「微信容器 + 桥接程序 + 指令机器人 + 自动聊天 + 保活」的完整实现，适合拿来学微信自动化、长连接机器人和进程保活。

<p>
<img alt="node" src="https://img.shields.io/badge/Node.js-22%2B-339933">
<img alt="docker" src="https://img.shields.io/badge/Docker-required-2496ED">
<img alt="license" src="https://img.shields.io/badge/license-MIT-blue">
<img alt="mem" src="https://img.shields.io/badge/RAM-2GB%2B-orange">
</p>

---

## 它解决什么问题

微信群机器人常见的难点不是「怎么发消息」，而是：

1. **群消息只能靠轮询**——没有官方 Webhook，必须持续拉消息、维护游标、处理重启丢消息；
2. **客户端会掉线**——微信桌面客户端在容器里会崩、会被健康监控杀掉、会掉登录态，需要一整套「检测 → 判定 → 执行 → 通知」的保活；
3. **要能长期不腐化**——判定逻辑必须收敛到纯函数，否则加两个功能就变成屎山。

这个项目就是在这三点上踩过坑之后的实现。

## 功能

| 模块 | 说明 |
|---|---|
| **@ 触发与指令** | 只有群友真实 @ 机器人（`isMentioned`）才处理，纯文本 `@昵称` 不算；指令走白名单，带参数的指令支持 `@小鱿鱿 配装 斯普拉射击枪` |
| **人设设定** | `private/persona.md` 定义性格与示范对话，改完**下一条消息就生效**（按 mtime 热加载）；硬规则（不 @、不发链接、限长）写在代码里，人设文件覆盖不掉 |
| **自动聊天** | `llm-chat.js` 接任意 OpenAI 兼容网关（默认 `http://127.0.0.1:3430/v1/chat/completions`），支持「只回 @」「按概率插话」「定时冒泡」三种模式 |
| **对话记忆** | `llm-memory.js` 按群保存最近对话与用户画像，重启不丢 |
| **卡片渲染** | 赛程表、打工排班、随机武器、配装卡，用 `sharp` 在进程内合成 PNG 直接发图 |
| **保活** | 容器健康监控、掉线自动重登、内存水位回收、事件日志（`recovery-events.jsonl`）单一状态机 |
| **WebUI 管理面板** | 本地面板：读群/选群、改人设、调聊天参数、看记忆（`webui/`，零依赖） |
| **systemd 单元** | 桥接、自动登录、通知投递、看门狗，开箱可用 |

## 架构

```
微信群
  │  （轮询 /api/messages，250ms）
  ▼
微信容器  agent-wechat（X11 + 官方 Linux 微信）
  │  HTTP API :6174（本机回环）
  ▼
桥接程序  src/bridge-v3.3.js      游标、指令分发、图片发送、事件写入
  ├── 指令机器人  src/xiaoyouyou-v3.3.js    指令 → 文本/卡片
  ├── 自动聊天    src/llm-chat.js + llm-memory.js
  └── 保活        src/recovery-*.js + tools/auto-relogin.js
                        │
                        ▼
              事件日志 recovery-events.jsonl（唯一状态）
                        │
                        ▼
              通知进程 tools/auto-relogin-notify.py
```

**设计约束（改代码前请先读 `ARCHITECTURE.md`）**：检测、判定、执行、通知四个角色各自只有一个主人；判定全部收敛到 `recovery-core.js` 的纯函数；新增判据只能读同一份事件日志。

## 快速开始

### 前置条件

- Linux 云服务器，**2GB 内存以上**（微信客户端本身占 300–600MB）
- Docker + Docker Compose
- Node.js **22+**
- 一个**小号**微信账号（不要用主号，自动化有封号风险）

### 一键部署

```bash
git clone https://github.com/<your-name>/xiaoyouyou-wechat-bot.git
cd xiaoyouyou-wechat-bot
sudo bash install.sh
```

`install.sh` 会：检查依赖 → 把代码装到 `/opt/xiaoyouyou` → 生成 `.env` → 拉起微信容器 → 提示扫码登录。

### 手动步骤

```bash
# 1. 部署目录
sudo mkdir -p /opt/xiaoyouyou/private && sudo chown -R $USER /opt/xiaoyouyou
sudo cp -r src tools /opt/xiaoyouyou/

# 2. 配置（见下方环境变量）
cp .env.example /opt/xiaoyouyou/private/wechat.env
vim /opt/xiaoyouyou/private/wechat.env

# 3. 群配置
vim /opt/xiaoyouyou/bot-config.json    # chatId / chatName / botNick

# 4. 起微信容器
docker compose up -d

# 5. 登录（首次必须扫码）
#    容器起来后访问 http://127.0.0.1:6174 的登录接口，或用项目里的 tools/push-login-qr.py

# 6. 起桥接
cd /opt/xiaoyouyou && node bridge-v3.3.js
```

### 启动 WebUI（可选）

```bash
cd webui
WEBUI_PORT=8088 XYY_BASE=/opt/xiaoyouyou node server.js
# 远程机器建议用隧道：ssh -L 8088:127.0.0.1:8088 user@server
```

打开 `http://127.0.0.1:8088` 就能读群列表、选授权群、改人设和聊天参数。详见 [`webui/README.md`](webui/README.md)。

### 验证

```bash
npm test                         # 单元测试（不需要微信容器）
npm run test:integration         # 集成测试（需要容器在跑）
curl -s http://127.0.0.1:6174/api/status   # 容器状态
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `XYY_BASE` | `/opt/xiaoyouyou` | 部署根目录 |
| `XYY_HOME` | 同上 | 状态目录基准 |
| `WX_API_BASE` | `http://127.0.0.1:6174` | 微信容器 API |
| `AGENT_WECHAT_TOKEN` | — | 容器 API 鉴权 token（必填） |
| `SPLATOON_CHAT_ID` | 读 `bot-config.json` | 授权群 ID，与配置不一致会拒绝启动 |
| `SPLATOON_BOT_NICK` | 读 `bot-config.json` | 机器人昵称（用于 @ 识别） |
| `SPLATOON_STATE_FILE` | `$HOME/.local/state/splatoon-bridge/state.json` | 消息游标 |
| `SPLATOON_EVENTS_FILE` / `XYY_EVENTS_FILE` | 同目录 `recovery-events.jsonl` | 事件日志 |
| `XYY_STARTUP_GRACE_MS` | `30000` | 启动宽限：重启前后这段时间内的指令照常处理 |
| `XYY_BACKLOG_MS` | `1800000` | 重启后最多补处理多久的积压 |
| `XYY_POLL_STUCK_LIMIT` | `10` | 连续拉消息失败多少次写一条卡死事件 |
| `XYY_LLM` | `off` | 自动聊天开关：`off` / `all` / `admin` |
| `XYY_LLM_MODEL` | `workbuddy/deepseek-v4.1-flash` | 聊天模型 |
| `XYY_LLM_URL` | `http://127.0.0.1:3430/v1/chat/completions` | OpenAI 兼容网关地址 |
| `XYY_LLM_KEY` | — | 网关密钥（本地网关可留空） |
| `XYY_LLM_USERS` | 空=所有人 | 允许闲聊的用户白名单 |
| `XYY_MEM_LIMIT_MB` | `600` | 容器内存水位，超过就回收 |
| `XYY_RECYCLE_GAP_MS` | `2700000` | 两次回收最小间隔（45 分钟） |
| `XYY_DRY` | — | `1` = 只判定不执行（演练用） |

完整清单见 `.env.example`。

## 目录结构

```
src/
  bridge-v3.3.js          桥接主循环：轮询、游标、指令分发、发送、事件
  xiao-youyou-bridge.js   兼容入口
  xiaoyouyou-v3.3.js      指令实现（地图/打工/随机武器/配装/帮助）
  llm-chat.js             自动聊天：人设、硬规则、三种触发模式
  llm-memory.js           按群对话记忆
  wx-client.js            微信容器 API 客户端（发送、读取、草稿校验）
  wx-fast.js              发送快路径（含死草稿清理）
  recovery-core.js        纯函数判定（无 I/O，单测覆盖）
  recovery-flow.js        审批式恢复流程状态机
  recovery-gate.js        登录闸门
  wechat-health-monitor.js 容器内健康监控对接
  battle-schedule.js      打工排班渲染
  salmon-schedule.js      鲑鱼跑排班渲染
  weapon-card.js          随机武器卡
  builds-*.js             配装卡（数据、素材、渲染）
  fest-poster.js          祭典海报
  net.js                  数据源缓存（TTL + 只读模式）
tools/
  auto-relogin.js         保活执行器（判定 + 登录 + 回收）
  auto-relogin-notify.py  事件通知投递
  systemd/                systemd 单元与 timer
  wechat-lock/            客户端单实例锁
webui/                    管理面板（server.js + public/index.html，零依赖）
assets/                   游戏素材（见「版权」）
refs/                     参考图（视觉规格）
```

## 常见问题

**Q：机器人不回消息？**
按顺序查三层：① `login-gate.json` 是否 `blocked`（桥接会静默 wait）；② `state.json` 的 `lastId` 是否在推进；③ 那条消息的 `isMentioned` 是否为 `true`（手打 `@昵称` 不带微信 @ 实体，等于没 @）。

**Q：重启后丢消息？**
默认有 30 秒启动宽限，宽限内的指令照常处理；更早的按设计跳过（避免一次重启把半小时前的指令全回一遍）。要补更多用 `XYY_BACKLOG_MS`。

**Q：容器内存一直涨？**
微信客户端会泄漏，到 600MB 左右就卡死。保活器会在水位线主动重启容器再自动登录，`XYY_MEM_LIMIT_MB` 可调。

**Q：能换模型吗？**
可以。任何 OpenAI 兼容网关都行，改 `XYY_LLM_BASE_URL` / `XYY_LLM_MODEL` / `XYY_LLM_API_KEY`。国内模型（DeepSeek、通义、Kimi、GLM 等）通过 magpie 之类的聚合网关接入最省事。

## 版权与免责

- **代码**：MIT（见 `LICENSE`）。
- **游戏素材**：`assets/`、`refs/` 里的图片来自斯普拉遁 3 及相关第三方站点（任天堂、splatoon3.ink、Leanny/splat3、Cypas 等），**版权归各自所有者，不适用 MIT**。仅供个人学习研究，请勿商用；正式分发请自行替换素材或删除这两个目录。
- **微信自动化**：使用非官方客户端自动化可能违反腾讯服务条款，存在封号风险。**请使用小号**，风险自负。
- 本项目与任天堂、腾讯均无关联。

## 致谢

- [thisnick/agent-wechat](https://github.com/thisnick/agent-wechat) —— 微信容器与 API 的底座
- [splatoon3.ink](https://splatoon3.ink) —— 赛程/祭典数据
- [Leanny/splat3](https://github.com/Leanny/splat3) —— 武器与装备数据
- [Cypas/splatoon3-schedule](https://github.com/Cypas/splatoon3-schedule) —— 场地图标
- [lovell/sharp](https://github.com/lovell/sharp) —— 图像合成
