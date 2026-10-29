# 小鱿鱿保活架构

范围：只管「活着、掉线自己回来」。人工扫码审批是另一条人闸流程，只在保活已经写下 `needs_scan` 之后才启动。

## 1. 四个角色，每个只有一个主人

| 角色 | 主人 | 只做 | 不做 |
| --- | --- | --- | --- |
| 检测 | `src/bridge-v3.3.js`、`tools/auto-relogin.js` | bridge 产出「发送超时」事实；auto-relogin 采集 auth、内存、服务状态 | 都不下结论 |
| 判定 | `tools/auto-relogin.js`（`decide`/`recycleReason`）；纯函数在 `src/recovery-core.js` | 观测 → 一个动作 | 不执行、不发送 |
| 执行 | `tools/auto-relogin.js` | 登录、重启容器、重启桥接 | 不决定要不要做 |
| 通知 | 香橙派**一个**进程读事件日志 | 投递 `notify:true` 的事件 | 不判定掉线、不读原始状态 |

## 2. 唯一状态：事件日志

`~/.local/state/splatoon-bridge/recovery-events.jsonl`，append-only，一行一个事件（`appendFileSync`，不整文件重写，两主机同时读不会读到半行以外的损坏——坏行读侧跳过）。

- bridge 写：`send_timeout`（每次发送超时一条）
- auto-relogin 写：`result`（字段 `result`/`ok`/`notify`/`detail`）
- 香橙派只读：`tail` 后按事件 `id` 去重

`notify` 由 `recovery-core.notifyDecision()` 在**写入时**决定：同一种结果 30 分钟内只通知一次，`recovered` 永远通知。通知端没有判断，只有投递。

## 3. 这次消除的重叠

| 重叠 | 原位置 | 后果 | 处理 |
| --- | --- | --- | --- |
| 同一「gate 过期 + 已登录 → 放行」判定写了两份，阈值还不同（10 分钟 / 2 分钟） | `bridge-v3.3.js` `healStaleGate` ↔ `auto-relogin.js` `decide` | 两处抢着改 gate 文件 | 删 `healStaleGate`，只留 `decide` |
| 回收请求两套文件：`recycle-request.json`（bridge 写）+ `send-timeouts.json`（只读、**无写入方**） | bridge ↔ auto-relogin | 一边写一个、另一边根本没写 | 统一成一条 `send_timeout` 事件，两个窗口（30 分钟有效 / 15 分钟 2 次）都从它算 |
| 重启结果只看 `is-active` 30 秒，不知道 systemd 正在每 30 秒硬重启 | `auto-relogin.js` `restartAndWait` | 撞上空档就假失败，还继续催 | 改 `systemctl show -p ActiveState,SubState,NRestarts`，flapping 立即停手 |
| 同一次掉线有两条通知链：pi 监控自判 offline 发 1/2、2/2；relogin-notify 又读日志发一条 | `pi-aliyun-monitor.py` ↔ `auto-relogin-notify.py` | 一次故障多条提醒 | 仓库内只留事件日志投递器 `auto-relogin-notify.py` |

仓库外遗留：`pi-aliyun-monitor.py` 的掉线提醒分支仍在自判 offline。它不在本仓库（改动受「只改仓库」约束），切换步骤写在 `AUTO-RELIGIN.md`；保活判定不再依赖它。

## 4. 为什么不会变成屎山

- **单一状态机**：一轮 = 读事件 → 纯函数给动作 → 执行 → 写一条 `result`。没有中间状态文件，进程被 kill 也只留下一条「没写」的空白，不会留下半截状态。
- **纯函数判定**：所有「该不该」「成没成」都在 `recovery-core.js`，输入显式、无 I/O，`node --test` 直接覆盖；剩下的是搬运。
- **单一事件日志**：新增判据只能读同一份数据。想加第四处判断，必须先回答「为什么已有事件不够」，这是唯一需要评审的问题。
- **边界可 grep**：`Login successful`、`ActiveState`、`blocked` 的判定只允许出现在 `auto-relogin.js` / `recovery-core.js`（见交付报告里的 grep 输出）。
- **失败有闸门**：连续失败按 `backoffMs` 指数退避，不再每 5 分钟整轮重来；状态是事件推导出来的，不额外存计数器。
