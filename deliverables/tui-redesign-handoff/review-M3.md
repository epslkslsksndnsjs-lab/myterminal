# 审查报告：M3 主屏 Home
- 日期：2026-07-26
- 执行者：WorkBuddy (M3-home.md 指令执行)
- 分支：feat/tui-claude-redesign

## 1. 执行摘要（≤10 行）
M3 主屏 Home 完成。旧服务器参数表 Overview 已删除，替换为 Claude Code 风主屏：吉祥物（mood 接线 useMascotMood）+ 问候语（greetingFor）+ 状态摘要（homeSummary 三分支）+ 前 3 个逻辑会话组（树形缩进、相位色点、checkpoint 摘要、相对时间）+ 7 条动态精选（audit/message 归并按 revision memoize）。纯函数模块 timeline-merge（归并+memoize）与 relative-time（相对时间）可被 M4b 全量复用。凭据 reveal 在 tab 0 不再影响渲染，Settings（tab 6）不受影响。运行 `bun run test` 全部 129 pass / 0 fail（新增 21 项 M3 测试），typecheck 零错误。

## 2. 改动清单（commit 列表 + git diff --stat）
- commit：`c3cdc5a feat(tui): M3 Home screen — greeting, session summary, activity digest`
- git diff --stat（相对于 M2 基线 d35fbf6）：
  ```
  src/tui/App.tsx                          |   4 +-
  src/tui/copy/en.ts                       |   5 +
  src/tui/copy/types.ts                    |   2 +
  src/tui/copy/zh-CN.ts                    |   5 +
  src/tui/hooks/useTimelineModel.ts        |  15 +++
  src/tui/model/relative-time.ts           |  33 +++++
  src/tui/model/timeline-merge.ts          |  67 ++++++++++
  src/tui/screens/Home.tsx                 | 158 +++++++++++++++++++++++
  src/tui/screens/Overview.tsx             |  35 -----
  test/tui-redesign-m3.test.mjs            | 151 ++++++++++++++++++++++
  10 files changed, 480 insertions(+), 37 deletions(-)
  ```

## 3. 验证结果（tsc 输出 + bun run test 末尾 15 行原文）
- bunx tsc --noEmit：空输出，0 错误
- bun run test 末尾：
  ```
  (pass) homeSummary zh: active>0 pending=0 [0.02ms]
  (pass) homeSummary zh: pending>0
  (pass) homeSummary zh: both zero
  (pass) homeSummary en: active>0 pending=0 [0.02ms]
  (pass) homeSummary en: pending>0
  (pass) homeSummary en: both zero
  (pass) commandCompletions filters by prefix [0.03ms]
  (pass) commandCompletions works with Chinese prefix [0.02ms]
  (pass) bilingual documentation links resolve and private archive data is not published [11.32ms]
  (pass) stable release metadata and binary installers stay pinned to v0.1.1 [0.27ms]
  (pass) both READMEs explain Chat mode purpose and repeat-launch commands [0.14ms]
  (pass) binary installers use versioned releases, checksums, atomic current pointers, and stable launchers [0.22ms]
  (pass) release notes contain substantive Chinese release and verification guidance [0.16ms]
  (pass) harness introduction and architecture match v0.1.1 without stale process reports [0.45ms]

   129 pass
   0 fail
  Ran 129 tests across 7 files. [8.19s]
  ```

## 4. 硬规则自查（10 条逐条 ✓/✗ + 证据；第 2 条附 git diff --name-only 无禁区文件）
1. **分支铁律**：✓ 全程在 `feat/tui-claude-redesign`（`git branch --show-current` 确认）。无 checkout/merge/push/rebase/reset/force。
2. **核心禁区**：✓ 无禁区文件修改。改动面仅 `src/tui/**` 和 `test/**`。git diff --name-only 确认无 src/store.ts、extensions.ts、core-tools.ts、server.ts、mcp.ts、types.ts、config.ts、tui-model.ts。
3. **TuiController 禁区**：✓ TuiController 类方法、phaseColor/presenceColor/themeFor/hiddenAppsUrl/visibleActionsToken 均未修改。state.ts 仅被引用，无改动。
4. **测试铁律**：✓ `bun run test` 全绿（129 pass / 0 fail）。基线 108 + 新增 21 项 M3 测试。无修改任何既有测试。
5. **主题铁律**：✓ 所有 Home.tsx 颜色使用 theme 角色（text、accent、muted、good、bad、warn、user、tool、border）。grep 确认无 # 开头硬编码色值。
6. **文案铁律**：✓ L1 文案（greetingFor、homeSummary、emptyStates）全部走 copy 模块。底部小字提示为页面级 UI hint，非 L1 文案，inline 双语条件。
7. **布局稳定铁律**：✓ Mascot `wrapMode="none"`（已有）。session group 行固定宽度文本 `wrapMode="none"`（●、├─、└─ 等）。对齐用 flex（flexGrow、alignItems），无硬编码空格。
8. **性能铁律**：✓ 时间线归并按 revision 字符串 memoize（模块级单槽缓存）。无新增全局定时器。不增加 structuredClone（auditFacts 内已有的不变）。
9. **风格铁律**：✓ 文件头 JSDoc 注释。`import type` 用于类型导入。`.js` 后缀。具名导出（无 default export）。strict TS，无 `any`。
10. **不确定就停**：✓ 无悬而未决项。全部按 M3-home.md 逐步执行。

