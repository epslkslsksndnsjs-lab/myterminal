# TUI 重做 · 弱模型执行任务交接中心

> 主理人（像素匠/FrontendDeveloper）已完成设计与 M1 地基，剩余 M2-M6 由弱模型按本文档包逐任务执行。
> 每个任务文档**完全自包含**：你是全新上下文也能独立开工。不要读其他任务的文档，只读你自己那篇。

## 执行流程（严格遵守）

1. 认领**一个**任务文档（按顺序执行：M2 → M3 → M4a → M4b → M5 → M6，不可跳序，前一个未交付审查报告不得开始下一个）
2. 通读你的任务文档**两遍**，先读「硬规则」再读「逐步执行」
3. 开工前跑环境检查（文档第 0 步），确认分支与基线
4. 严格按步骤执行，每步完成跑该步验证命令
5. 全部完成后，跑全量验证，然后**原样填写文档末尾的《审查报告》模板**，作为单独文件保存到：
   `deliverables/tui-redesign-handoff/review-<任务编号>.md`（如 review-M2.md）
6. 交付 = 代码 commit + 审查报告文件。主理人只看这两样做终审

## 当前进度

| 里程碑 | 状态 | 交接文档 |
|---|---|---|
| 设计 + ADR-0004（12 项决策） | ✅ 完成 | `docs/adr/0004-tui-full-redesign-claude-style.md` |
| M1 地基（theme/copy/Mascot/model） | ✅ 完成 commit `0cb5c6a`（98 pass） | — |
| M2 骨架（8页路由+chrome+InputBar+双速tick） | 🔲 待执行 | `M2-skeleton.md` |
| M3 主屏 Home | 🔲 待执行 | `M3-home.md` |
| M4a 会话页+消息页 | 🔲 待执行 | `M4a-sessions-messages.md` |
| M4b 时间线页+日志页 | 🔲 待执行 | `M4b-timeline-logs.md` |
| M5 工具页+Setup+错误边界 | 🔲 待执行 | `M5-utility-pages.md` |
| M6 收尾（SVG+全量验收+ADR定稿） | 🔲 待执行 | `M6-finalize.md` |

## 仓库事实（所有任务通用）

- 仓库：``（所有命令在此目录执行）
- 分支：`feat/tui-claude-redesign`（隔离分支）
- 运行时：Bun ≥ 1.3；包管理 bun；构建 `bun run build`（tsc → dist/）
- 验证：`bunx tsc --noEmit -p tsconfig.json` + `bun run test`
- M1 后基线：**98 pass / 0 fail**（test/*.test.mjs 共 5 个文件）
- TS 严格模式（strict: true）；ESM NodeNext；相对导入**必须带 .js 后缀**；JSX = react-jsx + jsxImportSource @opentui/react
