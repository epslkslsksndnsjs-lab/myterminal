# M1：配置与类型地基

> ⚠️ **开始前先执行 `git branch --show-current`，确认当前在 `feat/skills` 分支，不要在 `main`（主分支）上开发。** 输出不是 `feat/skills` 就立即停止报告。

- **任务目标**：为 subagent 系统打好类型与配置地基——`InvocationContext.transport` 新增 `'subagent'`，`MyTerminalSettings` 新增 `subagent` 配置段，`config.ts` 提供默认值与校验。
- **ADR 依据**：ADR-0009 决策 3（transport）、决策 5（API key 环境变量）、决策 11（maxParallel）、决策 12（provider/model/maxTurns/timeoutSec/readOnly）、决策 14（成本只追踪不限制）；ADR-0007 决策 14、决策 21（fallbackModel）。
- **前置依赖**：无（这是第一个任务）。
- **产出**：修改 `src/types.ts`、`src/config.ts`；新建 `test/subagent-m1.test.mjs`。预估 +80 行源码。
- **覆盖率门槛**：组件级 ≥ 70%。

---

## 一、必读材料（动手前读完）

1. `deliverables/subagent-handoff/README.md`（通用规范，全部适用）
2. `docs/adr/0009-subagent-integration.md` 的「settings.json 新增字段」节 + 决策 3 / 11 / 12 / 14
3. `src/types.ts` —— 找到 `InvocationContext` 与 `MyTerminalSettings` 的现有定义
4. `src/config.ts` —— 通读 `createDefaultSettings` 与 `validateSettings`（理解现有的"默认值 + 逐字段校验"模式，照抄模式不要创新）

## 二、铁律（本任务专属）

- `InvocationContext` 只能**给 transport 联合类型追加成员**，不得改动任何已有字段。
- `MyTerminalSettings` 只能**追加可选字段**，不得改动已有字段的类型或默认值。
- 不新增 `budgetUSD`（ADR-0009 决策 14：成本只追踪不限制）。
- API key **不进入 settings 类型**——只走环境变量，types/config 里不许出现 `apiKey` 字段。

## 三、分步实施

### Step 1：`src/types.ts` 追加 transport 成员

1. 找到 `InvocationContext` 类型（`transport: 'apps' | 'actions' | 'tui' | 'test'`）。
2. 在联合类型末尾追加 `| 'subagent'`，加注释 `// ADR-0009 决策 3`。
3. **输出物**：transport 联合类型含 5 个成员。
4. **验证**：`bun run typecheck` 0 errors。

### Step 2：`src/types.ts` 新增 SubagentSettings 类型

在 `MyTerminalSettings` 附近新增并导出：

```typescript
// ADR-0009 决策 11/12/14 + ADR-0007 决策 21
export type SubagentSettings = {
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'deepseek';
  model: string;
  maxTurns: number;       // agent loop 轮次上限，默认 50
  timeoutSec: number;     // 整体超时秒数，默认 300
  maxParallel: number;    // 并发 subagent 上限，默认 2
  fallbackModel?: string; // 529 过载降级模型（ADR-0007 决策 21），可选
};
```

在 `MyTerminalSettings` 类型中追加可选字段：`subagent?: SubagentSettings;`（可选，保持向后兼容——旧配置文件没有这段也能过校验）。

**验证**：`bun run typecheck` 0 errors。

### Step 3：`src/config.ts` 默认值

1. 在 `createDefaultSettings` 返回对象中追加（照抄现有字段的写法风格）：

```typescript
subagent: {
  enabled: true,
  provider: 'openai',
  model: 'gpt-4o',
  maxTurns: 50,
  timeoutSec: 300,
  maxParallel: 2,
},
```

2. **输出物**：默认 settings 含完整 subagent 段。
3. **验证**：`bun run build` 通过。

### Step 4：`src/config.ts` 校验逻辑

在 `validateSettings` 中追加对 `settings.subagent` 的校验（**只在字段存在时校验**，不存在不报错——向后兼容）。逐条实现，错误消息风格与现有校验一致：

