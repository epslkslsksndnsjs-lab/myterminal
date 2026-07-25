# 任务 M2：骨架 — 8 页路由 + chrome 三件套 + InputBar + 双速 tick

> 你是执行本任务的弱模型，全新上下文。本文档自包含：先读两遍，再动手。
> 交付物 = 代码 commit（本分支内）+ 填写文末《审查报告》保存为 `deliverables/tui-redesign-handoff/review-M2.md`。

## 一、你的处境

MyTerminal 是「ChatGPT/Claude 网页端 ↔ 本地电脑」的桥接服务（Bun + TypeScript + OpenTUI + React 19）。它的 TUI 正在按 ADR-0004 完全重做（Claude Code 风格：温暖、俏皮、对话感、企业级精确）。设计已定稿，M1 地基（暖色主题、文案模块、吉祥物）已完成并提交。你的任务是把**应用骨架**换成新结构：8 个页面、新的顶/底/状态栏、底部常显输入栏、更快的刷新节奏。

**本任务只做骨架**：页面内容除 Timeline 占位外保持现状（M3-M5 才重做各页内容）。骨架完成后应用必须能正常编译、测试全绿、每个页面能切换显示。

## 二、硬规则（违反任何一条 = 任务失败，必须返工）

1. **分支铁律**：全程只在 `feat/tui-claude-redesign`。开工先跑 `git branch --show-current`，输出不是它立即停止并在审查报告中说明。禁止 `checkout / merge / push / rebase / reset --hard / force` 任何分支。
2. **核心禁区**：绝不修改 `src/store.ts`、`src/extensions.ts`、`src/core-tools.ts`、`src/server.ts`、`src/mcp.ts`、`src/types.ts`、`src/config.ts`、`src/tui-model.ts`。你的改动面只有 `src/tui/**` 和 `test/**`（仅新增测试文件或在你新建的文件上修改）。
3. **TuiController 禁区**：`src/tui/state.ts` 中 `TuiController` 类的所有方法签名与行为不得改变（`src/tui/state.ts` 里的 `TABS` 常量本任务**允许且必须**修改）。`phaseColor / presenceColor / themeFor / hiddenAppsUrl / visibleActionsToken / copyToHostClipboard` 保持不变。
4. **测试铁律**：每次 commit 前 `bun run test` 必须全绿（基线 98 pass / 0 fail + 你新增的测试）。既有测试因你的改动失败 → 停下修代码，**禁止修改既有测试强行通过**；若确有必要调整既有断言，必须在审查报告第 7 节显著标注理由。
5. **主题铁律**：组件禁止硬编码颜色字符串，只能用 `Theme` 的 16 个角色（见 `src/tui/theme/types.ts`）：background / panel / panelAlt / selected / selectedText / text / muted / accent / good / warn / bad / border / user / agent / tool / system。
6. **文案铁律**：界面字符串优先走 `src/tui/copy/` 模块（`copyFor(zh)` 取文案）；L1 俏皮内容（问候/空状态/状态动词）**必须**走 copy 模块，禁止散落组件里。禁止新增 emoji（用 ● ○ ⏺ ❯ ✓ ✗ 等字符图形）。
7. **布局稳定铁律**：固定宽度内容（吉祥物、凭据、URL）用 `wrapMode="none"`；对齐用 flex（`alignItems` / `justifyContent`），禁止硬编码空格对齐；会改变内容高度的动态状态必须加入 scrollbox 的 `key`（参照现有 App.tsx 的 scrollKey 模式）。
8. **性能铁律**：不新增全局高频定时器；输入框打字用组件局部 state，不得触发整树重渲染；不打乱 `TuiController.snapshot()` 的 revision 缓存机制。
9. **风格铁律**：与 M1 代码风格完全一致（见第四节）。strict TS，禁止 `any`（用 `unknown` + 收窄）；具名导出，禁止默认导出。
10. **不确定就停**：ADR 没覆盖的决策、行为歧义、需要碰禁区文件——不要猜、不要绕，停下写进审查报告「8. 阻塞与提问」，照常交付其余部分。

## 三、环境与验证命令

