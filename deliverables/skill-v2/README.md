# ADR-0010 落地执行包 — Skill 调用工具 v2（inline + fork 双模式）

> 本目录是 4 个可直接交给弱模型执行的开发文件。每个文件自包含：先理解、再动手、做完验证、git 提交。
> 目标：ADR-0010（`docs/adr/0010-skill-invoke-tool-v2.md`）全部 18 个决策落地。

## 铁律（每个任务都必须遵守，违反立即停止并报告）

1. **分支铁律**：所有工作必须在 `feat/skills` 分支。每个任务文件的第一步就是检查分支——`git branch --show-current` 输出必须正好是 `feat/skills`。如果不是，**停止一切操作**，先报告，等主理人指示。绝对禁止在 `main` 分支上做任何修改。
2. **先理解再动手**：每个任务的"必读清单"必须真的读完再改代码。读不懂的行就再读一遍上下文，**禁止猜测语义**。
3. **不懂就查**：行号可能因前置任务略有漂移，以实际代码为准——用 Grep/Read 确认，不要盲目按行号覆盖。
4. **不猜 API**：用到任何函数前先读它的源码或类型定义。
5. **硬规则**：
   - 不改 `src/store.ts`、`src/server.ts`、持久化格式（JSONL 结构）。
   - 每个任务完成后 `bun run typecheck && bun run build && bun test <相关测试>` 全绿才允许提交。
   - 每个任务完成必须 `git add` + `git commit`（commit message 按任务文件给定格式）。
   - 代码风格对齐现有文件：2 空格缩进、单引号、行尾分号、工具注册用 `add({...})` 模式、错误用 `MyTerminalError`。
   - 测试风格对齐 `test/subagent-m8.test.mjs`：`node:test` + `node:assert/strict`、从 `dist/` 导入构建产物、文件头注释写明覆盖目标与变异体。
6. **覆盖率目标**：新增/改动代码行覆盖率 ≥ 80%，核心文件（`src/skills.ts`、`src/subagent/runner.ts` 改动函数、skill 工具 invoke 路径）≥ 90%。每个测试文件头部注释列出"变异体清单"（本测试杀死的假设性 bug），变异体必须 100% 被杀死。
7. **禁止事项**：禁止安装新依赖；禁止重构任务范围外的代码；禁止"顺手优化"；禁止跳过测试直接提交；禁止 `git add -A` / `git add .`（只 add 任务文件列出的具体文件）。

## 任务顺序与依赖

| # | 文件 | 内容 | 改动文件 | 决策 | 依赖 |
|---|------|------|---------|------|------|
| 1 | `task-1-baseline-and-skills-data.md` | 基线提交（存量 GLM 改动 + ADR 文档）+ `skills.ts` 数据层（mode/forkOptions 解析与校验） | `src/skills.ts` + 新建 `test/skills-v2.test.mjs` | 2/5/6/11 | 无 |
| 2 | `task-2-runner-origin-idempotent.md` | `runner.ts`：start() 加 origin、status() 改 idempotent、notify 带 taskId+origin | `src/subagent/runner.ts`、`src/core-tools.ts`（仅 1 行描述）、`test/subagent-m8.test.mjs`（适配）+ 新建 `test/skill-v2-runner.test.mjs` | 13/14 | 任务 1 |
| 3 | `task-3-skill-tool.md` | `core-tools.ts`：删 skill_list/skill_load，新建 skill 工具（无参=list / 有参=run，inline/fork 双模式） | `src/core-tools.ts` + 新建 `test/skill-v2-tool.test.mjs` | 1/3/7/8/15/17/18 | 任务 1、2 |
| 4 | `task-4-integration-verify.md` | 收尾：mcp.ts 提示语、ADR-0006 标 superseded、AGENT.md 工具数、全量测试 + 覆盖率报告 | `src/mcp.ts`、`docs/adr/0006-skill-invoke-tool.md`、`AGENT.md` + 新建 `test/skill-v2-integration.test.mjs` | 5/7/12 | 任务 1、2、3 |

**必须按 1 → 2 → 3 → 4 顺序执行。** 每个任务完成后立即提交，再开始下一个。

## 当前工作区状态（2026-07-27 规划时快照，执行前必须重新核实）

- 分支：`feat/skills`（最近提交 `91fb108 feat(subagent): M8 ...`）
- 未提交修改（任务 1 Part A 负责提交）：`src/config.ts`、`src/core-tools.ts`、`src/mcp.ts`、`src/openapi.ts`、`src/types.ts`、`src/subagent/{cost-tracker,llm-adapter,runner,token-counter}.ts`、`src/tui/screens/shared.tsx`、`CONTEXT.md`
  —— 这是 GLM provider 全链接入（含 ADR-0010 审查发现的 `runner.ts` provider 缺 `'glm'` bug 修复，已在工作区完成）
- 未跟踪文件：`docs/adr/0006~0010*.md`（5 个 ADR）、`deliverables/subagent-handoff/`（M8 交付物）、`overview.md`（artifact）、`subagent-test-123.txt`（测试残留垃圾，任务 1 删除）

## 验证命令速查

```bash
# 类型检查（改动后必跑）
bun run typecheck
# 构建（测试从 dist/ 导入，改代码后必须重新构建）
bun run build
# 跑单个测试文件
bun test --timeout 120000 test/skills-v2.test.mjs
# 覆盖率（核心文件必须达标）
bun test --timeout 120000 --coverage test/skills-v2.test.mjs
# 全量测试（任务 4 必跑）
bun run test
```
