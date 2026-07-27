# 任务 1：基线提交 + skills.ts 数据层（mode / forkOptions）

> 你是执行本任务的开发模型。**严格按步骤来，每步做完验证再继续。禁止跳步、禁止猜测。**

## 第 0 步：分支检查（必须先做，失败立即停止）

```bash
cd 
git branch --show-current
```

- 输出必须**正好是** `feat/skills`。
- 如果不是：🛑 **停止一切操作**，向主理人报告"当前分支是 X，不是 feat/skills"，等待指示。绝对禁止切换到 main 或在当前错误分支上继续。

## 第 1 步：先理解（必读清单，读完再动手）

按顺序读，**每份都要真读**：

1. `docs/adr/0010-skill-invoke-tool-v2.md` 的决策 2、5、6、11（fork 由 frontmatter 声明 / list 暴露 mode / forkOptions 优先于 settings.json / frontmatter 校验）
2. `src/skills.ts` **全文**（191 行，不长）——这是你要改的文件
3. `test/subagent-m8.test.mjs` 的前 100 行——学习项目测试风格（`node:test` + `assert/strict` + 从 `dist/` 导入 + `tempDir()` 辅助）
4. `src/types.ts` 第 177-185 行——`SubagentSettings` 类型（forkOptions 的 provider 枚举要与它一致）

**理解自查**（能回答才算读完，答不上就重读）：
- 现有 `parseFrontmatter` 支持嵌套对象吗？（答：不支持，只支持单层 `key: value` 和 `key: [a, b]`）
- `listSkills` 的"全局覆盖项目级"是怎么实现的？（答：先 scanDir 项目级，再把全局 Map 逐条 set 进项目 Map）
- `loadSkill` 的查找顺序？（答：先全局 `configDir/skills/<name>/SKILL.md`，再项目级 `<workspace>/.myterminal/skills/<name>/SKILL.md`）

## 第 2 步：基线提交（把别人的存量工作先入库）

工作区有一批**与本任务无关的已完成工作**（GLM provider 接入 + ADR 文档），必须先提交，否则你的 diff 会和它们混在一起。

### 2.1 核实工作区状态

```bash
git status --short
```

预期看到（如果与预期不符，停止并报告）：
- 修改：`CONTEXT.md`、`src/config.ts`、`src/core-tools.ts`、`src/mcp.ts`、`src/openapi.ts`、`src/subagent/cost-tracker.ts`、`src/subagent/llm-adapter.ts`、`src/subagent/runner.ts`、`src/subagent/token-counter.ts`、`src/tui/screens/shared.tsx`、`src/types.ts`
- 未跟踪：`deliverables/subagent-handoff/`、`docs/adr/0006-skill-invoke-tool.md`、`docs/adr/0007-subagent-executor.md`、`docs/adr/0008-subagent-tui-bridge.md`、`docs/adr/0009-subagent-integration.md`、`docs/adr/0010-patch-audit.md`、`docs/adr/0010-skill-invoke-tool-v2.md`、`overview.md`、`subagent-test-123.txt`

### 2.2 清理测试残留垃圾

```bash
rm /subagent-test-123.txt
```

（这是 subagent 测试留在仓库根目录的残留文件。`overview.md` 保留不动——它是会话 artifact，由主理人决定去向。）

### 2.3 确认存量代码能编译、测试全绿（提交前守门）

```bash
bun run typecheck && bun run build && bun test --timeout 120000 test/subagent-m8.test.mjs
```

必须全绿。如果挂，停止并报告——说明存量工作本身有问题，不是你的责任，先报告。

### 2.4 提交 GLM 接入（一个 commit）

```bash
git add src/config.ts src/core-tools.ts src/mcp.ts src/openapi.ts src/types.ts \
  src/subagent/cost-tracker.ts src/subagent/llm-adapter.ts src/subagent/runner.ts \
  src/subagent/token-counter.ts src/tui/screens/shared.tsx
git commit -m "feat(subagent): GLM provider 全链接入

- config/core-tools/mcp/openapi/types/runner: provider 枚举加 'glm'
- cost-tracker: glm-4-flash / glm-4 定价 + 未知 GLM 模型回退
- token-counter: GLM 128K 上下文窗口
- llm-adapter: GLM API 接入
- 修复 ADR-0010 审查 bug：runner.ts SubagentStartInput.provider 缺 'glm'"
```

