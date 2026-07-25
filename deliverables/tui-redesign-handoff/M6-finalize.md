# 任务 M6：收尾 — docs SVG 重生成 + 全量验收 + ADR 定稿

> 你是执行本任务的弱模型，全新上下文。本文档自包含：先读两遍，再动手。
> 前置：M2-M5 全部交付。缺任一 review 文件就停下说明。
> 交付物 = 代码/文档 commit + 填写文末《审查报告》保存为 `deliverables/tui-redesign-handoff/review-M6.md`。

## 一、你的处境

MyTerminal 是「ChatGPT/Claude 网页端 ↔ 本地电脑」的桥接服务（Bun + TypeScript + OpenTUI + React 19）。TUI 按 ADR-0004 重做，M1-M5 已把全部 8 页 + Setup + 错误页重做为 Claude Code 风格。

你的任务：收尾——把 `docs/assets/tui/` 的界面设计图（6 张 SVG）重画为新设计，执行全量验收清单，把 ADR-0004 定稿。**这是最后一道工序，验收不过就修到过。**

## 二、硬规则（违反任何一条 = 任务失败）

1. **分支铁律**：只在 `feat/tui-claude-redesign`。禁止 checkout/merge/push/rebase/reset/force。
2. **核心禁区**：绝不修改 `src/store.ts`、`src/extensions.ts`、`src/core-tools.ts`、`src/server.ts`、`src/mcp.ts`、`src/types.ts`、`src/config.ts`、`src/tui-model.ts`。本任务改动面：`docs/**`（SVG + ADR）、`src/tui/**`（仅修复验收发现的问题）、`test/**`。
3. **验收铁律**：`bun run test` 全绿 + `bunx tsc --noEmit` 0 错误是硬门槛，一项不过不交付。
4. **SVG 铁律**：6 张 SVG 文件名/路径不变（README/docs 引用它们，`docs.test.mjs` 会查链接）；内容是手工编写的文本网格渲染（参照现有 SVG 的写法：`<rect>` 底 + 等宽字体 `<text>` 网格），不是截图。新画必须反映 M2-M5 后的真实界面（8 页结构、暖色主题、底部输入栏）。
5. **ADR 铁律**：只准"定稿"（补里程碑完成记录、状态更新），不准改决策内容。发现决策与现实不符 → 写进审查报告，不擅自改。
6. **诚实铁律**：无法在本环境验证的项（真实 TUI 交互、Windows 兼容模式）必须标注 `REQUIRES-HUMAN`，禁止编造"已验证"。
7. **主题/文案/布局/性能/风格铁律**：同前序任务（如需修代码时适用）。
8. **不确定就停**：写进「8. 阻塞与提问」。

## 三、环境与验证

```bash
cd 
git branch --show-current
bunx tsc --noEmit -p tsconfig.json
bun run test
head -20 docs/assets/tui/overview-en.svg   # 看现有 SVG 的文本网格写法
```

## 四、本任务相关 ADR-0004 决策（原文摘录）

**决策 10（测试与验收标准，本任务全部）**：
> - **硬门槛**：现有测试全绿 + `typecheck` + `build` 通过
> - **新增单测**：`model/` 纯函数（已由 M1-M5 陆续补齐）
> - **文档图**：`docs/assets/tui/` 的 6 张 SVG 按新设计重新生成（中英 × 概览/会话/设置），docs.test.mjs 引用断言保持通过
> - **手测清单**：8 页 × 双主题 × 双语 + 输入栏（命令/消息/历史/补全/Esc）+ 吉祥物表情与眨眼 + 凭据 fail-closed + Windows profile（无法本地验证的项明确标记）

**决策 11（里程碑）**：M6 = docs SVG 重新生成 + 新单测 + 全量验收（基线 + 新增全绿）+ ADR 定稿。

## 五、逐步执行

### 第 0 步：环境检查 + 读全部前置审查报告
```bash
git branch --show-current && ls deliverables/tui-redesign-handoff/review-M*.md && bun run test 2>&1 | tail -3
```
逐份读 review-M2 ~ review-M5，把它们的「9. 风险与遗留」汇总进你的验收范围。

### 第 1 步：收集新界面事实
读这些文件拿到最终视觉事实（画 SVG 的依据）：
- `src/tui/theme/palette.ts`（暖色 hex 值）
- `src/tui/components/chrome/TopBar.tsx`、`BottomNav.tsx`、`StatusLine.tsx`
- `src/tui/components/InputBar.tsx`
- `src/tui/screens/Home.tsx`、`Sessions.tsx`（M4a）、`Settings.tsx`（M5）
- `src/tui/state.ts` 的 TABS（8 页顺序）