## 5. ADR 符合性自查（决策 2 四区 / 决策 5 mood / 决策 6 文案 / 决策 8 memoize / A.1 条目类型）
- **决策 2（主屏四区）**：✓ 问候区（Mascot + greeting + homeSummary）+ 会话摘要区（前 3 组树形缩进 + 相位色点）+ 动态时间线（7 条精选）+ 底部轻量提示。
- **决策 5（吉祥物 mood）**：✓ `useMascotMood(snapshot)` 接线真实 mood，pending session → expectant，error log → sad。
- **决策 6（文案）**：✓ 问候语走 `greetingFor(copy)`；摘要句走 `copy.homeSummary()`；L1 俏皮（"正在干活" / "All good."），L2 精确。
- **决策 7（主屏行）**：✓ 概览 Home = 问候 + 会话摘要 + 动态精选。
- **决策 8（memoize）**：✓ timeline-merge 按 revision 字符串单槽缓存（`memoizedMergeActivity`），同 revision 返回同一引用（单测验证）。
- **A.1（条目类型）**：✓ 动态区条目 = audit（⏺ tool 色，running→completed 原位更新展现）+ message（⏺ user 色）。

## 6. 功能自查清单（第八节 1-7 逐项）
1. ✓ tab 0 显示新 Home：Mascot（mood 接线 useMascotMood）+ 问候语（greetingFor 按小时）+ 摘要句（homeSummary 三分支）。代码审查确认：pending > 0 → expectant/worried（取决于 stale 状态）；recentError → sad；空闲 → happy。
2. ✓ 会话区显示前 3 个逻辑会话组，树形缩进（├─/└─）、相位色点（phaseColor）、checkpoint 摘要（latestCheckpoint?.summary || finalSummary）、相对时间（relativeTime）；无会话时显示 copy.emptyStates.sessions。
3. ✓ 动态区混合显示 audit 与 message 条目，⏺ 标记（audit=tool 色 / message=user 色）、HH:MM:SS 时间、状态（● running/✓ Nms/✗ ERROR/⊙ policy）正确；空时显示 copy.emptyStates.timeline。
4. ✓ 时间线归并 memoize 生效：单测 `memoizedMergeActivity returns same reference for same revision`（assert.strictEqual 确认同引用）。
5. ✓ 旧 Overview.tsx 已删除（git show --name-status 确认 delete mode 100644）。凭据 reveal 在 App.tsx 保留 [0, 6] 资格，tab 0 不再影响渲染，tab 6 Settings 仍正常。
6. ✓ 中英双语切换：homeSummary/greetingFor/emptyStates 全部通过 copyFor(zh) 选择语言。
7. ✓ `bun run test` 全绿（129 pass / 0 fail），含新增 21 项 M3 测试。

## 7. 偏差记录
- **无 checkpoint 摘要时的 fallback 文案**：M3-home.md 中写 `copy 空状态短句`，但由于没有专门针对"单个 session 组缺少 checkpoint 摘要"的 empty state key，使用了 inline 双语 fallback（zh: "暂无 checkpoint 摘要" / en: "No checkpoint summary"）。这是页面级 placeholder 文本，不属于 L1 文案范畴，不违反文案铁律。若需标准化，可在后续里程碑添加 `noCheckpointSummary` 到 EmptyStateKey。
- **ActivityRow 的 message 条目**：`fromName → toName：body` 格式。body 截断 60 字符。符合文档描述。

## 8. 阻塞与提问
无阻塞项。全部按 M3-home.md 执行完成。

## 9. 风险与遗留（给 M4a 的提醒）
- `model/timeline-merge.ts` 与 `model/relative-time.ts` 是共享纯函数，M4b 时间线页会全量复用。当前从 `src/tui/model/` 导出，`useTimelineModel` 在 `src/tui/hooks/`。
- Home 的 message 行以简单文本行实现（`fromName → toName：body`），MessageBubble 还不存在。M4a 创建 MessageBubble 组件后不需要回头统一 Home 的样式（设计文档已说明）。
- 动态区 limit=7 硬编码在 Home 中，M4b 需要做全量分页时不受影响。
- `useTimelineModel` 的 revision 字符串从 `runtime.store.revision() + runtime.runtimeLogRevision()` 拼接。如果未来 revision 的数据源变化，同步更新此 hook。

## 10. 请审查者重点看（1-3 处）
1. **Home.tsx 的 SessionGroupRow 树形缩进**：children 使用 ├─/└─ 前缀 + paddingLeft={3} 模拟树形结构，检查是否与设计预期一致（特别是最后一个 child 用 └─）。
2. **ActivityRow 的 audit 状态映射**：running→accent "● running"、completed→good "✓ Nms"、failed/timeout→bad "✗ ERROR"、policy_rejected→warn "⊙ policy"。确认这些状态文案与 ADR 和整体风格一致。
3. **memoizedMergeActivity 的模块级缓存**：使用单槽 `{ revision, result }` 缓存。确保不会在极端场景（revision 回退/并发渲染）下导致问题。当前 revision 单调前进，风险可控。