### 2.5 提交 ADR 文档与交付物（一个 commit）

```bash
git add CONTEXT.md docs/adr/0006-skill-invoke-tool.md docs/adr/0007-subagent-executor.md \
  docs/adr/0008-subagent-tui-bridge.md docs/adr/0009-subagent-integration.md \
  docs/adr/0010-patch-audit.md docs/adr/0010-skill-invoke-tool-v2.md \
  deliverables/subagent-handoff deliverables/skill-v2
git commit -m "docs(adr): skill/subagent 系列 ADR 0006-0010 + CONTEXT.md 术语表

- ADR-0006 skill 调用工具 v1（将被 0010 supersede）
- ADR-0007 subagent 核心执行器 / 0008 TUI 桥 / 0009 接入
- ADR-0010 skill 调用工具 v2（inline+fork 双模式）+ 审查补丁
- CONTEXT.md：skill/mode/fork/forkOptions 领域术语
- deliverables：M8 交付物 + ADR-0010 执行包"
```

### 2.6 验证基线干净

```bash
git status --short
```

预期只剩 `?? overview.md`（可能还有你本任务后续要建的文件）。如有其他，停止并报告。

---

## 第 3 步：改造 src/skills.ts

**设计约束（必须遵守，这是主理人的设计决策，不许自由发挥）：**

- `parseFrontmatter` 保持手写、零依赖。**禁止引入 YAML 库**。
- `parseFrontmatter` 只负责"解析出结构"，产出 `Record<string, unknown>`；**类型强制转换（coerce）全部放在 `validateSkillManifest`**——解析器保持通用，校验器负责语义。
- 嵌套只支持**一层**（`forkOptions:` 下的缩进字段）。更深的嵌套不处理（遇到就当普通字段，校验阶段自然报错）。

### 3.1 在文件顶部常量区加常量

位置：`src/skills.ts` 第 10 行 `const WHEN_TO_USE_MAX = 2000;` 之后。

加：

```typescript
const SKILL_MODES = ['inline', 'fork'] as const;
const FORK_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'glm'] as const;
const MAX_TURNS_MIN = 1;
const MAX_TURNS_MAX = 200;
const TIMEOUT_SEC_MIN = 30;
const TIMEOUT_SEC_MAX = 3600;
```

### 3.2 替换类型定义（第 12-20 行）

把现有的：

```typescript
export type SkillManifest = {
  name: string;
  description: string;
  when_to_use: string;
};
```

改为：

```typescript
export type SkillMode = (typeof SKILL_MODES)[number];

/** ADR-0010 决策 6：fork 时可覆盖 subagent 默认配置，优先级 forkOptions > settings.json */
export type SkillForkOptions = {
  deliverables?: string[];
  acceptanceCriteria?: string[];
  constraints?: string[];
  provider?: 'openai' | 'anthropic' | 'deepseek' | 'glm';
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
  readOnly?: boolean;
};

export type SkillManifest = {
  name: string;
  description: string;
  when_to_use: string;
  mode: SkillMode;
  forkOptions?: SkillForkOptions;
};
```

（`SkillRecord = SkillManifest & { content: string }` 保持不变——mode/forkOptions 自动随之进入 `listSkills`/`loadSkill` 的返回值，决策 5 天然满足。）

### 3.3 重构 parseFrontmatter 支持一层嵌套（第 41-89 行）

把现有整个 `parseFrontmatter` 函数替换为下面这段。**注意：这是完整替换，逐字使用，不要自己改写：**

