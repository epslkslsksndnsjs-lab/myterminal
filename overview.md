# TUI 消息页对话流改造 — 完成总结

## 做了什么

在 `feat/conversation-stream` 分支上实现了 TUI 消息页的 Claude 风格对话流改造（档 A + 档 B），让用户能在 TUI 消息页里看到 user 消息 / 工具调用 / GPT 回复的统一时间线，并通过底部输入框直接发送消息。

## 分支信息

- **分支**: `feat/conversation-stream`（本地 + 远端 `origin/feat/conversation-stream`）
- **基于**: `main` (ccdbdf2)
- **未合并到 main**，可随时回滚

## 改动文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/tui/conversation-stream.ts` | 新增 | 合并 messages + auditFacts 成统一时间线的纯函数层 |
| `src/tui/screens/Messages.tsx` | 重写 | 信箱列表 → Claude 风格对话流 + 底部输入框 |
| `src/tui/App.tsx` | 2 行传参 | 给 Messages/ConversationDetail 传 `runtime` + `inputEnabled` |
| `CONTEXT.md` | 新增术语 | "Conversation stream" |
| `docs/adr/0004-conversation-stream.md` | 新增 | 决策记录 |
| `docs/adr/0001~0003.md` | 新增 | 上次 grill-with-docs 会话的产出 |

**核心逻辑文件零改动**: `store.ts`, `server.ts`, `mcp.ts`, `openapi.ts`, `core-tools.ts`, `state.ts`, `keymap.ts` 全部未动。

## 关键设计

1. **统一对话流**: `composeConversationStream(messages, audits)` 把两个只读数据源按时间戳合并成 `StreamEntry[]`，每条标注 `user_message` / `gpt_message` / `tool_call`
2. **工具调用穿插**: GPT 的工具调用（read_file/execute_cli/session_register 等）穿插在对话流里，显示工具名、参数摘要、结果状态
3. **底部输入框**: 按 `i` 进入输入模式，回车发送（走现有 `store.sendUserMessage`），Esc 取消。draft 状态和键盘处理全部内化在 Messages.tsx 里
4. **累积上下文**: header 显示当前对话的累积上下文字符数
5. **零风控风险**: 输入框走和现有 `m` 键完全相同的 `sendUserMessage` 代码路径，不联网，不调 ChatGPT API

## 测试结果

- **typecheck**: 零错误通过
- **测试**: 53 pass / 20 fail — 与 main 分支完全一致（20 个失败是 pre-existing，和本次改动无关）
- **模块验证**: `composeConversationStream` 合并逻辑正确——时间排序、工具调用在 GPT 回复前、参数摘要全部通过
- **启动验证**: `bun run dev` 正常启动，TUI 能渲染，不崩溃

## 怎么启动测试

在终端里执行（已在 feat/conversation-stream 分支）:

```bash
cd 
bun run dev
```

启动后:
1. 选择 myterminal 工作区
2. 按 `3` 切到 Messages tab
3. 看到对话流（user 蓝色左边框 / 工具调用黄色左边框 / GPT 回复绿色左边框）
4. 按 `i` 进入输入模式，打字回车发送消息
5. 按 `m` 仍可用旧的 FormDialog 表单发送（保留）

## 后续事项

- 未合并到 main — 确认测试满意后可创建 PR 合并
- 底部输入框目前只支持 ASCII 输入（中文需要终端 IME 支持）—— `m` 键 FormDialog 仍作为完整输入备选
- 如果要加折叠连续同类工具调用（Claude 的 CollapsedReadSearchGroup），后续可在 conversation-stream.ts 扩展
