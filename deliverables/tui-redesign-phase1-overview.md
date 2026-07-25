# TUI 完全重做 · 阶段一交付：理解 + 隔离分支 + 拷问式 ADR

日期：2026-07-25 · 分支：feat/tui-claude-redesign（基于 main ea5407f，隔离，不合并）

## 本阶段完成了什么

1. **全面理解现状**：通读 src/tui 全部 26 个文件与后端核心（store/extensions/server/diff/update），产出数据流报告。关键结论：TUI 是 runtime 的进程内拉取式投影（1s revision 轮询，无 push）；键盘四层路由；大列表 viewportCulling；Windows 20fps 兼容 profile。
2. **建立隔离工作区**：将 fix/mcp-session-state 上的未提交实验改动（tui-impl +375 行）以 WIP 提交保存（32d182b），随后从 main 创建 `feat/tui-claude-redesign`，基线测试 **92 pass / 0 fail**。
3. **拷问 + ADR**：加载 grilling 及 7 个 TUI 技能，逐项拷问并当场写入 **ADR-0004**（`docs/adr/0004-tui-full-redesign-claude-style.md`），11 项决策全部确认，信心评估 ≈90%。

## 11 项决策速览

| # | 决策 | 结论 |
|---|---|---|
| 1 | 范围 | 完全重做 TUI 前端，骨架不受现有 7-tab 约束；不改核心逻辑 |
| 2 | 主屏 | 吉祥物问候 + 会话摘要 + 动态时间线 + 底部轻量导航（设计稿已确认） |
| 3 | 主题 | 重塑 dark/light 为 Claude 暖色（暖黑暗/暖纸亮），枚举与配置 schema 零改动 |
| 4 | 输入栏 | 全页常显 ❯ 输入栏：/ 命令路由 + 文本发消息 + 历史；Normal/Editing 双模式；keymap 扩为五层 |
| 5 | 吉祥物 | 状态表情（5 种 mood）+ 0.5-1Hz 低频眨眼，Windows 静态降级 |
| 6 | 文案 | 分层俏皮：L1 问候/空状态/状态动词俏皮，L2 操作/设置/错误精确；双语意译 |
| 7 | 页面 | 8 页：概览/会话/消息/**时间线(新)**/Diff/扩展/设置/日志 |
| 8 | 性能 | profile 不动；动画仅眨眼；timeline 归并 memoize；输入栏局部 state |
| 9 | 结构 | src/tui/ 新增 theme/ copy/ model/ hooks/；TuiController 与后端契约不动 |
| 10 | 验收 | 92 项基线全绿为硬门槛 + model/ 新单测 + docs SVG 重生成 + 手测清单 |
| 11 | 交付 | M1 地基 → M2 骨架 → M3 主屏 → M4 逐页 → M5 工具页(含 Setup) → M6 收尾 |

## 当前状态：已暂停（用户指示）

M1 开工待用户发令。恢复时直接说"继续"或"开始 M1"即可：分支、ADR、基线均已就绪。

## 需要注意的发现

- `src/store.ts:848/850` `createDelegate` 疑似重复 push 同一 session 对象（被 find 语义掩盖）。属核心逻辑，本次只记录不修改，建议另行验证。
- headless 模式无 TUI tick，stale 检测依赖工具调用路径——重构保持 tickReminders 语义不动。