```typescript
// --- Frontmatter parser (hand-rolled, zero runtime deps) ---

/** 解析单个值：去引号、数组 [a, b]。嵌套字段复用同一逻辑。 */
function parseValue(value: string): unknown {
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }

  // Handle arrays: [item1, item2]
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => {
      const t = item.trim();
      if ((t.startsWith('"') && t.endsWith('"')) ||
          (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    });
  }

  return value;
}

function parseFrontmatter(markdown: string): ParsedMarkdown {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, content: markdown };

  const raw = match[1];
  const content = markdown.slice(match[0].length);
  const frontmatter: Record<string, unknown> = {};

  // Parse line-by-line: key: value  |  key: [item, ...]  |  key:\n  nested: value（仅支持一层嵌套）
  const lines = raw.split('\n');
  let nestedKey: string | null = null;
  let nested: Record<string, unknown> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    const isIndented = /^\s+\S/.test(line);

    if (isIndented && nestedKey !== null && nested !== null) {
      // 嵌套字段（forkOptions 下的 provider/maxTurns/...）
      nested[key] = parseValue(value);
      continue;
    }

    // 顶层字段
    if (!value) {
      // 值为空——可能是一层嵌套对象的开始（如 "forkOptions:"）
      nestedKey = key;
      nested = {};
      frontmatter[key] = nested;
      continue;
    }

    nestedKey = null;
    nested = null;
    frontmatter[key] = parseValue(value);
  }

  return { frontmatter, content };
}
```

**自查**：改完后 `when_to_use:`（顶层、空值、无后续缩进行）会被解析成 `{}`。这没问题——`validateSkillManifest` 里 `typeof frontmatter.when_to_use === 'string'` 会把 `{}` 归为 `''`，和原来"缺失"行为一致。

### 3.4 扩展 validateSkillManifest（第 93-113 行）

在现有 `when_to_use` 校验之后、`return { name, description, when_to_use };` 之前，插入 mode/forkOptions 校验。即把函数末尾：

```typescript
  const when_to_use = typeof frontmatter.when_to_use === 'string' ? frontmatter.when_to_use : '';
  if (when_to_use.length > WHEN_TO_USE_MAX) {
    console.warn(`[skills] "when_to_use" exceeds ${WHEN_TO_USE_MAX} chars in ${sourcePath}`);
    return null;
  }

  return { name, description, when_to_use };
```

替换为：

```typescript
  const when_to_use = typeof frontmatter.when_to_use === 'string' ? frontmatter.when_to_use : '';
  if (when_to_use.length > WHEN_TO_USE_MAX) {
    console.warn(`[skills] "when_to_use" exceeds ${WHEN_TO_USE_MAX} chars in ${sourcePath}`);
    return null;
  }

  // ADR-0010 决策 2/11：mode 校验，缺省 inline
  let mode: SkillMode = 'inline';
  if (frontmatter.mode !== undefined) {
    if (typeof frontmatter.mode === 'string' && (SKILL_MODES as readonly string[]).includes(frontmatter.mode)) {
      mode = frontmatter.mode as SkillMode;
    } else {
      console.warn(`[skills] Invalid "mode" (must be inline|fork) in ${sourcePath}`);
      return null;
    }
  }

  // ADR-0010 决策 6/11：forkOptions 校验（解析器产出字符串/数组，此处 coerce 为语义类型）
  let forkOptions: SkillForkOptions | undefined;
  if (frontmatter.forkOptions !== undefined) {
    if (typeof frontmatter.forkOptions !== 'object' || frontmatter.forkOptions === null || Array.isArray(frontmatter.forkOptions)) {
      console.warn(`[skills] "forkOptions" must be a nested object in ${sourcePath}`);
      return null;
    }
    const raw = frontmatter.forkOptions as Record<string, unknown>;
    const parsed: SkillForkOptions = {};

    for (const key of ['deliverables', 'acceptanceCriteria', 'constraints'] as const) {
      if (raw[key] !== undefined) {
        if (!Array.isArray(raw[key]) || !(raw[key] as unknown[]).every((item) => typeof item === 'string')) {
          console.warn(`[skills] "forkOptions.${key}" must be a string array in ${sourcePath}`);
          return null;
        }
        parsed[key] = raw[key] as string[];
      }
    }

    if (raw.provider !== undefined) {
      if (typeof raw.provider !== 'string' || !(FORK_PROVIDERS as readonly string[]).includes(raw.provider)) {
        console.warn(`[skills] "forkOptions.provider" must be one of ${FORK_PROVIDERS.join('/')} in ${sourcePath}`);
        return null;
      }
      parsed.provider = raw.provider as SkillForkOptions['provider'];
    }

    if (raw.model !== undefined) {
      if (typeof raw.model !== 'string' || !raw.model.trim()) {
        console.warn(`[skills] "forkOptions.model" must be a non-empty string in ${sourcePath}`);
        return null;
      }
      parsed.model = raw.model;
    }

    for (const key of ['maxTurns', 'timeoutSec'] as const) {
      if (raw[key] !== undefined) {
        const num = typeof raw[key] === 'number' ? (raw[key] as number) : Number(raw[key]);
        const [min, max] = key === 'maxTurns' ? [MAX_TURNS_MIN, MAX_TURNS_MAX] : [TIMEOUT_SEC_MIN, TIMEOUT_SEC_MAX];
        if (!Number.isInteger(num) || num < min || num > max) {
          console.warn(`[skills] "forkOptions.${key}" must be an integer ${min}-${max} in ${sourcePath}`);
          return null;
        }
        parsed[key] = num;
      }
    }

    if (raw.readOnly !== undefined) {
      if (raw.readOnly === 'true' || raw.readOnly === true) parsed.readOnly = true;
      else if (raw.readOnly === 'false' || raw.readOnly === false) parsed.readOnly = false;
      else {
        console.warn(`[skills] "forkOptions.readOnly" must be true/false in ${sourcePath}`);
        return null;
      }
    }

    forkOptions = parsed;
  }

  return { name, description, when_to_use, mode, ...(forkOptions ? { forkOptions } : {}) };
```

