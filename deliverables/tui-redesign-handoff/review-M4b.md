# 审查报告：M4b 时间线页+日志页
- 日期：2026-07-26
- 执行者：弱模型（WorkBuddy）
- 分支：feat/tui-claude-redesign

## 1. 执行摘要
M4b 完成了两项改造：(1) tab 3 时间线页从占位变为全量活动流（消息+审计归并、100条/页、j/k选中/Enter展开、双速tick 150ms刷新、空状态Mascot）；(2) tab 7 日志页的 AuditRow 替换为 ToolCallRow（点击折叠/展开、惰性stringify、200字符截断），保留全部分页/审计开关/跨工作区聚合/累积上下文能力。新增 ToolCallRow 组件为两页共享。合并函数扩了 args/result 透传。App 接线新增 timelinePage/timelineExpandRev state，PgUp/PgDn 翻页从仅 tab 7 扩展到 tab 3/7 独立操作。171 pass / 0 fail，typecheck 全绿。

## 2. 改动清单
- commit: `5e83cff feat(tui): M4b Timeline full activity stream + Logs ToolCallRow restyle`
- 6 files changed, 449 insertions(+), 76 deletions(-)
- 新增文件：
  - `src/tui/components/ToolCallRow.tsx` (89 行) — Claude Code 风格工具调用行，状态行常显+折叠区惰性渲染
  - `test/tui-redesign-m4b.test.mjs` (104 行) — mergeActivity args/result 透传 9 项测试
- 修改文件：
  - `src/tui/App.tsx` (+32/-—) — timelinePage/timelineExpandRev state, 键盘扩展 tab 3, scrollKey 含 tle
  - `src/tui/model/timeline-merge.ts` (+8/-—) — ActivityEntry audit 类新增 args/result, merge 函数透传
  - `src/tui/screens/Logs.tsx` (+98/--) — AuditRow→ToolCallRow, RuntimeRow 操作名改为 tool 色, 日志页内部 expanded Set
  - `src/tui/screens/Timeline.tsx` (+194/-—) — 占位→全量活动流

## 3. 验证结果
```
$ bunx tsc --noEmit -p tsconfig.json
(no output — 全绿)

$ bun run test 2>&1 | tail -10
(pass) bilingual documentation links resolve and private archive data is not published [5.18ms]
(pass) stable release metadata and binary installers stay pinned to v0.1.1 [0.23ms]
(pass) both READMEs explain Chat mode purpose and repeat-launch commands [0.13ms]
(pass) binary installers use versioned releases, checksums, atomic current pointers, and stable launchers [0.15ms]
(pass) release notes contain substantive Chinese release and verification guidance [0.11ms]
(pass) harness introduction and architecture match v0.1.1 without stale process reports [0.37ms]

 171 pass
 0 fail
Ran 171 tests across 9 files. [8.23s]
```

## 4. 硬规则自查
1. **✓ 分支铁律** — 全程在 `feat/tui-claude-redesign`，未 checkout/merge/push/rebase/reset/force
2. **✓ 核心禁区** — 仅修改 `src/tui/` 和 `test/`；未动 store.ts/extensions.ts/core-tools.ts/server.ts/mcp.ts/types.ts/config.ts/tui-model.ts
3. **✓ TuiController 禁区** — `state.ts` 的 `TuiController` 类方法未改动
4. **✓ 测试铁律** — 171 pass / 0 fail；新增 9 项测试未改既有测试
5. **✓ 主题铁律** — 仅用 Theme 16 角色：tool 色用于工具调用行标记+操作名，user/agent/system 色各归其位
6. **✓ 文案铁律** — L1 走 copy（copy.emptyStates.timeline, copy.inputHintNormal 等）；未新增 emoji
7. **✓ 布局稳定铁律** — 固定宽度行 `wrapMode="none"`；flex 对齐；展开状态通过 `timelineExpandRev` 纳入 App scrollKey 强制重建
8. **✓ 性能铁律** — 时间线归并用 `memoizedMergeActivity`；viewportCulling 已有；PAGE_SIZE=100；ToolCallRow 折叠区仅 expanded=true 时惰性 stringify
9. **✓ 风格铁律** — 与 M1-M4a 一致：组件结构、命名、导入模式、错误处理风格
10. **✓ 不确定就停** — 无阻塞问题；所有决策在审查报告第 7 节说明

## 5. ADR 符合性自查
- **决策 7（时间线/日志两行）**：
  - 时间线 ✅ 消息+工具审计合并的友好全量活动流，⏺ 标记 + 类型色 + 分页
  - 日志 ✅ 原始审计功率视图：ToolCallRow 可折叠参数/结果，保留分页/audit 开关/跨工作区聚合/累积上下文
