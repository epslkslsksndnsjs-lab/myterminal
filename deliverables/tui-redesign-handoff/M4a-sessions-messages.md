# 任务 M4a：会话页（卡片树 + 事件流详情）+ 消息页（气泡对话）

> 你是执行本任务的弱模型，全新上下文。本文档自包含：先读两遍，再动手。
> 前置：M2、M3 已交付。若 `review-M2.md` / `review-M3.md` 不存在，停下并说明。
> 交付物 = 代码 commit + 填写文末《审查报告》保存为 `deliverables/tui-redesign-handoff/review-M4a.md`。

## 一、你的处境

MyTerminal 是「ChatGPT/Claude 网页端 ↔ 本地电脑」的桥接服务（Bun + TypeScript + OpenTUI + React 19）。TUI 按 ADR-0004 重做为 Claude Code 风格。M1 地基、M2 骨架（8 页 + InputBar）、M3 主屏已完成。

你的任务：重做 **tab 1 会话页**（卡片树视觉升级 + 详情页从 JSON 裸输出改为事件流）和 **tab 2 消息页**（气泡对话流）。这两页是"对话感"的主战场。

## 二、硬规则（违反任何一条 = 任务失败）

1. **分支铁律**：只在 `feat/tui-claude-redesign`（开工 `git branch --show-current` 确认）。禁止 checkout/merge/push/rebase/reset/force。
2. **核心禁区**：绝不修改 `src/store.ts`、`src/extensions.ts`、`src/core-tools.ts`、`src/server.ts`、`src/mcp.ts`、`src/types.ts`、`src/config.ts`、`src/tui-model.ts`。改动面只有 `src/tui/**` 和 `test/**`。
3. **TuiController 禁区**：`state.ts` 的 `TuiController` 类方法、`phaseColor/presenceColor` 不得改变。
4. **测试铁律**：commit 前 `bun run test` 全绿。禁止改既有测试强行通过。
5. **主题铁律**：只用 Theme 16 角色，禁止硬编码颜色。对话角色色：user（用户）/ agent（AI session）/ tool（工具）/ system（系统）。
6. **文案铁律**：L1 走 copy 模块；禁止新增 emoji。
7. **布局稳定铁律**：固定宽度 `wrapMode="none"`；flex 对齐；动态高度状态入 scrollbox key（会话/对话详情已含在 App 的 scrollKey 模式里，保持）。
8. **性能铁律**：不新增全局定时器；历史条目渲染有界（沿用 `historiesForTui` 的截尾，不扩量）。
9. **风格铁律**：与 M1-M3 一致（文件头注释、import type、.js 后缀、具名导出、strict 无 any）。
10. **不确定就停**：写进「8. 阻塞与提问」。

## 三、环境与验证

```bash
cd 
git branch --show-current
bunx tsc --noEmit -p tsconfig.json
bun run test
```

## 四、代码风格范例（先读）

`src/tui/components/Mascot.tsx`、`src/tui/screens/Home.tsx`（M3，页面结构范本）、`src/tui/model/timeline-merge.ts`（M3）、`src/tui/copy/index.ts`。

## 五、本任务相关 ADR-0004 决策（原文摘录）

**决策 7（本任务两行）**：
> | 会话 Sessions | Claude 化卡片树；详情页改为事件流式历史（带类型语义渲染，不再 `JSON.stringify` 裸输出） |
> | 消息 Messages | 气泡对话流（来源色区分 + 圆角气泡），俏皮空状态；Enter 进二人对话保持气泡 |

**决策 6（文案）**：空状态走 copy（`copy.emptyStates.sessions` / `copy.emptyStates.messages` 已存在）。

**附录 A.4（s14 类型→渲染器分发）**：每种条目类型独立渲染组件——历史条目按 type 分发、消息按来源分发。

## 六、现状关键代码（已替你定位）

