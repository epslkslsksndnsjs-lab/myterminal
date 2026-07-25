# 任务 M4b：时间线页（全量活动流）+ 日志页（工具调用样式重做）

> 你是执行本任务的弱模型，全新上下文。本文档自包含：先读两遍，再动手。
> 前置：M2、M3、M4a 已交付。缺任一 review 文件就停下说明。
> 交付物 = 代码 commit + 填写文末《审查报告》保存为 `deliverables/tui-redesign-handoff/review-M4b.md`。

## 一、你的处境

MyTerminal 是「ChatGPT/Claude 网页端 ↔ 本地电脑」的桥接服务（Bun + TypeScript + OpenTUI + React 19）。TUI 按 ADR-0004 重做为 Claude Code 风格。M1 地基、M2 骨架、M3 主屏、M4a 会话/消息已完成。

你的任务：把 **tab 3 时间线页**从占位变成全量活动流（消息+审计合并、分页、类型色），把 **tab 7 日志页**的审计行重做为 Claude Code 式工具调用行（可折叠 ToolCallRow），保留日志页全部既有能力（分页/审计开关/跨工作区聚合/累积上下文）。

## 二、硬规则（违反任何一条 = 任务失败）

1. **分支铁律**：只在 `feat/tui-claude-redesign`。禁止 checkout/merge/push/rebase/reset/force。
2. **核心禁区**：绝不修改 `src/store.ts`、`src/extensions.ts`、`src/core-tools.ts`、`src/server.ts`、`src/mcp.ts`、`src/types.ts`、`src/config.ts`、`src/tui-model.ts`。改动面只有 `src/tui/**` 和 `test/**`。
3. **TuiController 禁区**：`state.ts` 的 `TuiController` 类方法不得改变。
4. **测试铁律**：commit 前 `bun run test` 全绿。禁止改既有测试强行通过。
5. **主题铁律**：只用 Theme 16 角色。工具调用行用 `tool` 色，来源色 user/agent/system。
6. **文案铁律**：L1 走 copy；禁止新增 emoji。
7. **布局稳定铁律**：固定宽度 `wrapMode="none"`；flex 对齐；折叠/展开改变行高时，展开状态必须纳入 scrollbox key 或确保 scrollbox 重建不跳动（参照 App 现有 scrollKey 模式）。
8. **性能铁律**：时间线归并沿用 `memoizedMergeActivity`（M3）；大列表 viewportCulling + 分页（时间线 100 条/页，与日志一致）；折叠区的 args/result 只在展开时才 stringify（惰性）。
9. **风格铁律**：与 M1-M4a 一致。
10. **不确定就停**：写进「8. 阻塞与提问」。

## 三、环境与验证

```bash
cd 
git branch --show-current
bunx tsc --noEmit -p tsconfig.json
bun run test
```

## 四、代码风格范例（先读）

`src/tui/model/timeline-merge.ts`（M3）、`src/tui/screens/Home.tsx`（M3，动态区是时间线的精选版）、`src/tui/model/history-entry.ts`（M4a，fallback 截断哲学）、`src/tui/screens/Logs.tsx`（现状，本任务改造对象）。

## 五、本任务相关 ADR-0004 决策（原文摘录）

**决策 7（本任务两行）**：
> | 时间线 Timeline（新增） | 消息 + 工具审计合并的友好全量活动流，⏺ 标记 + 类型色 + 分页；主屏动态区的完整版 |
> | 日志 Logs | 原始审计功率视图：⏺ 工具调用样式（状态色 + 可折叠参数/结果），保留分页 / audit 开关 / 跨工作区聚合 / 累积上下文 |

**附录 A.1（ag-ui 映射，时间线条目词汇表）**：
> RUN_STARTED/FINISHED/ERROR → audit running→completed/failed/timeout；TOOL_CALL_ARGS/RESULT → 同一 audit 的 args/result（已脱敏）；TEXT_MESSAGE_* → MyTerminalMessage 整条；STEP_* → session checkpoint/phase。

**附录 A.2（工具调用展示）**：
> ToolCallRow：状态行常显，args/result 默认折叠一行预览，Enter 展开。

