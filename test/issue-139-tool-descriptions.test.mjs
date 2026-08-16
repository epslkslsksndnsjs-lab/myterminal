// ADR-0048 T8（#139）：8 工具描述增厚（D9）——三块化契约测试
//
// 验收覆盖（对应 #139 Acceptance criteria）：
//   AC1 8 工具描述全部三块化（# Boundaries / # Discipline / # Failures），≤240 行/工具
//   AC2 execute_cli 描述含 T3 定案的双模式/转后台/落盘语义与边界（默认 120s / 上限 600s）
//   AC3 task 工具描述含 blocked 语义 + subject 进度句纪律（父观察进度唯一窗口）；
//       task_create subject schema 带 maxLength 120
//   AC4 系统提示词工具清单拼接不受影响（8 工具名不变、不新增工具）
//
// 测试方式：直接驱动 getAllToolSchemas()（../dist/subagent/tools.js）+
// getSubagentSystemPrompt/getToolNames（../dist/subagent/executor.js）。

import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { getAllToolSchemas, getToolNames } from '../dist/subagent/tools.js';
import { getSubagentSystemPrompt } from '../dist/subagent/executor.js';

const DESCRIPTIONS = () => getAllToolSchemas();
const TOOL_NAMES = ['execute_cli', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'task_create', 'task_update'];

function descOf(name) {
  const tool = DESCRIPTIONS().find((t) => t.name === name);
  assert.ok(tool, `工具 ${name} 存在`);
  return tool.description;
}

// ═══════════════════════════════════════════════════════════════
// AC1：8 工具全三块化 + ≤240 行
// ═══════════════════════════════════════════════════════════════

test('T8-AC1a: 8 工具名不变、不新增（系统提示词拼接基础）', () => {
  const schemas = DESCRIPTIONS();
  assert.strictEqual(schemas.length, 8, '仍为 8 工具');
  assert.deepEqual(schemas.map((s) => s.name).sort(), [...TOOL_NAMES].sort(), '工具名集合不变');
});

test('T8-AC1b: 每工具描述含三块（Boundaries/Discipline/Failures）且 ≤240 行', () => {
  for (const name of TOOL_NAMES) {
    const desc = descOf(name);
    const lines = desc.split('\n');
    assert.ok(lines.length <= 240, `${name} 描述 ≤240 行（实际 ${lines.length}）`);
    for (const heading of ['# Boundaries', '# Discipline', '# Failures']) {
      assert.ok(desc.includes(heading), `${name} 描述含 ${heading}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════
// AC2：execute_cli 双模式/转后台/落盘 + 边界数字（照 T3 实现写实）
// ═══════════════════════════════════════════════════════════════

test('T8-AC2: execute_cli 描述含双模式语义与边界（120/600/backgroundId/outputPath/read_file）', () => {
  const desc = descOf('execute_cli');
  assert.ok(desc.includes('120'), '默认超时 120s');
  assert.ok(desc.includes('600'), '上限 600s');
  assert.ok(desc.includes('run_in_background'), '显式转后台参数');
  assert.ok(desc.includes('backgroundId'), '转后台返回 backgroundId');
  assert.ok(desc.includes('outputPath') || desc.includes('output file'), '输出落盘路径');
  assert.ok(desc.includes('read_file'), '引导用 read_file 读后台输出');
  assert.ok(desc.includes('sleep'), 'sleep 类命令超时杀（不转后台）例外');
  // 跨工具路由（D9：这种情况别用我，用 X）
  assert.ok(/glob|grep|read_file|write_file|edit_file/.test(desc), '指向专用工具的路由句');
});

// ═══════════════════════════════════════════════════════════════
// AC3：task 工具 blocked 语义 + 进度句纪律 + subject maxLength 120
// ═══════════════════════════════════════════════════════════════

test('T8-AC3a: task_create 描述含 subject 进度句纪律（父观察进度唯一窗口）+ blocked 语义句（O2 并入）', () => {
  const desc = descOf('task_create');
  assert.ok(/progress/.test(desc), '进度句纪律');
  assert.ok(/only window/.test(desc) || /唯一窗口/.test(desc), '「父观察进度的唯一窗口」纪律句');
  assert.ok(/subject/.test(desc), 'subject 写法指导');
  assert.ok(/blocked/.test(desc), 'blocked 语义句（O2：task_create 补一句）');
});

test('T8-AC3b: task_update 描述含 blocked 语义 + blockedReason ≤1000 + 状态机', () => {
  const desc = descOf('task_update');
  assert.ok(desc.includes('blocked'), 'blocked 语义');
  assert.ok(desc.includes('blockedReason'), 'blockedReason 必填');
  assert.ok(desc.includes('1000'), 'blockedReason ≤1000 字符');
  assert.ok(desc.includes('pending') && desc.includes('in_progress') && desc.includes('completed'), '状态机列全');
  assert.ok(/blocked → completed|blocked→completed|from blocked/.test(desc) || /blocked.*completed/.test(desc), 'blocked 近终态迁移');
});

test('T8-AC3c: task_create subject schema 带 maxLength 120', () => {
  const schemas = DESCRIPTIONS();
  const create = schemas.find((s) => s.name === 'task_create');
  assert.strictEqual(create.input_schema.properties.subject.maxLength, 120, 'subject maxLength=120');
});

// ═══════════════════════════════════════════════════════════════
// AC4：系统提示词工具清单拼接不受影响
// ═══════════════════════════════════════════════════════════════

test('T8-AC4: 系统提示词工具清单照旧（8 工具名列全、描述不进系统提示词）', () => {
  const names = getToolNames();
  assert.strictEqual(names.length, 8, 'getToolNames 仍 8 工具');
  const prompt = getSubagentSystemPrompt('probe task', names, '/tmp/ws');
  for (const name of TOOL_NAMES) {
    assert.ok(prompt.includes(`- ${name}`), `系统提示词含 ${name}`);
  }
  assert.ok(prompt.includes('Tools available:'), '工具清单头保留');
  // 描述不嵌入系统提示词（只列名）
  assert.ok(!prompt.includes('# Boundaries'), '描述正文不进系统提示词');
});