- `src/tui/screens/Sessions.tsx` — 旧会话页 + `SessionDetail`（详情里 `JSON.stringify(item.entry.data, null, 2)` 是要消灭的裸输出）
- `src/tui/screens/Messages.tsx` — 旧消息页 + `ConversationDetail`（已有左侧色条气泡雏形）
- `src/tui/screens/shared.tsx` — `Heading / Line / SessionStatus` 小组件（可改可留）
- `src/tui-model.ts` — `logicalSessionGroups` / `conversationGroups`（禁改，直接用）
- `runtime.store.historiesForTui(ids)` / `historyCount(id)` — 详情页历史数据源（Sessions.tsx 已在用）
- 历史条目形状：`{ sessionId, sessionName, entry: { at: string, type: string, data: unknown } }`。**注意**：entry.type 的取值集合你需要先在运行数据里确认（见第 1 步），已知的至少有 checkpoint、message、event、audit、task 类。

## 七、逐步执行

### 第 0 步：环境检查 + 读 M2/M3 审查报告
```bash
git branch --show-current && ls deliverables/tui-redesign-handoff/review-M2.md deliverables/tui-redesign-handoff/review-M3.md && bun run test 2>&1 | tail -3
```

### 第 1 步：侦察历史条目类型
```bash
ls ~/.config/myterminal/workspaces/*/history/ 2>/dev/null | head; find ~/.config/myterminal -name "*.jsonl" -path "*history*" | head -3 | xargs -I{} sh -c 'echo "== {}"; head -5 {}'
```
（路径若不同，用 `grep -r "history" src/store.ts | grep -i dir` 定位。）把实际出现的 `type` 值记进审查报告附录。**类型集合以实测为准**，第 2 步的渲染分发必须覆盖实测类型 + fallback。

### 第 2 步：model/history-entry.ts（纯函数 + 单测）
新建 `src/tui/model/history-entry.ts`：
```ts
export type HistoryEntryView = {
  type: string;          // 原类型
  icon: string;          // 单字符图形（如 ◆ ✉ ⚙ ⏺ ▸，禁止 emoji）
  tone: 'accent' | 'good' | 'warn' | 'bad' | 'muted';  // 映射到 theme 角色的键
  title: string;         // 一行语义摘要（从 data 提取，如 checkpoint.summary / message.body 截断 / audit.action）
  detail?: string;       // 次要信息（可选，截断 120 字符）
};
export function viewForHistoryEntry(entry: { at: string; type: string; data: unknown }, zh: boolean): HistoryEntryView
```
- 按第 1 步实测类型做映射；未知类型 fallback：icon `▸`、tone muted、title = type、detail = `JSON.stringify(data)` 截断 120 字符
- **禁止完整 JSON 裸输出**——这是本任务的核心要求
- data 取值要防御式（`typeof`/`in` 收窄，禁止 any 强转）
- 测试：`test/tui-redesign-m4a.test.mjs`，覆盖每个实测类型 + unknown fallback + 超长截断

### 第 3 步：components/MessageBubble.tsx
新建 `src/tui/components/MessageBubble.tsx`：
```tsx
export function MessageBubble({ fromName, fromId, body, createdAt, readAt, selfSide, theme, zh }: {
  fromName: string; fromId: string; body: string; createdAt: string; readAt?: string;
  selfSide: 'user' | 'agent';   // user=用户(TUI owner)，agent=其他 session
  theme: Theme; zh: boolean;
})
```
- user：左侧 `▍` 或 borderLeft 用 `theme.user`，头部 `你`/fromName（user 色加粗）+ 时间 muted + `已读`/`read`（muted）
- agent：同构，色用 `theme.agent`
- body：`wrapMode="word"`，text 色；背景 `theme.panel`
- 时间格式用 M3 的 `timeOf` 方式（HH:MM:SS）或相对时间（`model/relative-time.ts`）

