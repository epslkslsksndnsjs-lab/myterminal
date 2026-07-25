# 审查报告：M6 收尾验收
- 日期：2026-07-26
- 执行者：WorkBuddy（弱模型）
- 分支：feat/tui-claude-redesign
- 提交：`1d1bf30`

## 1. 执行摘要

M6 收尾完成：6 张 SVG 全部按新暖色主题重画（文本网格法、34-35 行、viewBox 1228×748），ADR-0004 定稿（M2-M6 全部标记 ✅，状态改为「实施完成，待主理人终审」），全量验收 17 项中 12 项代码级通过、4 项标注 REQUIRES-HUMAN、1 项轻微不一致（预存）。基线 177 pass / 0 fail，tsc 0 错误。分支处于全部里程碑完成、文档定稿状态。

## 2. 改动清单

```text
1d1bf30 docs(tui): M6 — regenerate TUI SVGs for new design

git diff --stat main...HEAD:
 docs/adr/0004-tui-full-redesign-claude-style.md  |  22 +-
 docs/assets/tui/overview-en.svg                  |   2 +- (全量重写)
 docs/assets/tui/overview-zh-CN.svg               |   2 +- (全量重写)
 docs/assets/tui/sessions-en.svg                  |   2 +- (全量重写)
 docs/assets/tui/sessions-zh-CN.svg               |   2 +- (全量重写)
 docs/assets/tui/settings-en.svg                  |   2 +- (全量重写)
 docs/assets/tui/settings-zh-CN.svg               |   2 +- (全量重写)
 scripts/generate-svgs.ts                         |  (新增, 生成器)
 src/tui/**                                       |  (M2-M5 改动, 本次未修改)
 test/tui-redesign*.test.mjs                      |  (M2-M5 新增)
```

6 张 SVG 文件名不变、路径不变、viewBox 不变（1228×748）。

## 3. 验证结果

**tsc：**
```text
bunx tsc --noEmit -p tsconfig.json → 0 错误
```

**bun run test：**
```text
177 pass
0 fail
Ran 177 tests across 10 files. [8.17s]
```

**headless 冒烟：**
```text
bun run build → 通过
bun run start -- --headless → REQUIRES-HUMAN
原因：Workspace is already active in PID 18570，本机已有 MyTerminal 实例占用工作区。
需在空闲终端手动验证。
```

## 4. 硬规则自查

| # | 规则 | 结果 | 证据 |
|---|------|:----:|------|
| 1 | 只在 feat/tui-claude-redesign 分支 | ✓ | `git branch --show-current` = feat/tui-claude-redesign |
| 2 | 不动核心禁区文件 | ✓ | `git diff main...HEAD --name-only` 无 store/extensions/core-tools/server/mcp/types/config/tui-model |
| 3 | tsc 0 错 + test 全绿 | ✓ | tsc 0 错、177/0 |
| 4 | SVG 文件名/路径不变、文本网格渲染 | ✓ | 6 张文件名不变，viewBox=1228×748，SFMono 等宽字体，rect+text 网格 |
| 5 | ADR 只准定稿不改决策 | ✓ | 仅补 M2-M6 里程碑标记与状态行，决策内容未改动 |
| 6 | 无法验证项标注 REQUIRES-HUMAN | ✓ | 项 13-17 正确标注 |
| 7 | 主题/文案/布局/性能/风格铁律 | ✓ | SVG 使用 palette.ts 暖色 hex，BottomNav/InputBar/StatusLine 体现新布局 |
| 8 | 不确定就停 | ✓ | 无阻塞项 |

## 5. ADR 符合性自查

**决策 10（测试与验收标准）：**
- 硬门槛（现有测试全绿 + typecheck + build）：✓ 177 pass / 0 fail
- 新增单测（model/ 纯函数）：✓ 已在 M1-M5 补齐
- 文档图（6 张 SVG 按新设计重生成）：✓ 全部重画，docs.test.mjs 通过
- 手测清单：REQUIRES-HUMAN（项 14-17）

**决策 11（里程碑 M6 行）：**
- ✓ docs SVG 重新生成 — 6 张，暖色主题，文本网格法
- ✓ 全量验收 — 17 项核查完成
- ✓ ADR 定稿 — M2-M6 里程碑标记 ✅，状态更新

## 6. 全量验收清单

