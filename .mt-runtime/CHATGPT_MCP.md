# MyTerminal × ChatGPT 自定义 MCP 服务器 — 连接便条

> 更新于 2026-10-18 23:58。快速隧道 URL 是一次性的，cloudflared 每次重启都会换域名，换完要同步改 ChatGPT 连接器里的 URL。

## ChatGPT 连接器配置（设置 → 连接器 → 编辑）

| 字段 | 值 |
| --- | --- |
| 名称 | MyTerminal |
| 连接 | 服务器 URL |
| 服务器 URL | `https://shipment-design-texture-tears.trycloudflare.com/mcp/39be66323e6dc30024f063c3ff14fcbd1d6a8eae83c23806` |
| 身份验证 | 无需身份验证（连接密钥已藏在 URL 路径里，服务端定时安全比较校验，不需要 OAuth/Bearer） |

改完 URL 后在连接器上点 **Refresh** 重新拉取工具列表，开新对话测试。

## 当前实例（用户自己的 TUI）

- MyTerminal TUI：pid 50277（今天在跑），监听 `127.0.0.1:3210`，workspace `/Users/Admin/myterminal`
- 配置目录：`~/.config/myterminal`（用户真实配置，connectorKey `39be66323e6dc30024f063c3ff14fcbd1d6a8eae83c23806`）
- 隧道：用户自己终端里跑的 `/tmp/cloudflared tunnel --url http://127.0.0.1:3210 --protocol http2`

## 已核验（2026-10-18 23:58，经公网隧道）

- 域名来源：cloudflared 启动输出（`/tmp/cloudflared.log`）
- `/health` → `leaderPid: 50277`（当前 TUI 实例）
- MCP `initialize` → session 签发正常；`tools/list` → 工具列表正常返回（extension_discover / extension_register / extension_call / session_register / session_inherit / session_checkpoint / session_list / session_context / session_history / session_release / session_events_ack / message_send 等）

## 换隧道后的标准动作

```bash
# 1. 新隧道（会打印新域名）
/tmp/cloudflared tunnel --url http://127.0.0.1:3210 --protocol http2
# 2. ChatGPT 连接器 URL 换成 https://<新域名>/mcp/39be66323e6dc30024f063c3ff14fcbd1d6a8eae83c23806
# 3. 连接器 Refresh → 开新对话
```

## 注意

- 快速隧道（trycloudflare.com）是临时的：URL 随机、无可用性保证，仅适合开发测试；长期使用请换 named tunnel（见 `docs/ACTIONS_SETUP.zh-CN.md`）。
- 该 URL + key 等价于"公网可读写 `/Users/Admin/myterminal`"，不用时停掉隧道（Ctrl+C）。
- `.mt-runtime/` 是早期 da 拉 headless 实例时的影子配置目录，现已不用，可随时删除。
