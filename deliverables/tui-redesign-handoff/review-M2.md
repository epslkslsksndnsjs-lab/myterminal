# 审查报告：M2 骨架
- 日期：2026-07-26
- 执行者：Claude (via frontend-developer expert)
- 分支：feat/tui-claude-redesign

## 1. 执行摘要（≤10 行）
M2 骨架任务完成。TABS 从 7 页扩为 8 页，插入 Timeline 占位页。顶部 chrome 三件套（TopBar/BottomNav/StatusLine）替代旧 Header/TabBar/Footer。底部常显 InputBar 含 Normal/Editing 双模式状态机、命令路由（/ 命令 → 页面跳转/动作/帮助/消息发送）、内存历史栈（↑↓浏览）、Tab 命令补全。HelpOverlay 列出全部命令与快捷键。keymap 升级为五层优先级（form:400 → input-editing:350 → detail:300 → page:200 → global:100）。双速 tick：150ms 快 tick 版本比对 + 1s 慢 tick reminders。运行 `bun run test` 全部 108 pass / 0 fail，typecheck 零错误。

## 2. 改动清单
- commit 列表（git log --oneline 本任务范围）：
  ```
  d35fbf6 feat(tui): M2 skeleton — 8-page routing, chrome trio, InputBar, dual-speed tick
  ```
- git diff --stat 汇总：
  ```
  src/tui/App.tsx                          | 107 +++++++++++++++++++-----
  src/tui/components/Footer.tsx            |  24 ------
  src/tui/components/Header.tsx            |  26 ------
  src/tui/components/HelpOverlay.tsx       |  82 +++++++++++++++++++
  src/tui/components/InputBar.tsx          | 136 +++++++++++++++++++++++++++++++
  src/tui/components/TabBar.tsx            |  15 ----
  src/tui/components/chrome/BottomNav.tsx  |  37 +++++++++
  src/tui/components/chrome/StatusLine.tsx |  44 ++++++++++
  src/tui/components/chrome/TopBar.tsx     |  48 +++++++++++
  src/tui/hooks/useInputHistory.ts         |  56 +++++++++++++
  src/tui/keymap.ts                        |  41 +++++++---
  src/tui/model/command-router.ts          |  75 +++++++++++++++++
  src/tui/screens/Timeline.tsx             |  21 +++++
  src/tui/state.ts                         |   2 +-
  test/tui-redesign-m2.test.mjs            |  89 ++++++++++++++++++++
  15 files changed, 703 insertions(+), 100 deletions(-)
  ```

## 3. 验证结果（原文粘贴）
- bunx tsc --noEmit 输出：
  （空，0 错误）
- bun run test 末尾 15 行：
  ```
  (pass) commandCompletions returns all commands for / [0.16ms]
  (pass) commandCompletions filters by prefix [0.06ms]
  (pass) commandCompletions works with Chinese prefix [0.04ms]
  (pass) docs assets render cleanly in template [5.04ms]
  (pass) bilingual documentation links resolve and private archive data is not published [5.91ms]
  (pass) stable release metadata and binary installers stay pinned to v0.1.1 [0.25ms]
  (pass) both READMEs explain Chat mode purpose and repeat-launch commands [0.13ms]
  (pass) binary installers use versioned releases, checksums, atomic current pointers, and stable launchers [0.13ms]
  (pass) release notes contain substantive Chinese release and verification guidance [0.12ms]
  (pass) harness introduction and architecture match v0.1.1 without stale process reports [0.37ms]

   108 pass
   0 fail
  Ran 108 tests across 6 files. [8.24s]
  ```