```bash
cd 
git branch --show-current          # 必须输出 feat/tui-claude-redesign
bunx tsc --noEmit -p tsconfig.json # typecheck，必须 0 错误
bun run test                       # build + 全部测试，必须全绿（98+新增 / 0 fail）
```

## 四、代码风格规范（与 M1 一致，先读范例再写）

**必读范例文件**（开工前通读）：
- `src/tui/theme/palette.ts` — 模块结构、文件头注释、常量组织
- `src/tui/copy/index.ts` — 纯函数风格、JSDoc 设计注释
- `src/tui/model/mascot-mood.ts` — model/ 纯函数范式
- `src/tui/components/Mascot.tsx` — 组件规范（props 解构内联类型、局部 state、wrapMode/flexShrink）
- `src/tui/hooks/useMascotMood.ts` — snapshot 选择器范式
- `test/tui-redesign.test.mjs` — 测试风格（node:test + assert/strict，从 dist/ 导入）

**风格细则**：
- 文件头：`/** 模块名 — 一句话职责（ADR-0004 决策 X）。关键设计说明 */`
- 中文注释解释"为什么"，不复述代码行为
- `import type` 导入类型；相对导入带 `.js` 后缀；具名导出
- 常量 `UPPER_SNAKE_CASE`；纯函数放 `model/`；组件只渲染 view model
- commit 信息：英文 conventional 格式 `feat(tui): ...`，正文可用中文 bullet

## 五、本任务相关 ADR-0004 决策（原文摘录）

**决策 2（主屏骨架，本任务实现其 4、5 两条）**：
> 4. **底部导航**：轻量 pill 式页签（非大标题栏），快捷键切换保留。
> 主屏 = 拟人化问候 + 会话摘要 + 活动时间线 + 底部轻量导航。视觉语言：暖色 Claude 主题（珊瑚橙 accent、暖白正文、暖黑底、圆角感）。

**决策 4（常显输入栏，本任务核心）**：
> **所有页面底部常显 ❯ 输入栏**，作为快捷键体系之外的新交互层（快捷键全部保留）：
> - **Normal / Editing 双模式状态机**：输入栏聚焦（Editing）时字符进入文本框，仅 `Esc`（退出聚焦）、`↑/↓`（历史）、`Tab`（补全）等少数键有效；失焦（Normal）时恢复全部页面快捷键。启动默认 Normal，点击或 `i`/`Enter` 进入 Editing。
> - **路由规则**：以 `/` 开头 → 命令路由（页面跳转 + 页面动作）；纯文本 → 发送消息给当前选中/最活跃 session（复用 `store.sendUserMessage`）。
> - **历史栈**：会话内内存历史（不落盘），`↑/↓` 浏览。
> - **命令体系**：命令 = 现有页面动作的别名映射，不引入新的后端能力；`Tab` 补全命令名。
> - 键盘路由优先级扩展为五层：form(400) → input-editing(350) → detail-esc(300) → page(200) → global(100)。
> - Windows 兼容模式：输入栏同样可用（键盘优先本就成立）。

**决策 7（页面清单）**：8 页：概览 / 会话 / 消息 / 时间线 / Diff / 扩展 / 设置 / 日志。时间线页本任务只做占位。

**决策 8（性能）**：渲染 profile 不动；输入栏打字组件局部 state；大列表沿用 viewportCulling + 分页；snapshot revision 缓存不动。

**决策 12（实时性，本任务实现双速 tick）**：
> **双速 tick**：App 的 1000ms interval 拆成两个——快 tick 150ms 只做 `renderRevision()` 字符串比对，变化才 `snapshot()` 重渲染；慢 tick 1s 维持 `tickReminders()` 语义不变。

**决策 9（结构，本任务相关行）**：
```
components/chrome/   TopBar · BottomNav · StatusLine（Header/TabBar/Footer 重构）
components/InputBar.tsx   常显输入栏 + Normal/Editing 状态机 + 历史栈 + / 命令路由
model/                    command-router 纯函数（可单测）
hooks/                    useInputHistory
keymap.ts                 五层优先级：form(400) → input-editing(350) → detail(300) → page(200) → global(100)
```