### 3.5 readSkillFile 加"fork 空内容"警告（决策 11）

在 `readSkillFile` 函数里，现有代码：

```typescript
  const { frontmatter, content } = parseFrontmatter(raw);
  const manifest = validateSkillManifest(frontmatter, filePath);
  if (!manifest) return null;

  return { manifest, content: ensureTrailingNewline(content) };
```

改为（加中间三行）：

```typescript
  const { frontmatter, content } = parseFrontmatter(raw);
  const manifest = validateSkillManifest(frontmatter, filePath);
  if (!manifest) return null;

  // ADR-0010 决策 11：fork 但 content 为空 → 警告（不阻止）
  if (manifest.mode === 'fork' && !content.trim()) {
    console.warn(`[skills] ${filePath}: mode is "fork" but content is empty`);
  }

  return { manifest, content: ensureTrailingNewline(content) };
```

### 3.6 确认 listSkills / loadSkill 不需要改

读一遍第 160-190 行（`listSkills` / `loadSkill`）。它们的返回值类型是 `SkillManifest[]` / `SkillRecord | null`，`SkillManifest` 已带 mode/forkOptions，**无需任何改动**。如果你的 diff 里碰了这两个函数，说明你改错了，回退。

### 3.7 typecheck + build

```bash
bun run typecheck && bun run build
```

必须全绿。常见错误：忘改 `return` 语句的类型、常量拼写。修好再继续。

---

## 第 4 步：写测试 test/skills-v2.test.mjs（新建）

**逐字创建以下文件**（路径：`test/skills-v2.test.mjs`）：

