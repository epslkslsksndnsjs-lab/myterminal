# MyTerminal Agent 操作手册 — 2026-07-25

## 两个通道

| 通道 | 地址 | 鉴权 | 适合 |
|------|------|------|------|
| Actions API | `POST http://127.0.0.1:3210/actions/extensions/call` | Bearer token | 所有操作，返回完整JSON |
| MCP | `http://127.0.0.1:3210/mcp/<connectorKey>` | 无需token | 单步读操作 |

**Actions API 模板**：
```bash
curl -s -X POST http://127.0.0.1:3210/actions/extensions/call \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"tool":"<工具名>","input":{...},"identity":{...}}'
```

## 工作流

### 1. 注册 session
```
session_register({mode:"root", name:"main", role:"lead"})
→ {session:{id:"ses_xxx"}, identity:{sessionId, sessionToken}}
```
保存 identity，之后每次调工具都带上。

### 2. 发现工具
```
extension_discover({includeSchemas:true})
→ 返回29个工具+参数schema
```

### 3. 干活 — 29个工具速查

#### 📂 文件 (7个)
| 工具 | 用途 |
|------|------|
| workspace_info | 工作区基本信息 |
| list_dir {path} | 列目录 |
| find_files {query} | 按文件名搜 |
| search_text {query, path} | 按内容搜 |
| read_file {path, maxBytes?} | 读文件 |
| read_file_range {path, startLine, endLine} | 读指定行 |
| write_file {path, content} | 写文件 |

#### 🔧 代码修改 (1个)
| 工具 | 用途 |
|------|------|
| apply_patch {path, replacements:[{oldText,newText,replaceAll?}], expectedSha256?} | 精确替换+校验 |

#### 💻 Shell (1个)
| 工具 | 用途 |
|------|------|
| execute_cli {command, cwd?, timeoutSec?} | 执行命令 |

#### 📦 Blob (3个)
| 工具 | 用途 |
|------|------|
| blob_create {content, encoding?} | 暂存内容返回hash |
| blob_read {sha256} | 用hash读回 |
| blob_write_file {sha256, path} | hash→文件(幂等) |

#### 🌿 Git (4个)
| 工具 | 用途 |
|------|------|
| git_status | git status |
| git_diff | git diff |
| git_log | git log |
| git_show {revision} | git show |

#### 🏗️ CI (1个)
| 工具 | 用途 |
|------|------|
| run_checks {includeTest?} | typecheck→build→test 串行 |

#### 👤 Session (12个)
| 工具 | 用途 |
|------|------|
| session_register {mode, name, role?, task?, blockedBy?} | 创建root或delegate |
| session_inherit {sessionId, claimCode?} | 接手session |
| session_list | 列出所有session |
| session_checkpoint {phase, summary, nextSteps?, artifacts?} | 记录进度 |
| session_context | 16K上下文 |
| session_history {limit?, offset?} | 审计记录 |
| session_release | 释放+生成claimCode |
| session_tag {tags} | 打标签 |
| session_subscribe {targetSessionId} | 订阅另一个session |
| session_events_ack {eventIds} | 确认事件 |

#### 💬 消息 (4个)
| 工具 | 用途 |
|------|------|
| message_send {to, body} | 发消息 |
| message_inbox | 收件箱 |
| message_list | 收发列表 |
| message_conversation {with} | 二人对话 |

### 4. 轮询（长任务专用）
```
前提：config.json 中 nonBlockingTasksEnabled: true
任何工具超200ms → 自动返回 {status:"running", taskId:"act_xxx"}
用 task_poll({taskId}) 反复轮询 → running|completed|failed
每次 poll 几十毫秒，永不超时
```

### 5. Sub-Agent 分派
```
session_register({mode:"delegate", name:"reviewer", role:"code-reviewer", task:{objective,background,deliverables,acceptanceCriteria,constraints}, blockedBy:["parentId"]})
→ 返回 {session, claimCode, handoffPrompt}
用 claimCode 调用 session_inherit 接手
子代理通过 message_send 回报结果
```

## 关键注意事项
- identity 嵌套在请求顶层 `{tool, input, identity}`，不是 input 里面
- Delegate session 不返回 identity，需 session_inherit(claimCode) 获取
- execute_cli 和 write_file 只能通过 extension_call 调用（不是直连工具）
- apply_patch/run_checks/session_tag/session_subscribe 是隐藏工具，通过 extension_call 调用
- 重启后 session 自动清理（reapOrphanDelegates），不会再弹"N个session等待接管"
