# 任务 M5：工具页（Diff/扩展/设置）+ Setup 向导 + 致命错误页

> 你是执行本任务的弱模型，全新上下文。本文档自包含：先读两遍，再动手。
> 前置：M2-M4b 已交付。缺任一 review 文件就停下说明。
> 交付物 = 代码 commit + 填写文末《审查报告》保存为 `deliverables/tui-redesign-handoff/review-M5.md`。

## 一、你的处境

MyTerminal 是「ChatGPT/Claude 网页端 ↔ 本地电脑」的桥接服务（Bun + TypeScript + OpenTUI + React 19）。TUI 按 ADR-0004 重做为 Claude Code 风格。M1-M4b 已完成（主题/骨架/主屏/会话/消息/时间线/日志）。

你的任务：重做剩余页面——**tab 4 Diff**（文件分组 + 暖色 +/-）、**tab 5 扩展**（卡片 + 徽标 + 空状态）、**tab 6 设置**（分组卡片表单）、**Setup 首次向导**（视觉）、**FatalErrorBoundary**（视觉）。这些是"企业级精确"的承载页：功能语义一律不变，只重设计视觉与文案分层。

## 二、硬规则（违反任何一条 = 任务失败）

1. **分支铁律**：只在 `feat/tui-claude-redesign`。禁止 checkout/merge/push/rebase/reset/force。
2. **核心禁区**：绝不修改 `src/store.ts`、`src/extensions.ts`、`src/core-tools.ts`、`src/server.ts`、`src/mcp.ts`、`src/types.ts`、`src/config.ts`、`src/tui-model.ts`。改动面只有 `src/tui/**` 和 `test/**`。
3. **TuiController 禁区**：`state.ts` 的 `TuiController` 类方法（含 `editSettings/rotateCredentials/updateApplication`）不得改变——本任务的设置页交互全部走既有 ask() 表单流程。
4. **测试铁律**：commit 前 `bun run test` 全绿。禁止改既有测试强行通过。
5. **主题铁律**：只用 Theme 16 角色，禁止硬编码颜色。
6. **文案铁律**：L1 俏皮只出现在空状态/提示性内容；**设置项、凭据、错误提示、确认文案是 L2 精确层，措辞保持现有语义**（可换排版，不可换含义）。禁止新增 emoji。
7. **布局稳定铁律（本任务高危）**：凭据行/URL 行 `wrapMode="none"` 必须保留（按 v 切换长度变化，换行会导致 scrollbox 高度跳动——这是项目前科）；凭据 reveal 的 fail-closed 语义（450ms deadline、导航即隐藏）**一个字都不许动**。
8. **性能铁律**：不新增全局定时器；Diff 页沿用 `WorkspaceDiffTracker` 的 10s 轮询与现有 snapshot。
9. **风格铁律**：与 M1-M4b 一致。
10. **不确定就停**：写进「8. 阻塞与提问」。**macOS 被动锁屏相关 UI 只能原样搬迁**，行为参数（arm/standby/off、权限提示）不得改。

## 三、环境与验证

```bash
cd 
git branch --show-current
bunx tsc --noEmit -p tsconfig.json
bun run test
```

## 四、代码风格范例（先读）

`src/tui/screens/Home.tsx`（M3）、`src/tui/screens/Sessions.tsx`（M4a）、`src/tui/components/ToolCallRow.tsx`（M4b，截断哲学）、`src/tui/components/Mascot.tsx`。

## 五、本任务相关 ADR-0004 决策（原文摘录）

**决策 7（本任务三行 + Setup/错误页）**：
> | Diff | 文件分组头部 + 暖色 +/−；截断与不可用状态文案沿用 L1 俏皮 |
> | 扩展 Extensions | 卡片列表 + handler 类型徽标 + 俏皮空状态 |
> | 设置 Settings | 分组卡片式表单页；凭据行保持 fail-closed 语义（仅视觉重设计） |

**决策 5（吉祥物出现位置）**：主屏问候区、各页空状态、**Setup 向导、致命错误页**（sad）。

**约束（已查明的架构事实）**：
> 凭据显示是 fail-closed 状态机（450ms deadline），属于安全契约，视觉可重设计但语义不动。

**决策 6（文案分层）**：L1 俏皮层 = 问候/空状态/状态动词；L2 精确层 = 操作项、设置项、错误信息、确认提示。

## 六、现状关键代码（已替你定位）

- `src/tui/screens/Diff.tsx` — 现状（colorFor 已按 +/- 着色，本任务加分组）
- `src/tui/screens/Extensions.tsx` — 现状
- `src/tui/screens/Settings.tsx` — 现状（凭据行 wrapMode="none" 已就位；`maskCredential`、`hiddenAppsUrl/visibleActionsToken`（state.ts）、`runtimeSettingsSnapshot`、`passiveLockStatus`、UpdateStatus 行——全部保留语义）
- `src/tui/Setup.tsx` — 首启向导（FormDialog 驱动；视觉容器是底部 `<box>`）
- `src/tui/FatalErrorBoundary.tsx` — 致命错误页
- `src/tui/components/FormDialog.tsx` / `Modal.tsx` — 弹窗体系（**只允许视觉微调**：边框色/背景走 theme 角色，逻辑不动）

## 七、逐步执行

### 第 0 步：环境检查 + 读前置审查报告
```bash
git branch --show-current && ls deliverables/tui-redesign-handoff/review-M2.md deliverables/tui-redesign-handoff/review-M3.md deliverables/tui-redesign-handoff/review-M4a.md deliverables/tui-redesign-handoff/review-M4b.md && bun run test 2>&1 | tail -3
```