```javascript
// ADR-0010 skill v2 数据层测试——skills.ts mode/forkOptions 解析与校验
// 覆盖决策：2（frontmatter 声明 mode）、5（list 带 mode）、6（forkOptions）、11（校验）
// 目标：src/skills.ts 行覆盖率 ≥ 90%；变异体 7/7 被杀死
//
// 变异体清单：
//   M1 mode 缺省值被改成 'fork'        → 用例 02 杀
//   M2 maxTurns 上限 200 改成 201      → 用例 07 杀
//   M3 provider 白名单校验被删         → 用例 06 杀
//   M4 数字字符串 coerce 被删          → 用例 05 杀（'30' 不再是 number 30）
//   M5 全局覆盖项目级优先级反转        → 用例 12 杀
//   M6 readOnly 'true' 解析反转        → 用例 05 杀
//   M7 fork 空 content 从警告变阻止    → 用例 10 杀

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { listSkills, loadSkill } from '../dist/skills.js';

// ── 测试辅助 ──

function tempDirs() {
  const root = join(tmpdir(), 'skills-v2-' + randomBytes(4).toString('hex'));
  const configDir = join(root, 'config');       // 全局 skills 在 <configDir>/skills/<name>/SKILL.md
  const workspaceDir = join(root, 'workspace'); // 项目级在 <workspaceDir>/.myterminal/skills/<name>/SKILL.md
  mkdirSync(join(configDir, 'skills'), { recursive: true });
  mkdirSync(join(workspaceDir, '.myterminal', 'skills'), { recursive: true });
  return { root, configDir, workspaceDir };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

/** 写一个项目级 skill */
function writeProjectSkill(workspaceDir, name, markdown) {
  const dir = join(workspaceDir, '.myterminal', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8');
}

/** 写一个全局 skill */
function writeGlobalSkill(configDir, name, markdown) {
  const dir = join(configDir, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), markdown, 'utf8');
}

const VALID_HEADER = (name, extra = '') => `---
name: ${name}
description: A valid test skill for ADR-0010.
when_to_use: Use in tests.
${extra}---
`;

// ══════════════════════════════════════════════════════
// 用例 01-03：mode 解析（决策 2/11）
// ══════════════════════════════════════════════════════

test('01: 缺省 mode 为 inline', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'demo-skill', VALID_HEADER('demo-skill') + '\nDo the thing.\n');
  const record = loadSkill(configDir, workspaceDir, 'demo-skill');
  assert.ok(record);
  assert.equal(record.mode, 'inline');
  assert.equal(record.forkOptions, undefined);
  cleanup(root);
});

test('02: mode: fork 正确解析', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'fork-skill', VALID_HEADER('fork-skill', 'mode: fork\n') + '\nStep 1.\n');
  const record = loadSkill(configDir, workspaceDir, 'fork-skill');
  assert.ok(record);
  assert.equal(record.mode, 'fork');
  cleanup(root);
});

test('03: 非法 mode 值 → loadSkill 返回 null', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'bad-mode', VALID_HEADER('bad-mode', 'mode: remote\n') + '\nX.\n');
  const record = loadSkill(configDir, workspaceDir, 'bad-mode');
  assert.equal(record, null);
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 用例 04-09：forkOptions 解析与校验（决策 6/11）
// ══════════════════════════════════════════════════════

test('04: forkOptions 全字段正确解析', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  const fm = `mode: fork
forkOptions:
  provider: deepseek
  model: deepseek-chat
  maxTurns: 30
  timeoutSec: 600
  readOnly: true
  deliverables: [code, tests]
  acceptanceCriteria: [green]
  constraints: [no-network]
`;
  writeProjectSkill(workspaceDir, 'full-opts', VALID_HEADER('full-opts', fm) + '\nWork.\n');
  const record = loadSkill(configDir, workspaceDir, 'full-opts');
  assert.ok(record);
  assert.equal(record.mode, 'fork');
  assert.deepEqual(record.forkOptions, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxTurns: 30,
    timeoutSec: 600,
    readOnly: true,
    deliverables: ['code', 'tests'],
    acceptanceCriteria: ['green'],
    constraints: ['no-network'],
  });
  // 类型必须被 coerce：maxTurns/timeoutSec 是 number，不是字符串
  assert.equal(typeof record.forkOptions.maxTurns, 'number');
  assert.equal(typeof record.forkOptions.timeoutSec, 'number');
  assert.equal(typeof record.forkOptions.readOnly, 'boolean');
  cleanup(root);
});

test('05: 字符串数字 coerce + readOnly 解析（杀 M4/M6）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  const fm = `mode: fork
forkOptions:
  maxTurns: "30"
  readOnly: "true"
