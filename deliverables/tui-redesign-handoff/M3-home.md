# 任务 M3：主屏 Home — 问候 + 会话摘要 + 动态精选

> 你是执行本任务的弱模型，全新上下文。本文档自包含：先读两遍，再动手。
> 前置：M2 已交付（骨架、chrome、InputBar、双速 tick）。若 M2 的 `review-M2.md` 不存在，停下并在报告中说明。
> 交付物 = 代码 commit + 填写文末《审查报告》保存为 `deliverables/tui-redesign-handoff/review-M3.md`。

## 一、你的处境

MyTerminal 是「ChatGPT/Claude 网页端 ↔ 本地电脑」的桥接服务（Bun + TypeScript + OpenTUI + React 19）。TUI 正按 ADR-0004 完全重做为 Claude Code 风格。M1 交付了暖色主题/文案/吉祥物，M2 交付了骨架（8 页 + chrome + InputBar + 双速 tick）。

你的任务：把**概览页（tab 0）**从旧的服务器参数表重做为新主屏 Home——吉祥物问候、会话摘要、动态时间线精选。这是整个产品的门面。

## 二、硬规则（违反任何一条 = 任务失败）

1. **分支铁律**：只在 `feat/tui-claude-redesign`。开工先 `git branch --show-current` 确认。禁止 checkout/merge/push/rebase/reset/force。
2. **核心禁区**：绝不修改 `src/store.ts`、`src/extensions.ts`、`src/core-tools.ts`、`src/server.ts`、`src/mcp.ts`、`src/types.ts`、`src/config.ts`、`src/tui-model.ts`。改动面只有 `src/tui/**` 和 `test/**`。
3. **TuiController 禁区**：`src/tui/state.ts` 的 `TuiController` 类方法与 `phaseColor/presenceColor/themeFor/hiddenAppsUrl/visibleActionsToken` 不得改变。
4. **测试铁律**：每次 commit 前 `bun run test` 全绿（M2 后基线 ≥ 98 pass / 0 fail）。禁止改既有测试强行通过；确需调整须在第 7 节标注。
5. **主题铁律**：禁止硬编码颜色，只用 Theme 16 角色（`src/tui/theme/types.ts`）。
6. **文案铁律**：L1 文案（问候/空状态/状态动词/主屏摘要句）必须走 `src/tui/copy/` 模块；禁止新增 emoji（用 ● ○ ⏺ ❯ ✓ ✗）。
7. **布局稳定铁律**：固定宽度内容 `wrapMode="none"`；对齐用 flex；动态高度状态入 scrollbox key。
8. **性能铁律**：时间线归并必须按 revision 字符串 memoize；不新增全局定时器；本页渲染不增加每秒 structuredClone 次数（用现有 snapshot）。
9. **风格铁律**：与 M1/M2 一致（文件头注释、`import type`、`.js` 后缀、具名导出、strict TS 无 any）。
10. **不确定就停**：写进审查报告「8. 阻塞与提问」。

## 三、环境与验证

```bash
cd 
git branch --show-current
bunx tsc --noEmit -p tsconfig.json
bun run test   # 必须全绿
```

## 四、代码风格范例（先读）

`src/tui/theme/palette.ts`、`src/tui/copy/index.ts`、`src/tui/model/mascot-mood.ts`、`src/tui/components/Mascot.tsx`、`src/tui/hooks/useMascotMood.ts`、`src/tui/model/command-router.ts`（M2）、`test/tui-redesign.test.mjs`。

## 五、本任务相关 ADR-0004 决策（原文摘录）

**决策 2（主屏骨架，本任务全部）**：
> 主屏（概览页）= **拟人化问候 + 会话摘要 + 活动时间线 + 底部轻量导航**：
> 1. **吉祥物问候区**：活化 ◔◔ 小生物 + 第二人称拟人状态摘要（"2 个 session 正在干活，一切正常。"）。
> 2. **会话摘要区**：当前活跃逻辑会话树（root + 子 session 缩进），右对齐状态色点与相位。
> 3. **动态时间线**：工具调用审计 + 消息混合的最近活动流，⏺ 标记 + 相对时间；完整记录仍归 Logs 页。

**决策 5（吉祥物）**：Mascot 组件已存在（`src/tui/components/Mascot.tsx`），本任务用 `useMascotMood` 接线真实 mood。

**决策 6（文案）**：问候语/摘要句走 copy 模块；L1 俏皮、L2 精确。

**决策 7（主屏行）**：概览 Home = 决策 2 已定：问候 + 会话摘要 + 动态精选。

**决策 8（性能）**：时间线归并（消息 + 审计排序合并）按 revision 字符串 memoize，不在每次渲染重复 O(n log n)。

**附录 A.1（ag-ui 映射）**：动态区条目类型 = audit（工具调用，running→完成原位更新）与 message（消息），⏺ 标记 + 类型色。

## 六、现状关键代码（已替你定位）

