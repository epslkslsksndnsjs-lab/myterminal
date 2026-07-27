# Subagent 系统实施交接包（弱模型执行手册）

> ⚠️ **做任何事之前，先执行 `git branch --show-current`，确认当前在 `feat/skills` 分支，不要在 `main`（主分支）上开发。** 如果输出不是 `feat/skills`，立即停止并报告，不要自行切换分支。

本交接包把 ADR-0007（Subagent 核心执行器，40 项决策）、ADR-0008（TUI 通信层，4 项决策）、ADR-0009（接入 MyTerminal，14 项决策）拆解为 **8 个串行执行任务（M1-M8）**。每个任务一份文档，严格按编号顺序执行，前一个任务验收通过后才能开始下一个。

---

## 一、任务路线图与依赖链

```
M1 配置与类型地基        types.ts + config.ts
  └─> M2 状态管理四模块    store / cost-tracker / file-state / shell-tracker
  └─> M3 权限与结果预算    permissions / result-budget（安全红线）
        └─> M4 工具系统    tools.ts + grep-utils.ts（8 个工具）
              └─> M5 工具执行器  tool-executor.ts（并行/校验/审计）
M1 ──────────────────────> M6 LLM 适配层  llm-adapter + token-counter
M2+M4+M5+M6 ─────────────> M7 核心执行器 + TUI 桥  executor + tui-bridge
M7 ──────────────────────> M8 接入层 + TUI 页面 + 端到端  runner / core-tools / extensions / mcp / openapi / TUI
```

| 任务 | 文档 | 新建文件 | 修改文件 | 预估行数 | 覆盖率门槛 |
|------|------|---------|---------|---------|-----------|
| M1 | `m1-config-types.md` | — | `src/types.ts`、`src/config.ts` | +80 | 组件 70% |
| M2 | `m2-state-modules.md` | `src/subagent/{store,cost-tracker,file-state,shell-tracker}.ts` | — | ~450 | 组件 70% |
| M3 | `m3-permissions-budget.md` | `src/subagent/{permissions,result-budget}.ts` | — | ~350 | **核心 90%** |
| M4 | `m4-tools.md` | `src/subagent/{tools,grep-utils}.ts` | — | ~700 | 组件 70% |
| M5 | `m5-tool-executor.md` | `src/subagent/tool-executor.ts` | — | ~300 | **核心 90%** |
| M6 | `m6-llm-adapter.md` | `src/subagent/{llm-adapter,token-counter}.ts` | — | ~550 | **核心 90%** |
| M7 | `m7-executor-tui-bridge.md` | `src/subagent/{executor,tui-bridge}.ts` | — | ~700 | **核心 90%** |
| M8 | `m8-integration-tui.md` | `src/subagent/runner.ts`、`src/tui/screens/{Subagents,Subagent}.tsx` | `src/core-tools.ts`、`src/extensions.ts`、`src/mcp.ts`、`src/openapi.ts`、`src/tui/App.tsx` | ~600 | 组件 70% |

每个任务还要新增对应测试文件 `test/subagent-m<N>.test.mjs`。

---

## 二、通用编码规范（所有任务必须遵守）

### 2.1 分支与铁律

1. **先确认在 `feat/skills` 分支**（每个文档第一句话的要求，开工前执行 `git branch --show-current` 并截图/粘贴输出）。
2. **不改 `store.ts` 持久化格式**（JSONL 结构一个字节都不能变）。
3. **不改 `types.ts` 已有字段**，只允许"新增"（transport 枚举加成员、settings 加可选字段）。
4. **不改 `server.ts`**（HTTP 端点不变）、**不改 `mcp.ts` 既有逻辑**（M8 只允许追加 registerDirect）。
5. **不改现有 `core-tools.ts` 工具的 behavior**（M8 只允许追加 3 个新工具注册）。
6. **不改现有 TUI 组件/页面**（M8 只允许新增页面 + App.tsx 加 tab）。
7. 禁止引入新的 npm 依赖（除 M8 可选的 `@ag-ui/core`——该任务文档会说明；若不装则事件类型在 `tui-bridge.ts` 本地声明）。
8. 提交前必须 `bun run test` 全量通过（现有 178 项 + 新增项，0 fail）且 `bun run typecheck` 0 errors。

### 2.2 开发语言与代码风格（与现有代码保持一致）

- **语言**：TypeScript（ESM），不允许引入其他语言文件。
- 模块解析 NodeNext：**相对导入必须带 `.js` 后缀**（如 `import { x } from './file-state.js'`）。
- Node 内置模块用 `node:` 前缀（`node:fs`、`node:path`、`node:child_process`）。
- 2 空格缩进、单引号、行尾分号；常量 `SCREAMING_SNAKE_CASE`；函数/变量 `camelCase`；类型 `PascalCase`。
- 导出类型用 `export type X = { ... }`；严格模式（`strict: true`），不允许 `any`（确需时用 `unknown` + 收窄）。
- 参照 `src/skills.ts`、`src/config.ts` 的风格：文件顶部常量区、纯函数优先、错误用 `MyTerminalError` 或返回 `{ is_error: true, message }`（subagent 工具内约定）。
- 注释只写"为什么"，不写"是什么"；ADR 决策编号写入注释（如 `// 决策 18：并行度上限`）便于审查。