**附录 A.2（tui-interaction 落地）**：`/` 聚焦输入栏并预置命令前缀；`?` 打开帮助 overlay；InputBar 聚焦时 accent 边框 + ❯ 高亮，失焦 muted。

**附录 A.7（agent-cli-design 落地）**：`/help` 输出全部 / 命令与快捷键，无 pager；命令错误提示必须告诉用户下一步（如未知命令给最近似建议）。

## 六、现状关键代码（已替你定位，先读）

- `src/tui/state.ts:16` — `TABS` 常量（7 页，本任务改 8 页）
- `src/tui/App.tsx` — 组合根。注意这些 tab 索引硬编码点（改 8 页后全部要重映射）：
  - `itemCount` / `moveSelection` / `selectedTargetId` 中 `tab === 4`（扩展）
  - `tab === 6`（日志翻页、logPage 重置）
  - `[0, 5].includes(tab)`（凭据 reveal 与 configure 动作）
  - `keymap.ts` 中各页面动作（tab===1/2/3/4/5/6）
- `src/tui/keymap.ts` — 四层绑定现状
- `src/tui/components/Header.tsx` / `TabBar.tsx` / `Footer.tsx` — 将被 chrome 取代（本任务末尾删除）
- `src/tui/components/FormDialog.tsx` — 弹窗体系（400 层，不动）；其 `<input>`/`<textarea>` 用法是 InputBar 的现成参考
- `src/tui/screens/Logs.tsx` 顶部 — `runtime.store.auditFacts()` 的用法参考

## 七、逐步执行

### 第 0 步：环境检查
```bash
cd  && git branch --show-current && bun run test 2>&1 | tail -3
```
分支正确且看到 `98 pass / 0 fail` 才继续。否则停下写报告。

### 第 1 步：TABS 改 8 页 + 全量索引重映射
新顺序（决策 7）：`['Overview', 'Sessions', 'Messages', 'Timeline', 'Diff', 'Extensions', 'Settings', 'Logs']`

索引映射表（旧→新）：Sessions 1→1、Messages 2→2、**Timeline 新=3**、Diff 3→4、Extensions 4→5、Settings 5→6、Logs 6→7。

改 `src/tui/state.ts` 的 TABS。然后逐一修改 `src/tui/App.tsx`：
- `itemCount`：`tab === 4`（扩展）→ `tab === 5`
- `moveSelection` 内 `tab === 4` → `tab === 5`
- `selectedTargetId` 中 `tab === 4` → `tab === 5`
- `scrollChildIntoView` 前缀逻辑：`tab === 1` session、`tab === 2` conversation、其余 extension——确认 extension 分支对应新 `tab === 5`
- `useKeyboard` 里日志翻页 `tab === 6` → `tab === 7`
- 凭据 reveal 资格 `[0, 5].includes(tab)` → `[0, 6].includes(tab)`
- `switchTab` 中 logPage 重置 `index !== 6` → `index !== 7`
- 内容分派：`tab === 3` 渲染新的 Timeline 占位（第 6 步建组件），4→DiffScreen、5→Extensions、6→Settings、7→Logs

改 `src/tui/keymap.ts`：
- diff 刷新 `r`：`tab === 3` → `tab === 4`
- 扩展 `e`/`x`：`tab === 4` → `tab === 5`
- configure `c`：`[0, 5]` → `[0, 6]`
- settings `k`/`u`：`tab === 5` → `tab === 6`
- logs `a`：`tab === 6` → `tab === 7`
- 数字键：`Array.from({length: 7})` → `length: 8`
- **保留**选择移动（`[1, 2, 4]` 含扩展选择——新索引扩展=5，所以 `[1, 2, 4].includes(tab)` → `[1, 2, 5].includes(tab)`）

验证：`bunx tsc --noEmit -p tsconfig.json` 0 错误。

### 第 2 步：model/command-router.ts（纯函数）+ 单测
新建 `src/tui/model/command-router.ts`：