- `src/tui/screens/Overview.tsx` — 旧概览页（将被本任务的 Home 取代并删除）
- `src/tui/App.tsx` — tab 0 渲染 Overview 处（改为 Home）
- `src/tui-model.ts` — `logicalSessionGroups(sessions)` 逻辑会话分组（直接复用，禁改此文件）
- `src/tui/screens/Logs.tsx` 顶部 — `runtime.store.auditFacts(5000)` 与 `cumulativeContextChars` 用法参考
- `src/tui/state.ts` — `TuiSnapshot`（snapshot 结构）、`phaseColor/presenceColor`
- `src/tui/copy/types.ts` — Copy 类型（本任务需要扩展一个字段，见第 3 步）

## 七、逐步执行

### 第 0 步：环境检查 + 读 M2 审查报告
```bash
git branch --show-current && ls deliverables/tui-redesign-handoff/review-M2.md && bun run test 2>&1 | tail -3
```

### 第 1 步：model/timeline-merge.ts（纯函数 + memoize）
新建 `src/tui/model/timeline-merge.ts`：

```ts
import type { MyTerminalMessage, ToolAuditEvent } from '../../types.js';

export type ActivityEntry =
  | { kind: 'audit'; at: string; action: string; source: string; status: ToolAuditEvent['status']; durationMs?: number; sessionName?: string; errorCode?: string }
  | { kind: 'message'; at: string; fromId: string; toId: string; body: string };

/** 消息 + 审计按时间降序归并（最新在前），limit 截断。 */
export function mergeActivity(messages: MyTerminalMessage[], audits: ToolAuditEvent[], limit: number): ActivityEntry[]

/** 按 revision 字符串 memoize 的版本：同 revision 直接返回缓存。 */
export function memoizedMergeActivity(revision: string, messages: MyTerminalMessage[], audits: ToolAuditEvent[], limit: number): ActivityEntry[]
```

实现要点：纯函数；messages/audits 输入不改动（只读）；merge 后 `b.at.localeCompare(a.at)` 降序；limit>0 时 slice。memoize 用模块级单槽缓存 `{ revision, result }`（单槽即可，revision 单调前进）。

新建测试追加到 `test/tui-redesign-m3.test.mjs`：归并排序、limit、kind 判别、memoize 命中（同 revision 返回同一引用）、audit running 状态透传。

### 第 2 步：扩展 Copy（homeSummary）
在 `src/tui/copy/types.ts` 的 `Copy` 类型增加：
```ts
/** L1：主屏状态摘要句 */
homeSummary(active: number, pending: number): string;
```
在 `zh-CN.ts` / `en.ts` 实现（**就用以下文案，不要自由发挥**）：
- zh：active>0 且 pending===0 → `${active} 个 session 正在干活，一切正常。`；pending>0 → `${pending} 个 session 等你安排 controller，按 2 去看看。`；active===0 且 pending===0 → `现在很闲。按 n 派个活儿，或输入 /new。`
- en：active>0 且 pending===0 → `${active} session(s) on the job. All good.`；pending>0 → `${pending} session(s) waiting for a controller — press 2.`；都 0 → `All quiet. Press n to delegate, or type /new.`

在 `test/tui-redesign-m3.test.mjs` 补 homeSummary 三分支测试（两种语言）。

### 第 3 步：hooks/useTimelineModel.ts
新建 `src/tui/hooks/useTimelineModel.ts`：从 `TuiSnapshot` 取数：
```ts
export function useTimelineModel(snapshot: TuiSnapshot, limit: number): ActivityEntry[]
```
- messages：`snapshot.state.messages`
- audits：`snapshot.runtime.store.auditFacts(5000)`（参考 Logs.tsx）
- revision：`snapshot.runtime.store.revision()` 拼 `snapshot.runtime.runtimeLogRevision()`（与 renderRevision 同数据源即可）
- 调 `memoizedMergeActivity`

### 第 4 步：screens/Home.tsx
新建 `src/tui/screens/Home.tsx`。props：`{ runtime, state, snapshot, theme, zh, copy }`（snapshot 用于 timeline model 与 mascot mood；state 为 snapshot.state，可合并取舍，保持与 App 传参简洁）。

布局（自上而下，参照已确认设计稿）：

1. **问候区**（row，gap=2，alignItems center）：
   - 左：`<Mascot mood={useMascotMood(snapshot)} theme={theme} />`
   - 右（column）：`greetingFor(copy)`（text 加粗 15px 感）+ `copy.homeSummary(active, pending)`（muted）
   - active = 非终态且 claimed 的 session 数；pending = 非终态且非 claimed 的 session 数
2. **会话区**（section 标题 accent：`会话`/`Sessions`，右侧 muted：`${active} active · 按 2 看全部`）：
   - 取 `logicalSessionGroups(state.sessions)` 前 3 组，每组：
     - `●`（accent）+ `组名 · role`（text 加粗）+ 右侧 `phase ●`（phaseColor）
     - 下一行 muted 缩进：`⎿ ${latestCheckpoint?.summary || finalSummary || copy 空状态短句}` + 右侧相对时间（muted）
     - children 缩进 `├─`/`└─` + 名称 + 右侧 `phase/presence` 色点
   - 无会话 → `copy.emptyStates.sessions`（muted）
