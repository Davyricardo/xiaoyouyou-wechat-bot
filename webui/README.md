# 小鱿鱿 WebUI

给 [小鱿鱿](../README.md) 用的管理面板：扫码登录、选群即启用桥接、改人设、切模型厂商、看记忆与保活事件。

零依赖（Node 22+ 原生 `http` + 内置 `WebSocket`），单页前端（无 CDN、无构建）。

## 能做什么

| 页面 | 功能 |
|---|---|
| **概览** | 容器状态、桥接服务态、登录账号、授权群、机器人昵称、自动聊天模式、模型、人设大小、最近保活事件 |
| **登录** | 通过容器登录 WebSocket 生成二维码（PNG 直接显示在页面），手机扫码 + 确认后自动记住账号 |
| **群聊** | 读会话列表（区分群/私聊）→ 看最近 30 条消息 → 「设为授权群并启用」：写 `bot-config.json` 并 `systemctl enable --now` 桥接与自动登录 |
| **人设** | 编辑 `private/persona.md`，保存即生效（按 mtime 热加载，不用重启） |
| **聊天** | 自动聊天模式、**厂商预设**（DeepSeek / 通义千问 / Kimi / 智谱 GLM / 腾讯混元 / 火山方舟 / 硅基流动 / OpenRouter / 自建 magpie / 自定义）、模型、密钥、白名单、插话、字数、记忆（写 `private/llm.env`，保存后自动重启桥接） |
| **记忆** | 按用户列出 `llm-memory` 里的记忆条数与更新时间，可单独清除 |
| **指令** | 内置指令一览与 @ 规则说明（只读） |

## 快速开始

`install.sh` 会把它装成 `xiaoyouyou-webui.service`，并把监听地址/端口/令牌写进 `private/webui.env`：

```bash
systemctl status xiaoyouyou-webui
systemctl restart xiaoyouyou-webui
```

手动跑（调试用）：

```bash
cd webui
WEBUI_HOST=127.0.0.1 WEBUI_PORT=8088 XYY_BASE=/opt/xiaoyouyou node server.js
```

打开 `http://127.0.0.1:8088`。

远程机器上建议用 SSH 隧道，而不是直接对外开端口：

```bash
ssh -L 8088:127.0.0.1:8088 user@your-server
# 然后本机浏览器打开 http://127.0.0.1:8088
```

如果确实要对公网开放，必须设 token：

```bash
WEBUI_HOST=0.0.0.0 WEBUI_PORT=8088 WEBUI_TOKEN=$(openssl rand -hex 16) node server.js
# 首次打开会提示输入 token，存在浏览器 localStorage；也可以直接用 ?token=xxx 打开
```

> ⚠️ 面板能改配置、`systemctl restart` 桥接，等于半个管理员权限。不要裸奔在公网。
> 面板以 root 运行才能重启服务；`install.sh` 生成的 unit 就是这样，暴露面靠 `WEBUI_HOST` / `WEBUI_TOKEN` 控制。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBUI_PORT` | `8088` | 监听端口 |
| `WEBUI_HOST` | `127.0.0.1` | 监听地址，对外开要配 `WEBUI_TOKEN` |
| `WEBUI_TOKEN` | 空 | 请求头 `X-WebUI-Token` 或 `?token=`，空则不校验 |
| `XYY_BASE` | `/opt/xiaoyouyou` | 小鱿鱿部署目录（读 `bot-config.json`） |
| `XYY_PRIVATE` | `$XYY_BASE/private` | 私有目录（`persona.md`、`wechat.env`、`llm.env`、`expected-user.txt`） |
| `WX_API_BASE` | `http://127.0.0.1:6174` | 微信容器 API（登录 WebSocket 也从这里派生） |
| `AGENT_WECHAT_TOKEN` | 读 `wechat.env` | 容器 API token，不设则从 env 文件读 |
| `XYY_LLM_MEMORY_DIR` | `$XYY_PRIVATE/llm-memory` | 记忆目录 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 容器状态 + 桥接服务态 + 登录态 + 群配置 + LLM 设置 + 人设大小 |
| GET | `/api/chats` | 会话列表（含 `isGroup`、`selected`） |
| GET | `/api/messages?chatId=&limit=` | 最近消息 |
| POST | `/api/login/start` | 打开容器登录 WebSocket，返回二维码（data URL） |
| GET | `/api/login/status` | 登录阶段：`idle` / `connecting` / `waiting_scan` / `phone_confirm` / `success` / `failed` |
| POST | `/api/login/cancel` | 取消当前登录会话 |
| GET/PUT | `/api/config` | `bot-config.json`；PUT 带 `apply:true` 会 `systemctl enable --now` 桥接 |
| GET/PUT | `/api/persona` | `persona.md` 内容 |
| GET/PUT | `/api/llm` | LLM 设置（写 `private/llm.env`）；PUT 带 `apply:true` 会重启桥接 |
| GET | `/api/presets` | 厂商预设（名称 / URL / 默认模型 / 备注） |
| GET | `/api/service` | 桥接服务 `ActiveState` / `SubState` / `UnitFileState` |
| GET | `/api/memory` | 记忆目录、群记忆、用户列表 |
| DELETE | `/api/memory?file=` | 删除某个记忆文件（文件名白名单校验） |
| GET | `/api/events` | 最近 30 条保活事件 |

## 设计说明

- **登录不依赖截图**：面板直接连容器 `ws://…/api/ws/login`，把二维码文本用 `qrcode-terminal` + `sharp` 转成 PNG，3 分钟有效；不需要 SSH 隧道到 6174，也不需要容器里的截图工具。
- **首次登录自动锁定账号**：成功后写 `private/expected-user.txt`，之后换号会被恢复流程判为异常。已有该文件时不会被覆盖。
- **登录成功顺手放行闸门**：如果恢复流程留下了 `login-gate.json{phase:"blocked"}`，面板改成 `resume`（不删文件），桥接下一轮自动重置游标。
- **写 env 不破坏文件**：只替换目标 key 的行，注释、顺序、其他变量原样保留；写完用 `tmp + rename` 原子替换。
- **密钥不回显**：`XYY_LLM_KEY` 只返回 `keySet: true/false`；提交时留空表示"不修改"。
- **人设热加载**：`llm-chat.js` 每次调用检查 mtime，保存后下一条消息就生效。
- **配置类改动自动重启**：`bot-config.json`、`llm.env` 由进程启动时读取，面板保存时会调 `systemctl` 并在响应里回真实服务态；桥接未启用时只保存、不重启。
- **容器不可达时优雅降级**：群聊/消息接口返回 `ok:false` 和错误原因，页面显示空态而不是崩溃。

## 许可

与主项目一致：MIT。