```ts
/** 类型参考（按此语义实现，命名可微调） */
export type PageActionName = 'createSession' | 'sendMessage' | 'refreshDiff';
export type CommandAction =
  | { kind: 'navigate'; tab: number }
  | { kind: 'pageAction'; action: PageActionName }
  | { kind: 'message'; body: string }
  | { kind: 'help' }
  | { kind: 'unknown'; input: string; suggestion?: string };
```

命令表（含别名，全部小写匹配）：
- `/home` `/overview` `/概览` → navigate 0；`/sessions` `/会话` → 1；`/messages` `/消息` → 2；`/timeline` `/时间线` → 3；`/diff` → 4；`/extensions` `/扩展` → 5；`/settings` `/设置` → 6；`/logs` `/日志` → 7
- `/new` → pageAction createSession；`/send` → pageAction sendMessage；`/refresh` → pageAction refreshDiff
- `/help` `/帮助` → help
- 以 `/` 开头的其他输入 → unknown，suggestion = 命令表中与输入有最长公共前缀的命令（没有则省略 suggestion）
- 非 `/` 开头 → `{ kind: 'message', body: 原文 }`

再导出 `commandCompletions(prefix: string): string[]`：返回以 prefix 开头的命令名列表（Tab 补全用），`/` 本身返回全部命令。

新建 `test/tui-redesign-m2.test.mjs`（从 `../dist/tui/model/command-router.js` 导入）：覆盖导航、别名、中文命令、pageAction、help、message、unknown+suggestion、completions 前缀过滤。**测试文件与既有风格一致**（参照 `test/tui-redesign.test.mjs`）。

验证：`bun run test` 全绿。

### 第 3 步：hooks/useInputHistory.ts
新建 `src/tui/hooks/useInputHistory.ts`。语义（s15 模式）：
- 内部：`history: string[]`、`index: number`（-1 = 未在浏览）
- `push(text)`：非空且与最后一条不同才入栈；index 复位 -1
- `prev(current)`：index===-1 → 跳到栈底返回 `history[len-1]`；否则 index-1 到 0 停住
- `next()`：index+1；越过栈顶 → index 复位 -1 返回 `''`（空白）
- React hook 形式（useState/useRef），返回 `{ push, prev, next }`

验证：typecheck 0 错误。

### 第 4 步：chrome 三件套
新建 `src/tui/components/chrome/TopBar.tsx`：
- 一行：左 `MyTerminal`（accent 加粗）+ `●` 状态点（degraded→bad，否则 good）+ 拓扑摘要（muted，复用现有 Header.tsx 的 `runtime.processTopology()` 文案逻辑，原样搬）+ 右侧 `v{版本}`（muted，`CURRENT_VERSION`）
- `pending > 0` 时下方加一行 bad 背景白字警告条（文案沿用现有 Header 的）
- props：`{ runtime, theme, pending, zh }`（与旧 Header 相同）

新建 `src/tui/components/chrome/BottomNav.tsx`：
- 一行 pill 页签：当前页 accent 背景圆角 pill（用 backgroundColor + paddingX 模拟），其余 muted 文字；点击切换（onMouseDown → onSelect(index)）
- 页签文案：zh 用 `['概览','会话','消息','时间线','Diff','扩展','设置','日志']`，en 用 TABS 原名
- props：`{ active, theme, zh, onSelect }`

新建 `src/tui/components/chrome/StatusLine.tsx`：
- 一行：左侧快捷键提示（复用现有 Footer.tsx 的 hints() 逻辑，**按新 tab 索引更新**，并追加输入栏提示：Normal 时显示 `i 输入`），右侧 notice（good 色，复用现有 notice 逻辑）
- props：`{ tab, detail, theme, zh, mouseEnabled, notice, inputEditing }`

**此时先不删旧 Header/TabBar/Footer**（第 7 步 App 切换后再删）。

验证：typecheck 0 错误。

### 第 5 步：components/InputBar.tsx
新建 `src/tui/components/InputBar.tsx`。规格：