| 校验项 | 规则 | 不合法时 |
|--------|------|---------|
| `enabled` | 必须是 boolean | 抛错/记录并回退默认（与现有同风格） |
| `provider` | ∈ `{'openai','anthropic','deepseek'}` | 同上 |
| `model` | 非空 string | 同上 |
| `maxTurns` | 整数，1-200 |  clamp 或回退（照抄现有 `boundedInteger` 思路） |
| `timeoutSec` | 整数，30-3600 | 同上 |
| `maxParallel` | 整数，1-4 | 同上 |
| `fallbackModel` | 若存在必须是非空 string | 非法则丢弃该字段 |

**注意**：先通读 `validateSettings` 现有实现对其它字段的处理方式（是直接抛错、还是警告并回退默认值），**严格沿用同一种方式**，不要发明新的错误处理路径。

**验证**：`bun run typecheck && bun run build` 全过。

### Step 5：编写测试 `test/subagent-m1.test.mjs`

用 `node:test` + `node:assert/strict`，import `../dist/config.js` 与 `../dist/types.js`（types 只剩编译产物中的类型，运行时断言以 config 为主）。至少覆盖：

1. **默认值**：`createDefaultSettings()` 返回的 `subagent` 段与 Step 3 完全一致（逐字段 deepEqual）。
2. **合法配置**：构造含合法 subagent 段的 settings 过 `validateSettings` 不报错且值保留。
3. **非法 provider**（如 `'kimi'`）→ 按 Step 4 约定的方式处理（回退 `'openai'` 或报错——断言实际实现的行为）。
4. **越界数值**：`maxTurns: 0` / `maxTurns: 9999` / `timeoutSec: 5` / `maxParallel: 99` → 分别被钳制/回退到合法区间。
5. **缺失 subagent 段**：旧式 settings（无 subagent 字段）过校验不报错（向后兼容）。
6. **fallbackModel 非法**（如 `123`）→ 字段被丢弃。
7. **集成用例**：模拟完整流程——写一个临时 settings JSON（含 subagent 段）→ 走 config 的加载/校验路径 → 断言加载结果中 subagent 段值正确。

**验证**：`bun run build && bun test --timeout 120000 test/subagent-m1.test.mjs` 全过。

### Step 6：覆盖率 + 变异测试

跑 `bun test --coverage test/subagent-m1.test.mjs`，确认 `dist/config.js` 中新增校验分支覆盖 ≥ 70%。

**变异体清单**（每个都要有一个能杀死它的测试；交付时列出对照表）：

| # | 变异体（对 dist 临时代码手工应用） | 应被哪个测试杀死 |
|---|----------------------------------|-----------------|
| 1 | `maxTurns` 上限 200 改为 201（边界 off-by-one） | 用例 4 |
| 2 | `timeoutSec` 下限 30 改为 29 | 用例 4 |
| 3 | provider 白名单删除 `'deepseek'` | 用例 3 的变体（deepseek 合法配置被拒） |
| 4 | `maxParallel` 上限 4 改为 5 | 用例 4 |
| 5 | 缺失 subagent 段时改为抛错 | 用例 5 |

### Step 7：全量回归

`bun run test` —— 现有 178 项 + 新增全部 0 fail。**任何既有测试变红都说明改坏了既有行为，立即回滚排查。**

## 四、验收清单（DoD，逐条勾选）

- [ ] 在 `feat/skills` 分支（附 `git branch --show-current` 输出）
- [ ] `InvocationContext.transport` 含 `'subagent'`，其余字段未动
- [ ] `SubagentSettings` 类型导出，`MyTerminalSettings.subagent` 为可选字段，无 `apiKey`/`budgetUSD`
- [ ] `createDefaultSettings` 含完整 subagent 默认值
- [ ] `validateSettings` 7 条校验全部实现且风格与现有一致
- [ ] `test/subagent-m1.test.mjs` ≥ 7 用例全过
- [ ] 新增代码覆盖率 ≥ 70%，变异体 5/5 被杀死
- [ ] `bun run typecheck` 0 errors；`bun run test` 全量 0 fail
- [ ] 未提交 git commit

## 五、交接给 M2

M2 会新建 `src/subagent/` 目录下的四个状态模块。请在本任务交付总结中告知：
1. `SubagentSettings` 的确切导出位置（`dist/types.js` 的类型路径）。
2. `validateSettings` 采用的错误处理风格（抛错 or 回退），M2-M8 的错误处理要对齐。
3. 任何在实现中与本文档的偏差及理由。