### 第 1 步：model/diff-groups.ts（纯函数 + 单测）
新建 `src/tui/model/diff-groups.ts`：
```ts
export type DiffGroup = { file: string; header: string[]; lines: string[] };
export function groupDiffLines(lines: string[]): DiffGroup[]
```
- 以 `diff --git a/<old> b/<new>` 行切分；file 取 `b/` 后路径；header 为该文件的 `index/---/+++` 等元信息行；lines 为 @@ 与 +/- 内容行
- 不属于任何文件的头部行（如 `warning:` 类）归入 file='' 的组
- 测试：`test/tui-redesign-m5.test.mjs`：多文件切分、无文件头边界、空输入

### 第 2 步：screens/Diff.tsx 重做
- 每个 DiffGroup 渲染：文件头行（`▸ file`，warn 色加粗，panelAlt 背景一行）+ 内容行（+/- 用 theme.good/bad、@@ 用 accent、其余 text——沿用现有 colorFor 语义）
- 保留：updatedAt/refreshing 行、error 行、两种 unavailableReason 提示（L2 语义不变，文案可微调排版）、truncated 与 truncationReasons（warn）
- "工作区干净"空状态改用 `copy.emptyStates.diffClean`
- 刷新中的状态词可用 L1：`verbLabel(copy, 'diff-refresh')`（动词锁定）

### 第 3 步：screens/Extensions.tsx 重做
- 卡片列表保留；handler 类型显示为徽标：右侧小 box（panelAlt 背景 + accent 文字）包裹 `builtin`/`command`
- 选中态/点击逻辑保留
- 空状态改用 `copy.emptyStates.extensions` + Mascot（happy）

### 第 4 步：screens/Settings.tsx 分组卡片化
视觉重排为三组卡片（每组 panel 背景 + 内边距 + 组标题 accent）：
1. **运行设置**：语言/主题/配置文件/工作区/监听/公网 URL/最大输出/超时/Harness/非阻塞任务——行内容**逐字保留现有值来源**（`runtimeSettingsSnapshot`）
2. **macOS 被动锁屏**：仅 darwin 显示完整状态；权限缺失警告行原样保留；非 darwin 显示 muted 一行
3. **连接凭据 + 更新**：`Apps connector` / `Actions token` 行——**`wrapMode="none"` 与 reveal 逻辑原样搬迁**；轮换警告行保留；更新状态行（UpdateStatus 全部分支文案）保留
- `c`/`k`/`u` 键由 keymap 既有绑定触发（tab 6，M2 已就位），本任务不动交互

### 第 5 步：Setup.tsx + FatalErrorBoundary 视觉
- Setup：容器加入 Mascot（happy）于表单上方居中；其余 FormDialog 流程、问题、校验、端口冲突处理**一行不改**
- FatalErrorBoundary：加入 `<Mascot mood="sad" theme={theme} animated={false} />`；标题/说明/错误消息文案保留（可微调排版）；`q`/`Esc` 退出逻辑不动

### 第 6 步：验证 + commit
```bash
bunx tsc --noEmit -p tsconfig.json && bun run test
```
全绿后 commit：
- `feat(tui): M5 utility pages — Diff groups, Extensions badges, Settings cards, Setup/Fatal visuals`

## 八、验收清单（审查报告第 6 节逐项 ✓/✗）

1. Diff 页按文件分组显示，文件头行醒目；+/- 色、@@ 色正确；truncated/unavailable/refreshing 状态全部保留；干净工作区显示 copy 空状态
2. 扩展页 handler 徽标显示；空状态 copy + Mascot
3. 设置页三组卡片；**凭据行按 v 显示/隐藏正常且布局不跳动（wrapMode="none" 在）**；更新状态行各分支正确；被动锁屏行 darwin/非 darwin 正确
4. 设置 `c` 修改流程、凭据轮换 `k`、更新 `u` 全部走通既有 ask() 表单（行为零变化）
5. Setup 向导显示 Mascot 且全流程可完成（问题/校验/端口冲突不变）；FatalErrorBoundary 显示 sad Mascot，q/Esc 可退出
6. 双语切换后新文案跟随；L2 区域文案语义与旧版一致
7. `bun run test` 全绿（含 m5 新测试）

## 九、审查报告（原样填写，保存为 `deliverables/tui-redesign-handoff/review-M5.md`）

```markdown
# 审查报告：M5 工具页+Setup+错误边界
- 日期：  - 执行者：  - 分支：

## 1. 执行摘要（≤10 行）
## 2. 改动清单（commit 列表 + git diff --stat）
## 3. 验证结果（tsc + bun run test 末尾 15 行原文）
## 4. 硬规则自查（10 条逐条 ✓/✗ + 证据；第 7 条附凭据行 wrapMode 代码行号证据）
## 5. ADR 符合性自查（决策 7 三行 / 决策 5 Setup+错误页 / 决策 6 L1L2 分层 / 凭据 fail-closed 语义未动）
## 6. 功能自查清单（第八节 1-7 逐项）
## 7. 偏差记录
## 8. 阻塞与提问
## 9. 风险与遗留（给 M6 的提醒）
## 10. 请审查者重点看（1-3 处）
```

## 十、交接给 M6 的信息

- 全部 8 页 + Setup + 错误页视觉已定稿，M6 的 docs SVG 按此重画
- 设置页是 L2 精确层的样板，M6 手测清单里的文案核对以此为准
- 若本任务动了 Modal/FormDialog 视觉，M6 需在报告里联动说明
