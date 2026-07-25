# 终审报告：TUI 完全重做（M2-M6 弱模型交付）

- 终审人：主理模型（frontend-developer）
- 日期：2026-07-26
- 分支：feat/tui-claude-redesign（隔离，不合并）
- 终审范围：M2-M6 全部交付（6 份 review 报告 + 代码 + 测试 + SVG + ADR 定稿）
- 终审修复 commit：`2239f98`（本报告所述 P1/P2/P3 已全部修于该 commit）

## 1. 终审结论

**通过（有条件）**：弱模型交付质量整体良好，测试从 98 增至 178 全绿，核心禁区零改动，ADR 决策逐条落地。但终审独立复核发现 **2 个真实 bug（P1 逻辑正确性 / P2 交互隔离）+ 4 个轻微问题**，弱模型 6 份 review 报告均未发现 P1/P2。已全部修复并回归测试锁定。

**遗留**：4 项 REQUIRES-HUMAN（真实终端人工验证），1 项预存问题（Modal.tsx 硬编码色，不属本分支）。

## 2. 终审方法（不采信 review，独立复核）

| 步骤 | 结果 |
|---|---|
| 禁区核查 `git diff main...HEAD --name-only` | ✅ 改动面仅 src/tui/**、test/**、docs/**、scripts/generate-svgs.ts；store/extensions/core-tools/server/mcp/types/config/tui-model/diff 零改动 |
| 独立重跑 `bun run test` | ✅ 177 pass / 0 fail（修复后 178） |
| state.ts 全 diff 审读 | ✅ 仅 TABS 插入 Timeline + Theme/themeFor 改 re-export；TuiController 零改动 |
| 关键算法逐个精读 | timeline-merge、command-router、keymap 五层、双速 tick、useTimelineModel、ToolCallRow、InputBar 状态机 |
| 数据流链路追踪 | snapshot → useTimelineModel → memoizedMergeActivity → Home(7)/Timeline(0) 双调用点 |

## 3. 结构与数据流总评

**骨架（M2）**：TABS 8 页索引重映射全部正确（扩展 4→5、设置 5→6、日志 6→7、凭据资格 [0,6]、moveSelection 分支、selectedTargetId 分支）。keymap 五层优先级真实生效：InputBar 350 自管理、keymap.ts 的 200/100 层 `!inputEditing` 禁用。双速 tick 实现正确：150ms 只比对 `renderRevision()` 字符串（廉价），变化才 refresh；1s 慢 tick 独立维持 reminders。

**主屏（M3）**：homeSummary 三分支、greetingFor、useMascotMood 接线正确。会话组树形缩进 ├─/└─ 逻辑正确（isLast 判定）。

**会话/消息（M4a）**：history-entry.ts 的 11 种类型 + fallback 映射有 32 项单测，防御式取值（str/strs/clip）消灭了 JSON 裸输出。MessageBubble 的 selfSide 按 from==='user' 分发正确。

**时间线/日志（M4b）**：ToolCallRow 惰性 stringify（expanded 才 JSON.stringify）正确；Timeline 页内 250 优先级选中模型与 App 体系正交；entryKey 用 idx 兜底防碰撞——可接受。

**工具页（M5）**：凭据行 wrapMode="none" 保留、450ms deadline 逻辑未动、Diff 分组纯函数 + 6 项单测。

**收尾（M6）**：SVG viewBox/文件名不变、暖色 palette 正确（#221E19 背景 / #E07850 强调色）；ADR 只定稿未改决策。

## 4. 终审发现（已全部修复于 2239f98）

### P1 — memoizedMergeActivity 跨 limit 缓存污染（逻辑正确性，必修）

- **位置**：`src/tui/model/timeline-merge.ts`（原 L42-56）
- **问题**：单槽缓存 key 只含 revision，不含 limit。调用点有两个：Home `useTimelineModel(snapshot, 7)`、Timeline `useTimelineModel(snapshot, 0)`。
- **触发场景**：revision 静止（无新活动）时切换 tab：
  - Home→Timeline：Timeline 命中 Home 的 7 条缓存 → `entries.length=7` → totalPages=1 → **分页失效，只能看 7 条**
  - Timeline→Home：Home 命中全量缓存 → `entries.map` 直接渲染 → **主屏动态区渲染数百行**
- **为何测试没抓到**：M3/M4b 测试只覆盖"同 revision 同 limit"场景；跨 limit 场景无人测。
- **修复**：MemoSlot 增加 limit 字段，命中条件 `slot.revision === revision && slot.limit === limit`。取舍：同 revision 不同 limit 交替时单槽互相覆盖（miss 重算 O(n log n)，仅切换瞬间一次，可接受）；拒绝用 Map 多槽（revision 单调增长会内存泄漏）。
- **回归测试**：`memoizedMergeActivity does not share cache across different limits at same revision`（12 条数据，limit 0→7→0→7 交叉验证长度与引用）。

### P2 — Editing 态键盘隔离漏洞（交互正确性，应修）

- **位置**：`src/tui/App.tsx` useKeyboard（原 L244、L267）
- **问题**：keymap.ts 的 200/100 层已正确加 `!inputEditing` 禁用，但 App 的裸 useKeyboard 两处漏判：
  - Editing 时按 PgUp/PgDn → Timeline/Logs 照样翻页
  - Editing 时输入字母 v（tab 0/6）→ 触发凭据 reveal 闪烁 450ms
- **修复**：两处条件均加 `!inputEditing`，与 keymap 层隔离对齐。

### P3 — 轻微问题（4 项，已顺手修复）

1. `Home.tsx` 死导出 `export { useTimelineModel }`（无人从 Home import）→ 已删
2. `command-router.ts` 注释"最长公共前缀"与实现不符（实现是"以输入为前缀的最长命令名"）→ 注释已修正
3. `HelpOverlay` 命令表缺 `/help`、`/帮助`（M6 B12 遗留）→ 已补
4. `mergeActivity` audits 参数 `source: string` 宽化导致 Timeline 需 `as` 断言 → 全链收紧为 `ToolAuditEvent['source']`（新增 MergeAuditInput 类型，与 store.auditFacts 的 AuditFact 结构天然兼容），as 断言已删

## 5. 弱模型 review 报告可信度评估

| 报告 | 声称 | 终审复核 | 评价 |
|---|---|---|---|
| review-M2 | 108 pass、五层隔离 | ✅ 属实；但 P2 隔离漏洞未发现 | 基本可信，自查有盲区 |
| review-M3 | 129 pass、memoize 同引用 | ✅ 属实；但 P1 跨 limit 场景未测 | 基本可信，测试设计有盲区 |
| review-M4a | 162 pass、11 类型映射 | ✅ 属实；附录实测 type 集合有价值 | 可信 |
| review-M4b | 171 pass、惰性 stringify | ✅ 属实；偏差记录（250 优先级自管选中）合理 | 可信 |
| review-M5 | 177 pass、凭据语义不动 | ✅ 属实 | 可信 |
| review-M6 | 17 项验收 12✓4 人工 1✗ | ✅ 属实；B11/B12 诚实标注 | 可信，自我揭发态度正确 |

**结论**：review 报告无虚假陈述，但"自查通过"不等于"无 bug"——P1 是测试设计盲区（只测单 limit），P2 是跨文件一致性盲区（keymap 改了、useKeyboard 漏了）。交接文档的审查报告模板应增加一条：**"跨文件一致性自查：本任务改的交互条件，是否在所有监听点同步"**。

## 6. 遗留事项

### REQUIRES-HUMAN（需你在真实终端人工验证）

1. 8 页 × 双主题 × 双语真实渲染（重点：Home 动态区、Timeline 分页、凭据 reveal）
2. InputBar 实际击键：命令/消息/历史↑↓/Tab 补全/Esc
3. Mascot 眨眼动画肉眼确认（2600ms 周期 / 140ms 闭眼）
4. Windows 兼容模式（20fps / 键盘-only / 无 alt-screen）

### 预存问题（不属本分支，记录为 debt）

- `Modal.tsx:8` 硬编码 `#000000bb`（半透明遮罩）。建议在 palette.ts 增加 overlay 角色，另开任务修复。
- `store.ts:848/850` createDelegate 疑似重复 push（此前已记录，核心逻辑另行验证）。

### 冒烟说明

- headless 冒烟未能自动验证（本机已有实例占用工作区锁）——属正常集群行为，空闲终端手动 `bun run start -- --headless` 即可。

## 7. 最终状态

- 分支：feat/tui-claude-redesign，15 个 commit（M1→M6 + ADR×3 + 终审修复）
- 测试：**178 pass / 0 fail**（基线 92 → 98 → 108 → 129 → 162 → 171 → 177 → 178）
- typecheck：0 错误
- 禁区：零改动
- ADR-0004：12 项决策全部落地，里程碑 M1-M6 全标 ✅