### 第 2 步：重画 6 张 SVG
文件（**名字不变，内容全换**）：
- `docs/assets/tui/overview-en.svg` / `overview-zh-CN.svg` → 新 Home 主屏（Mascot 问候 + 会话摘要 + 动态区 + BottomNav + InputBar + StatusLine）
- `docs/assets/tui/sessions-en.svg` / `sessions-zh-CN.svg` → 新会话页卡片树（暖色、树形缩进、相位色点）
- `docs/assets/tui/settings-en.svg` / `settings-zh-CN.svg` → 新设置页三组卡片（凭据掩码行 wrapMode 一行显示）

写法：参照现有 SVG 的文本网格法（背景 rect 圆角 + 每行 `<rect>` 底色块 + `<text>` 等宽字符）。用 palette.ts 的真实 hex（dark 主题画，与旧图一致都是深色底）。尺寸参照现有（约 1228×748 或按内容调整）。
完成后跑 `bun run test` 确认 docs.test.mjs 仍绿。

### 第 3 步：全量验收清单（逐项执行，结果填审查报告第 6 节）

**A. 自动化硬门槛**
1. `bunx tsc --noEmit -p tsconfig.json` → 0 错误
2. `bun run test` → 全绿，记录 pass/fail 数与测试文件数
3. `git diff --name-only main...HEAD` → 确认无禁区文件（store/extensions/core-tools/server/mcp/types/config/tui-model）

**B. 代码审查级核对（读代码确认，不要求真机）**
4. 8 页 TABS 顺序正确；数字键 1-8 绑定存在（keymap.ts）
5. InputBar：Normal/Editing 双模式、350 优先级层、Esc/Enter/↑↓/Tab 绑定存在
6. 双速 tick：App.tsx 存在 150ms 与 1000ms 两个 interval
7. Mascot：5 种 mood 帧、眨眼定时器、`animated` Windows 降级默认
8. 凭据 fail-closed：Settings 凭据行 wrapMode="none"；App 的 reveal 逻辑（450ms deadline、导航隐藏）未被改动（与 main 分支 diff 为空或仅排版）
9. 时间线归并 memoize；Logs 页 ToolCallRow + 分页/开关/聚合/累积上下文保留
10. copy 模块：L1 文案集中；新页面无散落 L1 字符串（grep 抽查）
11. 无硬编码颜色（`grep -rn "#[0-9A-Fa-f]\{6\}" src/tui --include=*.tsx | grep -v theme/palette` 应只剩注释或白名单）
12. HelpOverlay 命令表与 command-router 命令表一致（M2 遗留的联动检查点）

**C. 运行冒烟（不需要交互）**
13. `bun run build && timeout 8 bun run start -- --headless` → 打印 JSON ready 块后超时退出码 124，无崩溃输出（headless 依赖本机已有配置；若报配置缺失，标注 REQUIRES-HUMAN 跳过）

**D. 人工项（标注 REQUIRES-HUMAN）**
14. 8 页 × 双主题 × 双语的真实渲染核对
15. 输入栏实际击键（命令/消息/历史/补全/Esc）
16. Mascot 眨眼动画肉眼确认
17. Windows 兼容模式（20fps/键盘-only）

### 第 4 步：ADR-0004 定稿
- 把决策 11 的 M2-M6 各行补上完成标记（✅ + 日期 + commit hash + 测试数），与 M1 行格式一致
- 文档状态行从「实施中」改为「实施完成，待主理人终审」
- **不改任何决策内容**

### 第 5 步：commit
- `docs(tui): M6 — regenerate TUI SVGs for new design`
- `docs: ADR-0004 finalize milestones M2-M6`
- 如需修代码：`fix(tui): M6 acceptance fixes — <具体>`

## 六、验收清单（审查报告第 6 节逐项填：✓ / ✗ / REQUIRES-HUMAN）

（= 第五节第 3 步 A-D 全部 17 项，逐项执行并记录证据）

## 七、审查报告（原样填写，保存为 `deliverables/tui-redesign-handoff/review-M6.md`）

```markdown
# 审查报告：M6 收尾验收
- 日期：  - 执行者：  - 分支：

## 1. 执行摘要（≤10 行：全量验收结论一句话 + SVG + ADR 状态）
## 2. 改动清单（commit 列表 + git diff --stat）
## 3. 验证结果（tsc + bun run test 末尾 15 行原文 + headless 冒烟输出）
## 4. 硬规则自查（8 条逐条 ✓/✗ + 证据）
## 5. ADR 符合性自查（决策 10 四条 / 决策 11 M6 行）
## 6. 全量验收清单（第 3 步 17 项逐项：✓/✗/REQUIRES-HUMAN + 证据）
## 7. 前置任务遗留汇总处理（M2-M5 各自第 9 节的处置结果）
## 8. 阻塞与提问
## 9. 风险与遗留（终审者需要知道的一切）
## 10. 请审查者重点看（1-3 处）
```

## 八、交接给主理人终审的信息

- 本任务完成后，分支应处于「全部里程碑完成、测试全绿、文档定稿」状态
- 主理人终审依据：6 份 review + `git log main...HEAD` + 全量测试