### 2.3 测试体系（单测 + 变异测试 + 集成测试）

**测试框架**：`node:test` + `node:assert/strict`，测试文件为 `test/subagent-m<N>.test.mjs`（纯 `.mjs`，import 构建产物 `../dist/subagent/xxx.js`）。与现有 `test/tui-redesign-m2.test.mjs` 等风格一致。

**标准验证命令**（每个任务交付前必须全部通过并粘贴输出）：

```bash
bun run typecheck                                  # 0 errors
bun run build                                      # 编译通过
bun test --timeout 120000 test/subagent-m<N>.test.mjs   # 本任务测试全过
bun test --coverage test/subagent-m<N>.test.mjs    # 覆盖率达标
bun run test                                       # 全量回归 0 fail（防破坏现有功能）
```

**覆盖率门槛**：
- 核心模块（M3 / M5 / M6 / M7 的新建文件）**≥ 90%**（函数与行覆盖）。
- 组件模块（M1 / M2 / M4 / M8 的新建文件）**≥ 70%**。
- 以 `bun test --coverage` 输出为准，交付总结里粘贴关键行。

**变异测试（手工变异体法，不引入 Stryker）**：
项目不新增重型依赖，变异测试采用"变异体清单 + 杀死断言"法：
1. 每个任务文档给出**变异体清单**（对本任务代码做语义级微小篡改，如 `>` 改 `>=`、`&&` 改 `||`、删 `!`、边界 off-by-one、常量 ±1、删除某行调用）。
2. 为每个变异体写（或指定）一个测试用例，使得**应用该变异后测试必然失败**（即"杀死变异体"）。
3. 交付时在总结中列出"变异体 → 杀死它的测试名"对照表。
4. 评审人会抽查：把变异体手工应用到 `src/` 临时代码，跑对应测试，必须红。

**集成测试**：
- 每个任务至少 1 个集成用例：import 构建后的 `dist/` 产物走真实调用路径（不 mock 本任务模块内部函数；外部依赖如 LLM API 用 mock/fake）。
- M8 另有端到端集成测试：通过 `ExtensionService.call()` 链路调用 `subagent_start/status/abort`（runner 注入 fake executor，不调真实 LLM）。

### 2.4 交付格式（每个任务完成后输出）

1. 改动文件清单（新建/修改 + 行数）。
2. 验证命令输出（typecheck / 本任务测试 / 覆盖率 / 全量回归）。
3. 覆盖率摘要 + 变异体杀死对照表。
4. 遗留问题与给下一任务的交接说明。
5. **不要提交 git commit**——所有任务由主理人统一审查后提交（除非主理人另行指示）。

### 2.5 遇到问题怎么办

- ADR 与现有代码矛盾 → 停止，记录矛盾点，报告主理人，不要自行发挥。
- 文档步骤缺失/含糊 → 按 ADR 原文执行；仍不清则报告，不要猜测式实现。
- 测试红了但认为"是测试的问题" → 默认是代码的问题，先修代码；确有证据再报告。
- **绝不允许**：删测试、把断言改宽松、`// @ts-ignore`、跳过 typecheck。

---

## 三、ADR 原文位置（必读）

- `docs/adr/0007-subagent-executor.md` — 40 项决策 + 完整参考代码（2426 行，**主要实现依据**）
- `docs/adr/0008-subagent-tui-bridge.md` — 14 种 AG-UI 事件 + EventEmitter + TUI 页面
- `docs/adr/0009-subagent-integration.md` — 接入方案 D + transport + callSubagent + 配置

**决策冲突仲裁**：三份 ADR 冲突时以**编号大的 ADR 为准**（0009 > 0008 > 0007）。已知冲突：成本预算 `budgetUSD`——0007 决策 22 提过，0009 决策 14 明确"成本只追踪不限制"，以 0009 为准（配置里**不含** budgetUSD，不做超预算自动失败）。

## 四、全局文件改动总表（8 个任务合起来的最终状态）

**新建（11 个源文件 + 8 个测试文件）**：
`src/subagent/` 下 `store.ts`、`cost-tracker.ts`、`file-state.ts`、`shell-tracker.ts`、`permissions.ts`、`result-budget.ts`、`tools.ts`、`grep-utils.ts`、`tool-executor.ts`、`llm-adapter.ts`、`token-counter.ts`、`executor.ts`、`tui-bridge.ts`、`runner.ts`；`src/tui/screens/Subagents.tsx`、`Subagent.tsx`；`test/subagent-m1..m8.test.mjs`。

**修改（7 个既有文件，全部只增不改语义）**：
`src/types.ts`（M1）、`src/config.ts`（M1）、`src/core-tools.ts`（M8）、`src/extensions.ts`（M8）、`src/mcp.ts`（M8）、`src/openapi.ts`（M8）、`src/tui/App.tsx`（M8）。

**不碰**：`store.ts`、`server.ts`、`skills.ts`、其余 TUI 文件、持久化格式。
