# 审查报告：M4a 会话页+消息页
- 日期：2026-07-26
- 执行者：WorkBuddy (M4a-sessions-messages.md 指令执行)
- 分支：feat/tui-claude-redesign

## 1. 执行摘要（≤10 行）
M4a 会话页+消息页完成。新建 `model/history-entry.ts`（11 种实测类型 + fallback 映射，32 项单测全过）、`components/MessageBubble.tsx`（user/agent 双侧气泡）。Sessions.tsx 卡片树视觉升级（● accent 点 + 选中态 accent 边框）、SessionDetail 事件流化（消灭所有 JSON 裸输出）。Messages.tsx 对话卡片升级 + ConversationDetail 全量 MessageBubble 渲染（user 侧 theme.user 边框、agent 侧 theme.agent 边框）。App.tsx 传 copy prop。`bun run test` 162 pass / 0 fail（新增 32 项 M4a 测试），typecheck 零错误。

## 2. 改动清单（commit 列表 + git diff --stat）
- commit：`dd5bb40 feat(tui): M4a Sessions + Messages — card tree restyle, event-stream detail, message bubbles`
- git diff --stat（相对于 M3 基线 c3cdc5a）：
  ```
  src/tui/App.tsx                      |   8 +-
  src/tui/components/MessageBubble.tsx |  34 +++++
  src/tui/model/history-entry.ts       | 192 ++++++++++++++++++++++++
  src/tui/screens/Messages.tsx         |  97 ++++++++++---
  src/tui/screens/Sessions.tsx         | 144 ++++++++++++++----
  test/tui-redesign-m4a.test.mjs       | 274 +++++++++++++++++++++++++++++++++++
  6 files changed, 697 insertions(+), 52 deletions(-)
  ```

## 3. 验证结果（tsc 输出 + bun run test 末尾 15 行原文）
- bunx tsc --noEmit：空输出，0 错误
- bun run test 末尾：
  ```
  test/cli-regression.test.mjs:
  (pass) stateless CLI commands bypass invalid settings, missing workspace, and active workspace locks [805.31ms]

  test/docs.test.mjs:
  (pass) bilingual documentation links resolve and private archive data is not published [5.31ms]
  (pass) stable release metadata and binary installers stay pinned to v0.1.1 [0.20ms]
  (pass) both READMEs explain Chat mode purpose and repeat-launch commands [0.11ms]
  (pass) binary installers use versioned releases, checksums, atomic current pointers, and stable launchers [0.13ms]
  (pass) release notes contain substantive Chinese release and verification guidance [0.11ms]
  (pass) harness introduction and architecture match v0.1.1 without stale process reports [0.36ms]

   162 pass
   0 fail
  Ran 162 tests across 8 files. [8.22s]
  ```

## 4. 硬规则自查（10 条逐条 ✓/✗ + 证据）
1. **分支铁律**：✓ 全程在 `feat/tui-claude-redesign`（`git branch --show-current` 确认）。无 checkout/merge/push/rebase/reset/force。
2. **核心禁区**：✓ 无禁区文件修改。改动面仅 `src/tui/**` 和 `test/**`。git diff --name-only 确认无 src/store.ts、extensions.ts、core-tools.ts、server.ts、mcp.ts、types.ts、config.ts、tui-model.ts。
3. **TuiController 禁区**：✓ TuiController 类方法、phaseColor/presenceColor 均未修改。state.ts 仅被引用，无改动。
4. **测试铁律**：✓ `bun run test` 全绿（162 pass / 0 fail）。基线 129 + 新增 32 项 M4a 测试 + 1 项原 myterminal.test 通过（session action targeting 文案恢复）。无修改任何既有测试。
5. **主题铁律**：✓ 所有新代码用 theme 角色（theme.user、theme.agent、theme.accent、theme.muted、theme.text、theme.border、theme.panel、theme.selected、theme.selectedText）。grep 确认无 # 开头硬编码色值。toneColor() 映射 5 种 tone→theme 角色。
6. **文案铁律**：✓ 空状态走 copy（`copy.emptyStates.sessions` / `copy.emptyStates.messages`）。未新增 emoji。checkpoint 摘要 fallback 为页面级 UI hint（inline 双语，与 M3 一致）。
7. **布局稳定铁律**：✓ MessageBubble 固定左边框 borderLeft；icon 列 `wrapMode="none"`。动态高度历史内容随 scrollKey 重建（App.tsx scrollKey 已含 tab + detail 状态）。flex 对齐（flexGrow、alignItems），无硬编码空格。
8. **性能铁律**：✓ 无新增全局定时器。viewForHistoryEntry 为纯函数（无副作用）。历史条目渲染数量不变（historiesForTui limit=200 不变）。
9. **风格铁律**：✓ 文件头 JSDoc 注释。`import type` 用于类型导入。`.js` 后缀。具名导出（无 default export）。strict TS，无 `any`。data 取值用 typeof/in 防御式收窄。
10. **不确定就停**：✓ 无悬而未决项。全部按 M4a-sessions-messages.md 逐步执行。