**决策 8（性能）**：时间线归并 memoize；大列表 viewportCulling + 分页。

## 六、现状关键代码（已替你定位）

- `src/tui/screens/Timeline.tsx` — M2 占位页（本任务替换）
- `src/tui/screens/Logs.tsx` — 日志页现状（AuditRow 是要重做的对象；分页/anchorAt/remote 聚合/累积上下文逻辑保留）
- `src/tui/App.tsx` — tab 3 / tab 7 的渲染与键盘（PgUp/PgDn 翻页现状，`a` 审计开关）
- `runtime.store.auditFacts(5000)` — 审计数据源；`readWorkspaceLogs` — 跨工作区聚合（Logs.tsx 顶部）
- `state.messages` — 消息数据源
- `runtime.store.cumulativeContextChars(activeSessionId)` — 累积上下文（Logs 页 header 保留）

## 七、逐步执行

### 第 0 步：环境检查 + 读前置审查报告
```bash
git branch --show-current && ls deliverables/tui-redesign-handoff/review-M2.md deliverables/tui-redesign-handoff/review-M3.md deliverables/tui-redesign-handoff/review-M4a.md && bun run test 2>&1 | tail -3
```

### 第 1 步：components/ToolCallRow.tsx（本任务核心组件）
新建 `src/tui/components/ToolCallRow.tsx`：

```tsx
export function ToolCallRow({ audit, workspace, theme, zh, expanded, onToggle }: {
  audit: ToolAuditEvent;
  workspace?: string;        // 跨工作区来源标签（可选）
  theme: Theme; zh: boolean;
  expanded: boolean;
  onToggle: () => void;
})
```

- **状态行**（常显一行，wrapMode="none" 防跳动）：
  `⏺`(tool 色) + HH:MM:SS(muted) + 状态词（running→accent `● running`；completed→good `✓`；failed/timeout→bad `✗`；policy_rejected→warn `⊙`）+ `${source}/${action}`（text 加粗）+ `${sessionName}`（agent 色，可省）+ 右侧：completed 时 `${durationMs}ms`（muted）/ 失败时 errorCode（bad）/ 展开指示 `▸/▾`（muted）
- **折叠区**（expanded=true 才渲染，惰性 stringify）：
  - `参数`(muted) + `JSON.stringify(audit.args)` 单行截断 200 字符（text 色，wrapMode="word"）
  - `返回`(muted) + 同上（failed/timeout 用 bad 色，policy_rejected 用 warn）
  - args/result 已被后端脱敏，直接展示即可，不要再做额外过滤
- 交互：`onMouseDown={onToggle}`；键盘展开由所在页的选中模型触发（见第 3 步）
- 组件内**不持有** expanded state（由父级托管，便于 scrollbox key 重建）

### 第 2 步：screens/Timeline.tsx 全量活动流
替换占位页。props：`{ runtime, state, snapshot, theme, zh, copy, page, onPageChange }`（分页 state 由 App 托管，参照 Logs 的 page/anchorAt 模式，**简单起见用纯页码不带 anchorAt**）。

- 数据：`useTimelineModel(snapshot, 0)`（limit=0 = 不截断的全量归并；M3 的 hook 若不支持 limit=0，扩成 limit<=0 表示全量并补单测）
- 分页：`PAGE_SIZE = 100`，当前页 slice；PgUp/PgDn 翻页（**注意**：App 里 tab 7 已有日志翻页键盘处理，本任务要给 tab 3 加同样处理——改 App.tsx 的 `tab === 7` 判断为 `[3, 7].includes(tab)`，并让两套 page state 独立：`logPage` 已有，新增 `timelinePage`）
- 行渲染：
  - audit → `<ToolCallRow>`；expanded 集合由页面 state 持有（`Set<string>`，key=audit.id）；**Enter 展开当前选中行**：页面加选中模型（j/k/↑↓ 移动、Enter 切换展开，选中行底色 selected）——这是时间线页特有，日志页不加（保持功率视图纯翻页）
  - message → 一行：`⏺`(user 色) + 时间(muted) + `${fromName} → ${toName}：body 截断 80`（text）+ 右侧 muted `消息`