### 第 4 步：screens/Messages.tsx 重做
- 列表页（对话卡片）：保留 conversationGroups 结构，视觉升级——卡片内：对方名（text 加粗）+ 消息数（accent）+ 最后一条预览（muted 截断）；选中态 `theme.selected/selectedText`；空状态用 `copy.emptyStates.messages`（替换现有字符串）
- `ConversationDetail`：全部消息改 MessageBubble 渲染（fromId==='user' → selfSide user，否则 agent）；保留 stickyScroll（App.tsx 已对 conversation detail 开启）
- `zh` prop 已有；新增 `copy` prop（App 传 `copyFor(zh)`）

### 第 5 步：screens/Sessions.tsx 重做
- 列表页（卡片树）：保留 logicalSessionGroups 树形结构与 `u`/`n` 操作提示行（文案微调走 copy 或保留），视觉升级：
  - 卡片选中态：accent 边框 + selected 背景（现有），标题行 `●`（accent）+ 组名加粗 + 右侧 SessionStatus
  - 树形行：`├─`/`└─` 保留；checkpoint 摘要行 muted；无摘要显示 copy 短句
  - 空状态用 `copy.emptyStates.sessions`
- `SessionDetail` 事件流化（**本任务重点**）：
  - 顶部信息区保留（组名/id/数量统计），会话卡片保留但精简
  - 历史区：用 `viewForHistoryEntry` 渲染每条：行 = icon（tone→theme 色）+ 时间 muted + type（accent）+ title（text）；有 detail 时第二行 muted 缩进显示
  - 保留"显示最近 N / 总数"提示行
- props 增加 `copy`

### 第 6 步：App.tsx 传参更新
- Sessions/Messages 组件新增 `copy={copyFor(zh)}` prop；SessionDetail/ConversationDetail 同样
- 其余不动

### 第 7 步：验证 + commit
```bash
bunx tsc --noEmit -p tsconfig.json && bun run test
```
全绿后 commit：
- `feat(tui): M4a Sessions + Messages — card tree restyle, event-stream detail, message bubbles`

## 八、验收清单（审查报告第 6 节逐项 ✓/✗）

1. 会话页卡片树在新暖色主题下渲染正确，树形缩进、相位色点、空状态 copy 生效
2. 会话详情页历史区**无任何完整 JSON 裸输出**（人工抽查 3 种类型条目 + unknown 类型 fallback 单测）
3. 消息页对话卡片与二人对话全部为 MessageBubble 气泡：user/agent 来源色区分、时间、已读标记、body 自动换行
4. Enter 进出详情、Esc 返回、stickyScroll 对话置底等既有交互无损
5. 双语切换后新文案跟随（空状态/气泡头部/相对时间）
6. `bun run test` 全绿（含 m4a 新测试）

## 九、审查报告（原样填写，保存为 `deliverables/tui-redesign-handoff/review-M4a.md`）

```markdown
# 审查报告：M4a 会话页+消息页
- 日期：  - 执行者：  - 分支：

## 1. 执行摘要（≤10 行）
## 2. 改动清单（commit 列表 + git diff --stat）
## 3. 验证结果（tsc + bun run test 末尾 15 行原文）
## 4. 硬规则自查（10 条逐条 ✓/✗ + 证据）
## 5. ADR 符合性自查（决策 7 两行 / A.4 类型分发 / 决策 6 空状态）
## 6. 功能自查清单（第八节 1-6 逐项）
## 7. 偏差记录
## 8. 阻塞与提问
## 9. 风险与遗留（给 M4b 的提醒）
## 10. 请审查者重点看（1-3 处）
## 附录：实测历史条目 type 集合（第 1 步输出）
```

## 十、交接给 M4b 的信息

- `model/history-entry.ts` 的 fallback 哲学（摘要 + 截断，不裸输出）同样适用于 M4b 的 ToolCallRow args/result 预览
- MessageBubble 只服务消息；M4b 的工具调用行用独立 ToolCallRow，不要复用 MessageBubble
- 实测历史 type 集合在审查报告附录，M4b 可引用