- props：`{ theme, copy, editing, onEditingChange, onSubmitText: (text: string) => void, completions: (prefix: string) => string[] }`
- Normal（editing=false）：一行 `❯`（muted）+ placeholder（muted，copy.inputPlaceholder）+ 右侧 copy.inputHintNormal（muted）；点击 → onEditingChange(true)
- Editing：box 带 accent 边框（`border borderColor={theme.accent}`），内嵌 OpenTUI `<input>`（参考 FormDialog.tsx 的用法：ref、focused、backgroundColor/textColor/cursorColor 用 theme 角色），前缀 `❯`（accent）；右侧或下一行显示 copy.inputHintEditing（muted）
- Editing 键位（`useBindings`，**priority 350**，enabled=editing）：
  - `escape` → 清空输入 + onEditingChange(false)
  - `return`/`enter` → 取 input 值 trim，非空 → onSubmitText + 清空；**提交后保持 Editing**
  - `up` / `down` → useInputHistory 的 prev/next，返回值写入 input
  - `tab` → 当前值以 `/` 开头时：completions(当前值) 取候选循环填充（多次 Tab 轮转候选）
- `useInputHistory` 内部使用；提交时 push
- 输入值用组件局部 state + ref（参照 FormDialog 的 valueRef 模式）

验证：typecheck 0 错误。

### 第 6 步：Timeline 占位页 + HelpOverlay
新建 `src/tui/screens/Timeline.tsx`：占位内容 = Mascot（mood='happy'）+ `copy.emptyStates.timeline`（muted）+ 一行 muted 说明（zh：`完整时间线将在 M4b 到来。` en：`Full timeline arrives in M4b.`）。props：`{ theme, zh }`（zh 用于 copyFor）。

新建 `src/tui/components/HelpOverlay.tsx`：
- 绝对定位全屏半透明遮罩（参照 Modal.tsx），居中面板列出：全部 / 命令（含别名、说明）+ 全部页面快捷键（从 keymap 动作整理）+ `Esc 关闭`
- 自身 useBindings priority 300：`escape` → onClose
- props：`{ theme, zh, width, height, onClose }`

验证：typecheck 0 错误。

### 第 7 步：App.tsx 组装 + keymap 五层 + 双速 tick
1. **布局重排**（自上而下）：TopBar → BottomNav → 分隔线（保留现有）→ scrollbox 内容 → InputBar → StatusLine。FormDialog 仍在最外层覆盖。
2. **InputBar 接线**：App 持有 `inputEditing` state。`onSubmitText` → `routeCommand(text)`（第 2 步）分发：
   - navigate → switchTab(tab)
   - pageAction → 对应现有动作（createSessionAction / sendMessageAction / refreshDiffAction）
   - message → 调 `controller.runtime.store.sendUserMessage(targetId, body)`；targetId = 最近活跃 claimed 非终态 session（按 updatedAt 降序第一个）；没有 → showNotice（zh：`没有可接收消息的 session。先在会话页创建一个。` en：`No session can receive messages. Create one on the Sessions page.`）
   - help → 打开 HelpOverlay（新 state showHelp）
   - unknown → showNotice（zh：`未知命令 ${input}${suggestion ? `，是指 ${suggestion} 吗？` : '。输入 /help 看全部命令。'}` en 对应）
   - message 成功后 showNotice（zh：`已发给 ${sessionName}` en：`Sent to ${sessionName}`）
3. **keymap.ts 五层**：给 `useAppKeymap` 的 Actions 增加 `inputEditing: boolean`。page 层 enabled 加 `!inputEditing`；global 层 enabled 加 `!inputEditing`；global 层新增绑定：`i` → 进入 Editing、`/` → 进入 Editing 并预置 `/`（通过 App 传入的回调）、`?` → 打开 HelpOverlay。
4. **双速 tick**（决策 12）：替换现有 1000ms interval 为两个：
   ```ts
   // 快 tick：150ms，只做 revision 比对
   useEffect(() => {
     let rendered = controller.renderRevision();
     const timer = setInterval(() => {
       const next = controller.renderRevision();
       if (next !== rendered) { rendered = next; refresh(); }
     }, 150);
     return () => clearInterval(timer);
   }, [controller, refresh]);
   // 慢 tick：1s，reminders 语义不变
   useEffect(() => {
     const timer = setInterval(() => { controller.tickReminders(); }, 1000);
     return () => clearInterval(timer);
   }, [controller]);
   ```
