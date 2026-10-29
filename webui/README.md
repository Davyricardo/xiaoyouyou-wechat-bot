# 小鱿鱿 WebUI

给 [小鱿鱿](../README.md) 用的本地管理面板：读群、选群、改人设、调聊天参数、看记忆。

零依赖（Node 22+ 原生 `http`），单页前端（无 CDN、无构建），默认只监听 `127.0.0.1`。


## 能做什么

| 页面 | 功能 |
|---|---|
| **概览** | 容器登录态、授权群、机器人昵称、自动聊天模式、模型、人设大小、最近保活事件 |
| **群聊** | 从微信容器读会话列表（区分群/私聊）→ 点开看最近 30 条消息 → 一键「设为授权群」（写 `bot-config.json`） |
| **人设** | 编辑 `private/persona.md`，保存即生效（代码按 mtime 热加载，不用重启） |
| **聊天** | 自动聊天模式（off/all/admin）、网关地址、模型、密钥、白名单、插话开关、单条字数、记忆开关（写 `private/wechat.env`） |
| **记忆** | 按用户列出 `llm-memory` 里的记忆条数与更新时间，可单独清除 |
| **指令** | 内置指令一览与 @ 规则说明 |

## 快速开始

```bash
# 假设小鱿鱿部署在 /opt/xiaoyouyou
cd webui
WEBUI_PORT=8088 XYY_BASE=/opt/xiaoyouyou node server.js
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
# 首次打开会提示输入 token，存在浏览器 localStorage
```

> ⚠️ 面板能改人设和模型配置，等于半个管理员权限。不要裸奔在公网。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBUI_PORT` | `8088` | 监听端口 |
| `WEBUI_HOST` | `127.0.0.1` | 监听地址，对外开要配 `WEBUI_TOKEN` |
| `WEBUI_TOKEN` | 空 | 请求头 `X-WebUI-Token` 或 `?token=`，空则不校验 |
| `XYY_BASE` | `/opt/xiaoyouyou` | 小鱿鱿部署目录（读 `bot-config.json`） |
| `XYY_PRIVATE` | `$XYY_BASE/private` | 私有目录（`persona.md`、`wechat.env`） |
| `WX_API_BASE` | `http://127.0.0.1:6174` | 微信容器 API |
| `AGENT_WECHAT_TOKEN` | 读 `wechat.env` | 容器 API token，不设则从 env 文件读 |
| `XYY_LLM_MEMORY_DIR` | `$XYY_PRIVATE/llm-memory` | 记忆目录 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 容器状态 + 群配置 + LLM 设置 + 人设大小 |
| GET | `/api/chats` | 会话列表（含 `isGroup`、`selected`） |
| GET | `/api/messages?chatId=&limit=` | 最近消息 |
| GET/PUT | `/api/config` | `bot-config.json`（chatId / chatName / botNick） |
| GET/PUT | `/api/persona` | `persona.md` 内容 |
| GET/PUT | `/api/llm` | LLM 设置（写 `wechat.env`，保留注释与顺序） |
| GET | `/api/memory` | 记忆目录、群记忆、用户列表 |
| DELETE | `/api/memory?file=` | 删除某个记忆文件（文件名白名单校验） |
| GET | `/api/events` | 最近 30 条保活事件 |

## 设计说明

- **写 env 不破坏文件**：只替换目标 key 的行，注释、顺序、其他变量原样保留；写完用 `tmp + rename` 原子替换。
- **密钥不回显**：`XYY_LLM_KEY` 只返回 `keySet: true/false`；提交时留空表示"不修改"。
- **人设热加载**：`llm-chat.js` 每次调用检查 mtime，保存后下一条消息就生效。
- **配置类改动需重启桥接**：`bot-config.json`、`wechat.env` 由进程启动时读取，面板会提示。
- **容器不可达时优雅降级**：群聊/消息接口返回 `ok:false` 和错误原因，页面显示空态而不是崩溃。



## 许可

与主项目一致：MIT。