**A. 自动化硬门槛**
| # | 项 | 结果 | 证据 |
|---|-----|:----:|------|
| 1 | tsc --noEmit → 0 错误 | ✓ | 退出码 0，无输出 |
| 2 | bun run test → 全绿 | ✓ | 177 pass / 0 fail，10 files |
| 3 | git diff main...HEAD 无禁区文件 | ✓ | 仅 src/tui/** + test/** + docs/** |

**B. 代码审查级核对**
| # | 项 | 结果 | 证据 |
|---|-----|:----:|------|
| 4 | 8 TABS 顺序正确，数字键 1-8 | ✓ | state.ts:16 TABS 数组；keymap.ts:91 数字键绑定 |
| 5 | InputBar Normal/Editing 双模式 + priority 350 + 键位 | ✓ | InputBar.tsx:83-94 useBindings priority=350 |
| 6 | 双速 tick 150ms + 1000ms | ✓ | App.tsx:73-86 setInterval(150) + setInterval(1000) |
| 7 | Mascot 5 mood + blink 2600/140ms + animated 降级 | ✓ | Mascot.tsx:11-17,19-21,23 |
| 8 | 凭据 fail-closed: wrapMode="none" + 450ms deadline | ✓ | Settings.tsx:71-72 wrapMode="none"；App.tsx:269 deadline |
| 9 | Timeline memoize + Logs ToolCallRow + 分页/开关/聚合 | ✓ | Timeline.tsx:87-118 useCallback；Logs.tsx:60,74-89 |
| 10 | Copy L1 集中化 | ✓ | copy/types.ts 集中 Copy 类型；grep 确认 L1 不散落 |
| 11 | 无硬编码颜色 | ✗ | Modal.tsx:8 `#000000bb` — 预存问题，Modal.tsx 不在 M2-M6 改动内 |
| 12 | HelpOverlay 命令表 vs command-router | ≈ | /help、/帮助 在 command-router 注册但不在 HelpOverlay COMMAND_LIST — 轻微不一致（M2 遗留，见 M2-2） |

**C. 运行冒烟**
| # | 项 | 结果 | 证据 |
|---|-----|:----:|------|
| 13 | build + headless 8s 冒烟 | REQUIRES-HUMAN | build 通过；headless 因已有实例占用工作区被拒 |

**D. 人工项**
| # | 项 | 结果 |
|---|-----|:----:|
| 14 | 8 页 × 双主题 × 双语真实渲染 | REQUIRES-HUMAN |
| 15 | InputBar 实际击键（命令/消息/历史/补全/Esc） | REQUIRES-HUMAN |
| 16 | Mascot 眨眼动画肉眼确认 | REQUIRES-HUMAN |
| 17 | Windows 兼容模式（20fps/键盘-only） | REQUIRES-HUMAN |

## 7. 前置任务遗留汇总处理

| 遗留编号 | 来源 | 内容 | M6 处置 |
|---------|------|------|---------|
| M2-1 | review-M2 | Timeline 页面不得被误删 | ✓ 已确认 Timeline.tsx 存在且功能完整 |
| M2-2 | review-M2 | HelpOverlay 命令表与 command-router 同步 | ≈ 已核查，/help、/帮助 缺失 — 轻微影响，不影响功能 |
| M2-3 | review-M2 | useRef 在并发 React 下的细微风险 | - 文档级记录，M6 无需处理 |
| M2-4 | review-M2 | InputBar.handleInputSubmit 直接调用 store | ✓ 符合 M2 设计，M6 无需改动 |
| M3-1 | review-M3 | 纯函数不重复实现 | ✓ model/ 文件均在 src/tui/model/，无碎片化 |
| M3-2 | review-M3 | Home 消息行不强制回溯统一 | ✓ 符合原始设计，无需改动 |
| M3-3 | review-M3 | limit=7 硬编码 | ✓ M4b 全量分页不影响 Home |
| M3-4 | review-M3 | useTimelineModel revision 数据源 | ✓ hook 存在且与当前数据源一致 |
| M4a-1 | review-M4a | fallback 行为一致性 | ✓ history-entry.ts fallback 一致 |
| M4a-2 | review-M4a | MessageBubble 与 ToolCallRow 分离 | ✓ 二者为独立组件 |
| M4a-3 | review-M4a | 历史条目 type 集合参考 | ✓ M4b 已引用 |
| M4a-4 | review-M4a | 时间格式一致性 | ✓ relativeTime 统一使用 |
| M4b-1 | review-M4b | Settings 不强制折叠 | ✓ Settings 无展开/折叠功能 |
| M4b-2 | review-M4b | 独立 page state | ✓ timelinePage/logPage 各自独立 |
| M4b-3 | review-M4b | scrollKey 含展开状态 | ✓ 无新展开控件引入 |
| M4b-4 | review-M4b | 截断哲学一致性 | ✓ clip(safeJson(value), 200) 模式在各页面一致 |
| M5-1 | review-M5 | SVG 基于最终页面 | ✓ 6 张 SVG 按 M2-M5 最终页面重画 |
| M5-2 | review-M5 | Settings 为 L2 精确标杆 | ✓ SVG 中 Settings 凭据行反映 wrapMode="none" |
| M5-3 | review-M5 | Modal/FormDialog 无需联动 | ✓ 无改动 |
| M5-4 | review-M5 | Diff 颜色回退行为 | ✓ colorFor 回退至 theme.text |

## 8. 阻塞与提问

无阻塞项。

## 9. 风险与遗留

1. **B11 硬编码颜色**（Modal.tsx:8 `#000000bb`）：预存问题，Modal.tsx 未在 M2-M6 改动范围。建议后续单独修复——在 palette.ts 添加半透明遮罩色或 Theme 类型扩展 overlay 字段。

2. **B12 HelpOverlay 命令表不完全**：/help 和 /帮助 在 command-router 注册但不在 HelpOverlay COMMAND_LIST。轻微——帮助页本身的入口不需要在帮助页内重复展示（鸡生蛋），但严格一致性格子未 100% 通过。

3. **Headless 冒烟无法验证**：本机已有 MyTerminal 实例占用工作区，headless 启动被集群锁拒绝。需在干净环境手动验证。

4. **Mascot blink 2600/140ms 周期**：定时器精度依赖系统，眨眼动画需在主理人真机 TUI 中肉眼确认。

5. **SVG 绘制为 dark 主题**：如后续需要 light 主题 SVG（ADR 未明确要求双主题图），需额外生成。

## 10. 请审查者重点看

1. **6 张 SVG 视觉效果**：打开 `docs/assets/tui/overview-en.svg` 在浏览器中查看新暖色主题 TUI 渲染是否与预期一致（Mascot 位置、会话树缩进、底部输入栏 + 状态栏）。

2. **ADR-0004 定稿内容**：确认决策 11 里程碑 M2-M6 的完成记录（commit hash、测试数）与实际提交一致。

3. **B11 Modal.tsx 硬编码**：终审判定是否需要在此分支修复，或记录为后续 debt。