5. **删除旧组件**：App 不再引用后，删除 `src/tui/components/Header.tsx`、`TabBar.tsx`、`Footer.tsx`。
6. scrollKey、copySelection、revealCredentials、FormDialog、FatalErrorBoundary 逻辑保持原样。

验证：`bunx tsc --noEmit` 0 错误 → `bun run test` 全绿。

### 第 8 步：commit（分 2-3 个，信息规范）
建议：
- `feat(tui): M2 skeleton — 8-page routing, chrome trio, keymap five layers`
- `feat(tui): M2 InputBar with command router, history, completion`
- `feat(tui): M2 dual-speed tick (150ms revision / 1s reminders)`

每个 commit 前 `bun run test` 全绿。

## 八、验收清单（审查报告第 6 节逐项 ✓/✗）

1. TABS = 8 页，数字键 1-8 全部可切换，Timeline 占位页显示 Mascot + 空状态文案
2. 顶部 TopBar（含 pending 警告条逻辑）、底部 BottomNav pill、StatusLine 提示行渲染正确；旧 Header/TabBar/Footer 已删除
3. 输入栏全页常显；Normal 按 `i` 或 `/` 进入 Editing；Editing 时 j/k/q/数字键**不触发**页面动作（五层隔离生效）；Esc 回 Normal
4. `/sessions` `/logs` `/概览` 等命令跳转正确；`/new` `/send` 触发对应表单；`/help` 与 `?` 打开帮助 overlay；未知命令给建议；纯文本发送到最近活跃 claimed session（无 session 时给 notice）
5. ↑↓ 历史（翻过头回空白）；Tab 补全命令；提交后保持 Editing
6. 快 tick 150ms 生效（可用秒表观察 running 审计出现延迟 ≤ 0.5s 或代码审查确认两个 interval）
7. 既有行为无损：凭据 reveal（Overview tab 0 与 Settings tab 6）、日志翻页（tab 7）、FormDialog、复制选区、q 退出
8. `bun run test` 全绿（98 + 新增命令路由测试 / 0 fail）

## 九、审查报告（必须原样填写，保存为 `deliverables/tui-redesign-handoff/review-M2.md`）

```markdown
# 审查报告：M2 骨架
- 日期：
- 执行者：（模型名）
- 分支：（git branch --show-current 输出）

## 1. 执行摘要（≤10 行）

## 2. 改动清单
- commit 列表（git log --oneline 本任务范围）：
- git diff --stat 汇总：

## 3. 验证结果（原文粘贴）
- bunx tsc --noEmit 输出：
- bun run test 末尾 15 行：

## 4. 硬规则自查（逐条 ✓/✗ + 证据）
1. 分支铁律：
2. 核心禁区：（说明 git diff --name-only 中无禁区文件）
3. TuiController 禁区：
4. 测试铁律：
5. 主题铁律：（grep 新代码无 # 开头色值）
6. 文案铁律：
7. 布局稳定铁律：
8. 性能铁律：
9. 风格铁律：
10. 不确定就停：

## 5. ADR 符合性自查
- 决策 4 输入栏（双模式/路由/历史/五层）：
- 决策 7 八页：
- 决策 12 双速 tick：
- A.2 / ? 键：

## 6. 功能自查清单（第八节 1-8 逐项）

## 7. 偏差记录（无则写"无偏差"）

## 8. 阻塞与提问（无则写"无"）

## 9. 风险与遗留（下一任务 M3 要注意什么）

## 10. 请审查者重点看（1-3 处）
```

## 十、交接给 M3 的信息

- Timeline 页是占位（M4b 填充）；Home/Overview 页内容还是旧的（M3 重做）
- InputBar 的 message 目标是"最近活跃 claimed session"，M3 会在 Home 页显示它
- HelpOverlay 的命令表与 command-router 的命令表是两处维护（M3 后注意同步，M6 验收会查）