`;
  writeProjectSkill(workspaceDir, 'coerce-opts', VALID_HEADER('coerce-opts', fm) + '\nWork.\n');
  const record = loadSkill(configDir, workspaceDir, 'coerce-opts');
  assert.ok(record);
  assert.equal(record.forkOptions.maxTurns, 30);
  assert.equal(record.forkOptions.readOnly, true);
  cleanup(root);
});

test('06: forkOptions.provider 非法 → null（杀 M3）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  const fm = `mode: fork
forkOptions:
  provider: moonshot
`;
  writeProjectSkill(workspaceDir, 'bad-provider', VALID_HEADER('bad-provider', fm) + '\nWork.\n');
  assert.equal(loadSkill(configDir, workspaceDir, 'bad-provider'), null);
  cleanup(root);
});

test('07: maxTurns 越界 0 和 201 → null（杀 M2）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  for (const [name, turns] of [['turns-low', 0], ['turns-high', 201]]) {
    const fm = `mode: fork\nforkOptions:\n  maxTurns: ${turns}\n`;
    writeProjectSkill(workspaceDir, name, VALID_HEADER(name, fm) + '\nWork.\n');
    assert.equal(loadSkill(configDir, workspaceDir, name), null, `maxTurns=${turns} should be rejected`);
  }
  // 边界值合法
  for (const [name, turns] of [['turns-min', 1], ['turns-max', 200]]) {
    const fm = `mode: fork\nforkOptions:\n  maxTurns: ${turns}\n`;
    writeProjectSkill(workspaceDir, name, VALID_HEADER(name, fm) + '\nWork.\n');
    assert.ok(loadSkill(configDir, workspaceDir, name), `maxTurns=${turns} should be accepted`);
  }
  cleanup(root);
});

test('08: timeoutSec 越界 29 和 3601 → null；30/3600 合法', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  for (const [name, sec, ok] of [['sec-low', 29, false], ['sec-high', 3601, false], ['sec-min', 30, true], ['sec-max', 3600, true]]) {
    const fm = `mode: fork\nforkOptions:\n  timeoutSec: ${sec}\n`;
    writeProjectSkill(workspaceDir, name, VALID_HEADER(name, fm) + '\nWork.\n');
    assert.equal(loadSkill(configDir, workspaceDir, name) !== null, ok, `timeoutSec=${sec}`);
  }
  cleanup(root);
});

test('09: forkOptions 非嵌套对象 → null', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'flat-opts', VALID_HEADER('flat-opts', 'mode: fork\nforkOptions: yes\n') + '\nWork.\n');
  assert.equal(loadSkill(configDir, workspaceDir, 'flat-opts'), null);
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 用例 10-12：决策 11 警告 / list 带 mode / 全局优先
// ══════════════════════════════════════════════════════

test('10: mode: fork 但 content 为空 → 仍加载成功（只警告，杀 M7）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'empty-fork', VALID_HEADER('empty-fork', 'mode: fork\n'));
  const record = loadSkill(configDir, workspaceDir, 'empty-fork');
  assert.ok(record, 'fork with empty content must still load (warning only)');
  assert.equal(record.mode, 'fork');
  cleanup(root);
});

test('11: listSkills 返回带 mode 字段（决策 5）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'inline-one', VALID_HEADER('inline-one') + '\nA.\n');
  writeProjectSkill(workspaceDir, 'fork-one', VALID_HEADER('fork-one', 'mode: fork\n') + '\nB.\n');
  const skills = listSkills(configDir, workspaceDir);
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(byName['inline-one'].mode, 'inline');
  assert.equal(byName['fork-one'].mode, 'fork');
  cleanup(root);
});

test('12: 同名 skill 全局覆盖项目级，mode 也来自全局（杀 M5）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'dup-skill', VALID_HEADER('dup-skill') + '\nProject version.\n');
  writeGlobalSkill(configDir, 'dup-skill', VALID_HEADER('dup-skill', 'mode: fork\n') + '\nGlobal version.\n');
  const record = loadSkill(configDir, workspaceDir, 'dup-skill');
  assert.ok(record);
  assert.equal(record.mode, 'fork');
  assert.match(record.content, /Global version/);
  const listed = listSkills(configDir, workspaceDir).find((s) => s.name === 'dup-skill');
  assert.equal(listed.mode, 'fork');
  cleanup(root);
});

// ══════════════════════════════════════════════════════
// 用例 13-14：回归——原有行为不破坏
// ══════════════════════════════════════════════════════

test('13: 无 frontmatter 的文件 → null（原有校验不变）', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  writeProjectSkill(workspaceDir, 'no-front', 'Just markdown, no frontmatter.\n');
  assert.equal(loadSkill(configDir, workspaceDir, 'no-front'), null);
  cleanup(root);
});

test('14: 不存在的 skill → null', () => {
  const { root, configDir, workspaceDir } = tempDirs();
  assert.equal(loadSkill(configDir, workspaceDir, 'ghost-skill'), null);
  cleanup(root);
});
```