3. **动态区**（标题 accent：`动态`/`Activity`，右侧 muted：`按 4 看时间线 · 按 8 看日志`）：
   - `useTimelineModel(snapshot, 7)` 前 7 条，每条一行：
     - `⏺`（audit→tool 色 / message→user 色）+ HH:MM:SS（muted，用现有 Logs.tsx `timeOf` 的方式格式化）+ 内容 + 右侧状态
     - audit 行内容：`${source}/${action}${sessionName ? ` · ${sessionName}` : ''}`；右侧状态：running→accent `● running`，completed→good `✓ ${durationMs}ms`，failed/timeout→bad `✗${errorCode ? ` ${errorCode}` : ''}`，policy_rejected→warn `⊙ policy`
     - message 行内容：`${fromName} → ${toName}：${body 截断 60 字符}`；右侧 muted `消息`
   - fromName/toName：session id → 名称映射（state.sessions 建 Map，`'user'` → zh `你` / en `You`）
   - 空 → `copy.emptyStates.timeline`
4. 底部留一行 muted 小字提示（zh：`i 输入消息或 / 命令` en：`i to type a message or / command`）

**相对时间**工具：在 `src/tui/model/` 新建 `relative-time.ts` 纯函数 `relativeTime(iso: string, now: Date, zh: boolean): string`（<60s `刚刚`/`just now`、<60m `N 分钟前`/`Nm ago`、<24h `N 小时前`/`Nh ago`、否则日期）。补单测。

### 第 5 步：App.tsx 切换 + 删旧页
- tab 0 渲染从 `<Overview .../>` 改为 `<Home runtime={runtime} state={state} snapshot={snapshot} theme={theme} zh={zh} copy={copyFor(zh)} />`
- Overview 的凭据 reveal 功能（hiddenAppsUrl/visibleActionsToken）**迁移**：Home 页保留凭据行吗？——设计稿主屏不含凭据行，凭据在 Settings 页（tab 6）已有。所以 Home 不迁移凭据行；App 中 Overview 相关 reveal 逻辑保持对 tab 0 无害即可（reveal 在 tab 0 不再影响渲染，保留 `[0, 6]` 资格不报错）。
- 删除 `src/tui/screens/Overview.tsx`。
- 若 App 顶部有不再使用的 import（如 hiddenAppsUrl），清理干净。

### 第 6 步：验证 + commit
```bash
bunx tsc --noEmit -p tsconfig.json && bun run test
```
全绿后 commit：
- `feat(tui): M3 Home screen — greeting, session summary, activity digest`
- 正文 bullet：timeline-merge memoized、homeSummary copy、Mascot mood wired、Overview removed

## 八、验收清单（审查报告第 6 节逐项 ✓/✗）

1. tab 0 显示新 Home：Mascot（mood 随状态变化：制造一个 pending session → expectant；触发 error 日志 → sad）+ 问候语按小时变化 + 摘要句三分支正确
2. 会话区显示前 3 个逻辑会话组，树形缩进、相位色点、checkpoint 摘要、相对时间正确；无会话时显示 copy 空状态
3. 动态区混合显示 audit 与 message 条目，类型色、⏺ 标记、状态（running/completed/failed/policy）正确；空时显示 copy.emptyStates.timeline
4. 时间线归并 memoize 生效（单测证明同 revision 同引用）
5. 旧 Overview.tsx 已删除，凭据 reveal 在 Settings（tab 6）仍正常
6. 中英双语切换后所有新文案跟随（homeSummary/greeting/emptyStates）
7. `bun run test` 全绿（含新增 m3 测试）

## 九、审查报告（原样填写，保存为 `deliverables/tui-redesign-handoff/review-M3.md`）

```markdown
# 审查报告：M3 主屏 Home
- 日期：  - 执行者：  - 分支：

## 1. 执行摘要（≤10 行）
## 2. 改动清单（commit 列表 + git diff --stat）
## 3. 验证结果（tsc 输出 + bun run test 末尾 15 行原文）
## 4. 硬规则自查（10 条逐条 ✓/✗ + 证据；第 2 条附 git diff --name-only 无禁区文件）
## 5. ADR 符合性自查（决策 2 四区 / 决策 5 mood / 决策 6 文案 / 决策 8 memoize / A.1 条目类型）
## 6. 功能自查清单（第八节 1-7 逐项）
## 7. 偏差记录
## 8. 阻塞与提问
## 9. 风险与遗留（给 M4a 的提醒）
## 10. 请审查者重点看（1-3 处）
```

## 十、交接给 M4a 的信息

- `model/timeline-merge.ts` 与 `model/relative-time.ts` 是共享纯函数，M4b 的时间线页会全量复用
- Home 的动态区是"精选"（7 条），M4b 做全量分页
- MessageBubble 还不存在，M4a 创建；Home 的 message 行样式以简单文本行实现，M4a 不必回头统一