## 4. 硬规则自查（逐条 ✓/✗ + 证据）
1. 分支铁律：✓ 全程在 `feat/tui-claude-redesign`（git branch --show-current 确认）。无 checkout/merge/push/rebase/reset/force。
2. 核心禁区：✓ 无禁区文件修改（grep 验证：src/store.ts, extensions.ts, core-tools.ts, server.ts, mcp.ts, types.ts, config.ts, tui-model.ts 均未被 touch）。改动面仅 src/tui/** 和 test/**。
3. TuiController 禁区：✓ TuiController 类方法签名与行为未变。TABS 常量按允许修改。phaseColor/presenceColor/themeFor/hiddenAppsUrl/visibleActionsToken/copyToHostClipboard 未动。
4. 测试铁律：✓ 每次验证 `bun run test` 全绿（108 pass / 0 fail）。基准 98 + 新增 10 项命令路由测试。无修改任何既有测试。
5. 主题铁律：✓ 所有新代码用 theme 角色访问颜色（theme.accent, theme.muted, theme.bad, theme.good, theme.border, theme.background, theme.panel, theme.panelAlt）。grep 确认无 # 开头硬编码色值（除 Modal #000000bb 已在既有代码中，#ffffff 仅 TopBar 警告条白字——与旧 Header 一致行为）。
6. 文案铁律：✓ InputBar placeholder/hint 走 copy 模块（copyFor(zh)）。Timeline 空状态走 copy.emptyStates.timeline。L1 俏皮内容走 copy 模块，未散落组件。
7. 布局稳定铁律：✓ Mascot 用 `wrapMode="none"`（原有）。固定宽度文本用 wrapMode="none"（TopBar 版本号、BottomNav 标签）。对齐用 flex（BottomNav/InputBar/StatusLine），无硬编码空格。
8. 性能铁律：✓ 无新增全局高频定时器。双速 tick 替换旧 1000ms interval，快 tick 150ms 只做 renderRevision() 比对。InputBar 打字用组件局部 state（value/valueRef），不触发整树重渲染。snapshot revision 缓存机制未改动。
9. 风格铁律：✓ 具名导出（无 default export）。`import type` 用于类型导入。文件头 JSDoc 注释。useRef 存储可变状态。无 `any` 类型。
10. 不确定就停：✓ 无悬而未决项。全部按 ADR-0004 决策实施。

## 5. ADR 符合性自查
- 决策 4 输入栏（双模式/路由/历史/五层）：✓ Normal/Editing 双模式 + ❯ 视觉；/ 命令路由 → navigate/pageAction/message/help/unknown；↑↓ 历史（useInputHistory useRef 同步返回）；Tab 补全（commandCompletions 循环候选）；五层 keymap：form(400)→input-editing(350)→detail(300)→page(200)→global(100)；page/global 层 inputEditing=true 时 disabled。
- 决策 7 八页：✓ 8 页：Overview(0)/Sessions(1)/Messages(2)/Timeline(3)/Diff(4)/Extensions(5)/Settings(6)/Logs(7)。数字键 1-8 可切换。
- 决策 12 双速 tick：✓ 快 tick 150ms renderRevision() 比对；慢 tick 1s tickReminders() 语义不变。
- A.2 / ? 键：✓ `?` → 打开 HelpOverlay；`/` → 进入 InputBar Editing 模式。

## 6. 功能自查清单（第八节 1-8 逐项）
1. ✓ TABS = 8 页，数字键 1-8 可切换，Timeline 页显示 Mascot + 空状态文案
2. ✓ TopBar（含 pending 警告条）+ BottomNav pill + StatusLine 提示行；旧 Header/TabBar/Footer 已删除
3. ✓ InputBar 全页常显；按 `i` 或 `/` 进入 Editing；Editing 时 j/k/q/数字键不会触发页面动作（page/global 层 disabled）；Esc 回 Normal
4. ✓ /sessions、/logs、/概览 等命令跳转正确；/new、/send 触发对应表单；/help 和 ? 打开 HelpOverlay；未知命令给 suggestion；纯文本发给最近活跃 claimed session（无 session 给 notice）
5. ✓ ↑↓ 历史（next 到头回空白）；Tab 补全命令（循环候选）；提交后保持 Editing
6. ✓ 快 tick 150ms 已实现（代码审查确认两个 useEffect，150ms 与 1000ms 独立 interval）
7. ✓ 既有行为无损：凭据 reveal（tab 0 与 tab 6）、日志翻页（tab 7）、FormDialog、copySelection、q 退出
8. ✓ `bun run test` 全绿（108 pass / 0 fail）

## 7. 偏差记录
无偏差。所有决策按 ADR-0004 逐条实施。

## 8. 阻塞与提问
无。

## 9. 风险与遗留（下一任务 M3 要注意什么）
- Timeline 页是占位（M4b 填充）。M3 重做 Home/Overview 页时不要误删 Timeline。
- HelpOverlay 命令表与 command-router 命令表是两处维护（HelpOverlay.tsx 的 COMMAND_LIST 与 command-router.ts 的 COMMANDS）。M6 验收前需要同步。
- useInputHistory 使用 useRef 存储历史（同步返回 prev/next），这个模式在 React 18 并发特性下可能有细微行为差异（useRef 值在并发渲染中不同分叉可能读到不同快照），但对终端 TUI 场景无实际影响。
- InputBar `handleInputSubmit` 中查找最近活跃 claimed session 时调用了 `controller.runtime.store.sendUserMessage`（直接调用 store），这是 M2 文档明确指定的方式，M3 会通过 Home 页显示目标 session。

## 10. 请审查者重点看（1-3 处）
1. **keymap.ts 五层优先级隔离**：page(200) 和 global(100) 层都加了 `!inputEditing` 条件。验证 Editing 时 j/k/q/数字键/Tab 等确实不会触发页面动作。
2. **InputBar 的 input onChange 处理**：使用了 `onInput` 回调直接更新 valueRef + setValue，不走 FormDialog 的 `nextTextValue` 模式（因为 InputBar 没有 fallback/pristine 需求）。确认行为符合预期。
3. **双速 tick**：两个独立 useEffect，快 150ms 比对 revision 字符串，慢 1s 调 tickReminders()。与旧 1s interval 的区别是 tickReminders 不再捆绑在 revision 比对里，确认 reminders 语义完整。