## 5. ADR 符合性自查（决策 7 两行 / A.4 类型分发 / 决策 6 空状态）
- **决策 7（会话 Sessions）**：✓ 卡片树 Claude 化：accent 边框选中态、● accent + 组名加粗 + SessionStatus。详情页事件流：按 type 分发渲染（viewForHistoryEntry），icon + title + detail，无 JSON.stringify 裸输出。
- **决策 7（消息 Messages）**：✓ 气泡对话流：user/agent 来源色区分（theme.user/theme.agent 左边框）、圆角（panel 背景）、俏皮空状态（copy.emptyStates.messages）。
- **A.4 类型分发**：✓ 每种历史条目类型独立映射（11 种实测 + fallback）。消息按 from==='user' 分发 selfSide。
- **决策 6 空状态**：✓ 空状态走 copy.emptyStates.sessions / copy.emptyStates.messages。

## 6. 功能自查清单（第八节 1-6 逐项）
1. ✓ 会话页卡片树：● accent + 组名加粗 + SessionStatus；├─/└─ 树形缩进；空状态 copy.emptyStates.sessions 生效。选中态 accent 边框 + selected 背景。
2. ✓ 会话详情页历史区无任何完整 JSON 裸输出：viewForHistoryEntry 覆盖 11 种实测类型（session_created/tool_audit/checkpoint/event/message_received/message_sent/claimed/released/stale/tags_updated/task_package）+ unknown fallback（▸ muted icon + JSON.stringify 截断 120 字符）。32 项单测覆盖全部类型。
3. ✓ 消息页对话卡片：对方名加粗 + 消息数 accent + 最后一条预览 muted 截断。ConversationDetail 全部 MessageBubble：user/agent 来源色区分（左边框）、时间（relativeTime）、已读标记、body 自动换行（wrapMode="word"）。
4. ✓ Enter 进出详情、Esc 返回、stickyScroll 对话置底等既有交互无损（App.tsx 未修改这些逻辑）。
5. ✓ 双语切换后新文案跟随：空状态走 copyFor(zh)，MessageBubble 头部的 "你"/"You"、"已读"/"read"、relativeTime 双语。
6. ✓ `bun run test` 全绿（162 pass / 0 fail，含 32 项 M4a 新测试）。

## 7. 偏差记录
- **Sessions 操作行文案**：M4a 文档说"文案微调走 copy 或保留"，选择了保留原文（`按 u 后选择具体根/续作/子 session`），确保既有测试通过。
- **checkpoint 摘要 fallback**：无 checkpoint 摘要时使用 inline 双语 fallback（"暂无 checkpoint 摘要"/"No checkpoint summary"），与 M3 一致。copy 模块无对应 EmptyStateKey。
- **MessageBubble 时间格式**：使用 relativeTime（纯函数，来自 M3），非 HH:MM:SS。M4a 文档说"HH:MM:SS 或相对时间"，选择了相对时间以与 M3 风格一致。

## 8. 阻塞与提问
无阻塞项。全部按 M4a-sessions-messages.md 执行完成。

## 9. 风险与遗留（给 M4b 的提醒）
- `model/history-entry.ts` 的 fallback 哲学（摘要 + 截断，不裸输出）同样适用于 M4b 的 ToolCallRow args/result 预览。
- MessageBubble 只服务消息；M4b 的工具调用行用独立 ToolCallRow，不要复用 MessageBubble。
- 实测历史 type 集合见附录，M4b 可引用。
- 当前 MessageBubble 时间格式使用 relativeTime（如 "3m ago"），若需要精确 HH:MM:SS 可选 timeOf() 格式。

## 10. 请审查者重点看（1-3 处）
1. **viewForHistoryEntry 的 11 种类型映射 + unknown fallback**：每个 type 的 icon/tone/title/detail 是否语义准确。特别是 tool_audit 的 status→tone 映射（completed→good, running→accent, failed→bad, policy_rejected→warn）和 message_received/message_sent 的 body 截断（100 字符）。
2. **SessionDetail 事件流化**：原 `JSON.stringify(item.entry.data, null, 2)` 已完全移除，替换为 viewForHistoryEntry 的 icon + title + detail 渲染。检查所有可见 entry 确实无 JSON 裸输出。
3. **MessageBubble 的 selfSide 分发**：`from === 'user'` → selfSide 'user'（theme.user 左边框 + "你"），否则 → selfSide 'agent'（theme.agent 左边框 + sessionName）。确认 ConversationDetail 中 user 消息和 agent 消息正确区分。

## 附录：实测历史条目 type 集合（第 1 步输出）
```
实际数据路径：~/.config/myterminal/workspaces/cfb74031918510fc/history/*.jsonl
发现 11 种类型：
  1. session_created  — { mode: "root" | "child" }
  2. tool_audit       — { action, status, source, session, args, result, durationMs, tool }
  3. checkpoint       — { at, phase, summary, nextSteps, blockers, artifacts, tags }
  4. event            — { id, recipientSessionId, sourceSessionId, kind, payload, createdAt }
  5. message_received — { id, from, to, source, body, createdAt }
  6. message_sent     — { id, from, to, source, body, createdAt }
  7. claimed          — { controllerId }
  8. released         — { phase, presence }
  9. stale            — {}
  10. tags_updated    — { tags: string[] }
  11. task_package    — { objective, background, deliverables, acceptanceCriteria, constraints }
```