## 第 5 步：跑测试 + 覆盖率

```bash
bun run build && bun test --timeout 120000 test/skills-v2.test.mjs
```

14 个用例必须全绿。然后覆盖率：

```bash
bun test --timeout 120000 --coverage test/skills-v2.test.mjs
```

在输出中找到 `skills.ts` 行：`File % Lines` 必须 **≥ 90%**。如果不达标，看哪些行没覆盖（常见：`scanDir` 的 readdirSync catch 分支、MAX_SKILL_BYTES 分支——如果差这几行导致低于 90%，补 1-2 个用例：写一个 >100KB 的 SKILL.md 断言被跳过；listSkills 传不存在的目录断言返回空数组）。

**变异体自查**（逐个在脑中过一遍：如果我故意引入这个 bug，哪个用例会挂？7 个变异体都必须有答案，答案写在文件头注释里——已写好，验证它们真的成立）。

## 第 6 步：回归确认不破坏现有测试

```bash
bun test --timeout 120000 test/myterminal.test.mjs test/subagent-m8.test.mjs
```

必须全绿（本任务只改了 skills.ts 纯数据层，不应影响任何现有行为；`SkillManifest` 加了必填字段 `mode`，但所有构造路径都经过 `validateSkillManifest`，必然带 mode）。

## 第 7 步：提交

```bash
git add src/skills.ts test/skills-v2.test.mjs
git commit -m "feat(skills): ADR-0010 数据层——mode/forkOptions 解析与校验

- SkillManifest 加 mode（缺省 inline）+ 可选 forkOptions（决策 2/5/6）
- parseFrontmatter 重构：抽 parseValue，支持一层嵌套对象
- validateSkillManifest 扩展：mode 枚举、provider 白名单、
  maxTurns 1-200、timeoutSec 30-3600、readOnly 布尔、数组字段校验（决策 11）
- fork 空内容警告不阻止（决策 11）
- test/skills-v2.test.mjs：14 用例，7 变异体全杀"
```

## 验收清单（全部打勾才算完成）

- [ ] 第 0 步分支检查通过，全程在 `feat/skills`
- [ ] 基线 2 个 commit 已提交（GLM 接入 + ADR 文档），工作区干净（除 overview.md）
- [ ] `src/skills.ts` 按 3.1-3.6 改完，`listSkills`/`loadSkill` 未被触碰
- [ ] `bun run typecheck && bun run build` 全绿
- [ ] `test/skills-v2.test.mjs` 14 用例全绿，skills.ts 行覆盖率 ≥ 90%
- [ ] `test/myterminal.test.mjs` + `test/subagent-m8.test.mjs` 回归全绿
- [ ] 本任务 commit 已提交，`git log --oneline -3` 可见 3 个新 commit

## 禁止事项（再强调）

- 🚫 禁止引入 YAML 库或任何新依赖
- 🚫 禁止把 coerce 逻辑塞进 parseFrontmatter（它只产结构）
- 🚫 禁止改 `listSkills`/`loadSkill` 函数体
- 🚫 禁止 `git add -A` / `git add .`
- 🚫 禁止在 main 分支做任何事
