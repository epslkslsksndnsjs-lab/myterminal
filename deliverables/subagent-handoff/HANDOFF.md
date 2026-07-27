# 主理人交接：Subagent 弱模型执行文档包生成完成

- **日期**：2026-07-27
- **分支**：`feat/skills`（基于 main `53b07ac`）
- **任务**：将 ADR-0007（40 决策）/ 0008（4 决策）/ 0009（14 决策）转化为 8 个"弱模型能一步步照着做"的串行执行文档
- **状态**：✅ 文档全部交付，弱模型可开始按 M1 执行

---

## 产出文件清单（9 个）

| 文件 | 作用 |
|------|------|
| `README.md` | 总览、通用编码规范、依赖链图、ADR 冲突仲裁规则、变异测试方法论——**弱模型开工前必须先读** |
| `m1-config-types.md` | types.ts transport 新增 + config.ts 配置/校验（修改既有文件） |
| `m2-state-modules.md` | 4 个纯数据模块：store / cost-tracker / file-state / shell-tracker（全部新建） |
| `m3-permissions-budget.md` | 安全红线：命令安全检查 + 结果大小预算（新建，90% 覆盖率） |
| `m4-tools.md` | SubagentTool 接口(10字段) + 注册表 + 8 个工具实现（新建，最大模块 ~700 行） |
| `m5-tool-executor.md` | 并行批次调度 + 两层校验 + 审计日志 + hooks（新建，90%） |
| `m6-llm-adapter.md` | 3 个 provider 适配器 + 流式 Watchdog + token 计数（新建，90%） |
| `m7-executor-tui-bridge.md` | agent loop 心脏 + TUI 桥（新建，90%） |
| `m8-integration-tui.md` | 接入层 runner + 改 5 个既有文件 + TUI 2 个新页面 + 端到端测试（收官） |

## 主理人已完成的工作

1. **通读并理解 3 份 ADR 全文**（0007 共 2426 行含参考代码、0008 共 228 行、0009 共 408 行）。
2. **发现并裁决了 5 个 ADR 内部矛盾/盲点**，直接写入文档，弱模型不会面对这些决策困境：
   - ADR 冲突仲裁：`budgetUSD` 不做（0009 决策 14 覆盖 0007 决策 22）
   - `callSubagent` 的真实用途定位（裁决 = runner 通知通道，不接工具循环）
   - M4 补 `ctx.readOnly`（ADR 参考代码漏了，权限防线落地必需）
   - TUI tab 追加尾部不重排（避硬编码索引回归）
   - executor 的 adapter 必须可注入（硬性可测试性设计）
3. **确认了既有代码的接入点**（通过阅读源码定位了 CONTROL_TOOLS、registerDelegate、claimFresh、registerDirect、App.tsx tab 索引体系等），确保 M8 的"修改既有文件"步骤不会踩坑。
4. **定义了测试体系**：node:test + assert/strict、bun test --coverage、变异体清单法（不引 Stryker）、集成测试 import dist 产物。

## 强加给弱模型的硬约束（写在 README 和各文档里的铁律）

- **分支**：每个文档第一句话强制确认 `feat/skills`
- **覆盖**：核心模块（M3/M5/M6/M7）≥90%，组件模块 ≥70%
- **铁律不改**：store.ts 持久化格式不动、现有工具行为不动、TUI 既有页面不动、server.ts 不动
- **不允许**：删测试、宽松断言、`@ts-ignore`、跳过 typecheck、自创新依赖
- **语言**：TypeScript ESM，NodeNext 模块解析，import 必须带 `.js` 后缀

## 不做的（已排除）

- 权限冒泡到父 AI UI（ADR-0007 决策 17 的"已知限制"）
- Stryker 变异测试（手工变异体清单替代，不引入重依赖）
- `@ag-ui/core` npm 依赖（事件类型本地声明，除非主理人另行批准）
- budgetUSD 强制预算（ADR-0009 决策 14：成本只追踪不限制）
- 工具结果磁盘持久化、subagent transcript 持久化、声明式 agent 定义