- 头部行：标题（accent）+ `第 N 页 · PgUp/PgDn 翻页 · j/k 选择 · Enter 展开`（muted）
- 空状态：`copy.emptyStates.timeline` + Mascot happy
- scrollbox key 含 `timelinePage` 与 expanded 集合大小（展开改变高度时强制重建）

### 第 3 步：screens/Logs.tsx 重做审计行
保留全部行为逻辑（entries 组装、排序、分页、anchorAt、remote 聚合、showAudit 开关、累积上下文），只换渲染：
- AuditRow → 新的 `ToolCallRow`（expanded 由 Logs 页内部 state 持有，**仅鼠标点击切换**，不加键盘选中模型）
- RuntimeRow → 视觉微调：状态色用 theme 角色（error→bad / ok→good / info→accent），操作名 tool 色，保持现有紧凑单行
- 头部行保留：audit 开关状态、页码、累积上下文
- scrollbox key 含 `logPage`（App 已有 logAnchorAt/logPage 处理，确保传入）

### 第 4 步：App.tsx 接线
- tab 3：`<Timeline ... page={timelinePage} onPageChange={setTimelinePage} />`；新增 `timelinePage` state；`switchTab`/`nextTab` 切换时重置 timelinePage=0（参照 logPage 处理）
- 键盘：日志翻页条件 `!form && !detail && tab === 7` 扩展为 tab 3 也支持 PgUp/PgDn（分别操作 timelinePage/logPage）
- keymap.ts：tab===3 加选择移动（j/k/↑↓/PgUp/PgDn/Home/End 复用 moveSelection 模式或页内自管——**建议页内自管选中索引**，与 App 的 selected[] 体系不冲突；在审查报告里说明选择）

### 第 5 步：验证 + commit
```bash
bunx tsc --noEmit -p tsconfig.json && bun run test
```
全绿后 commit：
- `feat(tui): M4b Timeline full activity stream + Logs ToolCallRow restyle`

## 八、验收清单（审查报告第 6 节逐项 ✓/✗）

1. tab 3 时间线：消息+审计按时间降序混合显示，类型色（tool/user）、⏺ 标记正确；100 条/页 + PgUp/PgDn
2. 时间线选中模型：j/k 移动、Enter 展开/折叠 ToolCallRow、展开时参数/返回惰性显示且截断 200 字符；展开不引起布局跳动
3. tab 7 日志页：AuditRow 已换 ToolCallRow（点击折叠/展开）；分页、anchorAt、`a` 开关、跨工作区聚合、累积上下文全部保留可用
4. 两页空状态都是 copy.emptyStates.timeline / 现有日志空状态；双语跟随
5. running 审计条目在双速 tick 下 150ms 级出现并原位完成（代码审查确认数据流：auditFacts → memoizedMerge → render）
6. `bun run test` 全绿（含新增测试：timeline 全量 limit=0、ToolCallRow 截断纯函数如有）

## 九、审查报告（原样填写，保存为 `deliverables/tui-redesign-handoff/review-M4b.md`）

```markdown
# 审查报告：M4b 时间线页+日志页
- 日期：  - 执行者：  - 分支：

## 1. 执行摘要（≤10 行）
## 2. 改动清单（commit 列表 + git diff --stat）
## 3. 验证结果（tsc + bun run test 末尾 15 行原文）
## 4. 硬规则自查（10 条逐条 ✓/✗ + 证据）
## 5. ADR 符合性自查（决策 7 两行 / A.1 条目类型 / A.2 折叠行 / 决策 8 memoize+分页）
## 6. 功能自查清单（第八节 1-6 逐项）
## 7. 偏差记录（含选中模型的实现选择说明）
## 8. 阻塞与提问
## 9. 风险与遗留（给 M5 的提醒）
## 10. 请审查者重点看（1-3 处）
```

## 十、交接给 M5 的信息

- ToolCallRow 的 expanded 父托管模式是既定范式；M5 的 Settings 分组卡片不需要折叠，勿过度套用
- 时间线/日志两套 page state 在 App.tsx（timelinePage/logPage），M5 不动它们
- M5 的 Diff 页截断警告文案可复用 ToolCallRow 的截断哲学