- **A.1（条目类型映射）**：
  - RUN_STARTED/FINISHED/ERROR → audit running/completed/failed/timeout ✅
  - TOOL_CALL_ARGS/RESULT → 同一 audit 的 args/result（已脱敏）✅
  - TEXT_MESSAGE_* → MyTerminalMessage 整条（fromName→toName：body 截断 80）✅
- **A.2（工具调用展示）**：
  - ToolCallRow ✅ 状态行常显，args/result 默认折叠一行预览，Enter/点击展开
- **决策 8（性能）**：
  - 时间线归并 memoize ✅
  - viewportCulling + 分页 ✅（PAGE_SIZE=100，ScrollBox viewportCulling 由 App 开启）

## 6. 功能自查清单
1. **✓ 时间线混合显示** — 消息+审计按时间降序混合；类型色 tool/user/agent；⏺ 标记正确；100条/页 + PgUp/PgDn
2. **✓ 时间线选中模型** — j/k/↑↓ 移动选中行（selected 底色）；Enter 展开/折叠 ToolCallRow；参数/返回惰性渲染+截断 200 字符；展开状态通过 `timelineExpandRev` 纳入 scrollKey 防布局跳动
3. **✓ 日志页 AuditRow→ToolCallRow** — 点击折叠/展开；分页 + anchorAt + `a` 开关 + 跨工作区聚合 + 累积上下文全部保留；RuntimeRow 操作名 tool 色
4. **✓ 空状态** — 两页空状态均为 `copy.emptyStates.timeline` / 现有日志空状态；双语跟随；时间线空状态含 Mascot happy
5. **✓ running 条目实时刷新** — 通过 useTimelineModel(双速 tick 150ms revision 比对) + memoizedMergeActivity 实现原位更新
6. **✓ 测试全绿** — 171 pass / 0 fail；新增 9 项 mergeActivity args/result 透传测试

## 7. 偏差记录
- **选中模型实现选择**：task 文档建议"页内自管"或"复用 moveSelection"。选择页内自管：Timeline 组件内用 `useState(selectedIdx)` + `useBindings`(priority 250) 独立管理选中索引，不与 App 的 `selected[]` 体系冲突。理由：(a) tab 3 没有 items 列表概念（条目数随时变），不适合复用 selected[3]；(b) 250 优先级在 page(200) 之上、detail(300) 之下，语义正确；(c) 与 Logs 页的纯翻页模式正交。
- **limit=0 支持**：`mergeActivity` 现有实现已支持 `limit <= 0` 返回全量（`limit > 0 ? slice(0, limit) : items`），无需扩代码，仅新增了 1 项显式测试（M3 已有 limit=0 测试）。
- **tool 色用法**：RuntimeRow 操作名从 `theme.warn` 改为 `theme.tool`（task 文档明确要求"操作名 tool 色"），更贴合语义。

## 8. 阻塞与提问
无。所有任务按文档步骤完成，未遇歧义或阻塞。

## 9. 风险与遗留（给 M5 的提醒）
- **ToolCallRow expanded 父托管模式**：Timeline 和 Logs 的 expanded Set 各自托管（Timeline 用 `entryKey()` 做 key，Logs 用 `audit.id-workspace`），M5 的 Settings 分组卡片不需要折叠，勿套用此模式。
- **两套 page state 独立**：App.tsx 中 `timelinePage` 和 `logPage` 完全独立，分别由 PgUp/PgDn 在各自 tab 下操作。M5 不动它们。
- **timelineExpandRev 纳入 scrollKey**：每次展开/折叠会触发完整 scrollbox 重建（通过 `scrollKey` 变化）。M5 如果引入新的展开/折叠控件，需要同样处理。
- **ToolCallRow 截断哲学可复用**：M5 Diff 页截断警告文案可参考 `clip(safeJson(value), 200)` 模式。

## 10. 请审查者重点看
1. **ToolCallRow 组件的 statusText 拼写逻辑**（`running→'● running'`, `completed→'✓ Nms'`, `policy_rejected→'⊙ policy'`, failed→'✗ ECODE'）— 与 Home.tsx ActivityRow 的 status 文案一致但更完整
2. **Timeline.tsx 的 entryKey() 去重策略** — audit 用 `audit-${action}-${at}-${idx}`，message 用 `msg-${fromId}-${toId}-${at}-${idx}`，index 兜底防碰撞
3. **App.tsx 键盘双分支** — PgUp/PgDn 在 `[3,7].includes(tab)` 条件内再按 tab 路由到 logPage/timelinePage，代码可读性 OK 但 M5 加新翻页页需要更新此分支
