// issue #146（ADR-0048 A48-W1 M2）—— OpenAPI ExtensionToolInput 共享属性池从单源派生
//
// 背景：openapi.ts 的 ExtensionToolInput 是独立手写 union 池，不从 BUILTIN_INPUT_SCHEMAS
// 派生——subagent_start 五主字段全缺、milestone 缺 maxLength、limit/maxBytes/startLine/
// endLine/timeoutSec/sha256 全无边界、两池各说各话（A48-W1 轴3#1 中危）。
//
// 方案：buildOpenApi 程序化聚合（union-widest）：池字段 = BUILTIN_INPUT_SCHEMAS 全部
// properties 的并集，每字段边界 = 各声明源的最宽合并（永不比任一工具更严）。
// 三个 facade 覆盖层保持手写：workspaceId（传输层，对齐 mcp.ts extraShape 先例）、
// nextCalls（策略感知 continuationPolicy）、task（$ref TaskPackage，TaskPackage 由
// session_register.task 单源派生）。
//
// 锁定分区：
//   [POOL-LOCK-1] 字段集合完整性：池 = 单源属性并集 ∪ 覆盖层（防字段腐烂/漂移）
//   [POOL-LOCK-2] never-stricter：池对任何工具都不比其单源更严（union 语义）
//   [AC-ANCHOR]  票 AC2/AC3 精确锚点：五主字段/milestone/边界字段逐字断言
//   [DERIVE]     TaskPackage 与 session_register.task 单源逐字一致
//   [OVERLAY]    覆盖层与 facade 约定（workspaceId/nextCalls/$ref）
//   [STALE]      单源没有的陈旧字段（pattern/include/exclude/maxResults）必须移除
//
// 变异体清单：
//   OPEN-1  聚合跳过 subagent_start 的 properties        → POOL-LOCK-1 + AC-ANCHOR 杀
//   OPEN-2  unionField 丢掉 maxLength/minLength 合并      → AC-ANCHOR（milestone/limit 等）杀
//   OPEN-3  TaskPackage 不再派生（退化成空对象）          → DERIVE 杀

import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { BUILTIN_INPUT_SCHEMAS } from '../dist/tool-schemas.js';
import { buildOpenApi } from '../dist/openapi.js';

const toolInput = () => buildOpenApi({ publicBaseUrl: 'http://127.0.0.1:0' }).components.schemas.ExtensionToolInput;
const props = () => toolInput().properties;

/** facade 覆盖层：聚合时不参与、由 buildOpenApi 手写补齐（见 openapi.ts 注释）。 */
const OVERLAYS = new Set(['workspaceId', 'nextCalls', 'task']);

// ─────────────────────────────────────────────────────────────────────────────
// [POOL-LOCK-1] 字段集合完整性
// ─────────────────────────────────────────────────────────────────────────────

test('[POOL-LOCK-1] 池字段集合 = 单源属性并集 ∪ 覆盖层（防字段腐烂/漂移）', () => {
  const expected = new Set(OVERLAYS);
  for (const schema of Object.values(BUILTIN_INPUT_SCHEMAS)) {
    for (const key of Object.keys(schema.properties ?? {})) expected.add(key);
  }
  assert.deepEqual(Object.keys(props()).sort(), [...expected].sort());
});

// ─────────────────────────────────────────────────────────────────────────────
// [POOL-LOCK-2] never-stricter：union 语义（池永不比任一工具的单源更严）
// ─────────────────────────────────────────────────────────────────────────────

/** 对整数/长度/条数边界与枚举做「池不比源更严」单向校验。 */
function assertNotStricter(poolField, sourceField, label) {
  assert.ok(poolField && typeof poolField === 'object', `${label}：池字段缺失`);
  assert.equal(poolField.type, sourceField.type, `${label}：type 漂移`);
  const ceil = (k, cmp) => {
    if (sourceField[k] === undefined || poolField[k] === undefined) return; // 池略去 = 更宽（union 语义），合法
    assert.ok(cmp(poolField[k], sourceField[k]), `${label}：${k} 池=${poolField[k]} 比源=${sourceField[k]} 更严`);
  };
  ceil('minimum', (p, s) => p <= s);
  ceil('maximum', (p, s) => p >= s);
  ceil('minLength', (p, s) => p <= s);
  ceil('maxLength', (p, s) => p >= s);
  ceil('minItems', (p, s) => p <= s);
  ceil('maxItems', (p, s) => p >= s);
  if (sourceField.enum !== undefined) {
    assert.ok(poolField.enum, `${label}：源有 enum 池却无`);
    for (const value of sourceField.enum) assert.ok(poolField.enum.includes(value), `${label}：enum 漏 ${value}`);
  }
  // 池声明了 default 时，必须与每个声明源一致（unanimous 规则）
  if (poolField.default !== undefined) {
    assert.deepEqual(poolField.default, sourceField.default, `${label}：池 default 与源不一致`);
  }
  if (sourceField.type === 'array') assertNotStricter(poolField.items, sourceField.items, `${label}.items`);
}

test('[POOL-LOCK-2] 池对每个工具的每个字段都不比其单源更严（union 语义）', () => {
  let checked = 0;
  for (const [tool, schema] of Object.entries(BUILTIN_INPUT_SCHEMAS)) {
    for (const [field, source] of Object.entries(schema.properties ?? {})) {
      if (OVERLAYS.has(field)) continue;
      assertNotStricter(props()[field], source, `${tool}.${field}`);
      checked += 1;
    }
  }
  assert.ok(checked > 40, `派生覆盖字段数异常：${checked}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// [AC-ANCHOR] 票 AC2/AC3 精确锚点
// ─────────────────────────────────────────────────────────────────────────────

test('[AC2] subagent_start 五主字段声明齐全、边界与单源一致', () => {
  assert.deepEqual(props().objective, { type: 'string', minLength: 1, maxLength: 4000 });
  // T2 #133 已砍 background 字段——单源池无此入参，断言 undefined 守护零复活
  assert.equal(props().background, undefined);
  // T2 #133 已砍 deliverables/acceptanceCriteria/constraints——单源池零复活守护
  for (const field of ['deliverables', 'acceptanceCriteria', 'constraints']) {
    assert.equal(props()[field], undefined, `${field} 已由 T2 砍除，不得复活`);
  }
});

test('[AC3] milestone maxLength 1000 与边界字段补齐', () => {
  assert.deepEqual(props().milestone, { type: 'string', maxLength: 1000 });
  assert.deepEqual(props().limit, { type: 'integer', minimum: 1, maximum: 96000 }); // #130 单源：SUBAGENT_STATUS_PAGE_MAX_CHARS
  assert.deepEqual(props().maxBytes, { type: 'integer', minimum: 1, maximum: 1_000_000 });
  assert.deepEqual(props().startLine, { type: 'integer', minimum: 1 });
  assert.deepEqual(props().endLine, { type: 'integer', minimum: 1 });
  assert.deepEqual(props().timeoutSec, { type: 'integer', minimum: 1, maximum: 86400 }); // T2 #133 上限放宽
  assert.deepEqual(props().sha256, { type: 'string', minLength: 64, maxLength: 64 });
  // 顺带补齐的边界（同源对齐）
  assert.deepEqual(props().command, { type: 'string', minLength: 1, maxLength: 20_000 });
  assert.equal(props().replacements.minItems, 1);
  assert.deepEqual(props().replacements.items.required, ['oldText', 'newText']);
  assert.equal(props().replacements.items.additionalProperties, false);
  assert.deepEqual(props().eventIds, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 });
  // name 与 skill 共享字段：skill 无 maxLength，union 取最宽略去（minLength 1 保留）
  assert.deepEqual(props().name, { type: 'string', minLength: 1 });
  assert.equal(props().role.maxLength, 80);
  assert.equal(props().body.maxLength, 20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// [DERIVE] TaskPackage 与 session_register.task 单源逐字一致
// ─────────────────────────────────────────────────────────────────────────────

test('[DERIVE] TaskPackage 由 session_register.task 派生，与单源逐字一致', () => {
  const taskPackage = buildOpenApi({ publicBaseUrl: 'http://127.0.0.1:0' }).components.schemas.TaskPackage;
  const source = BUILTIN_INPUT_SCHEMAS.session_register.properties.task;
  assert.deepEqual(taskPackage, source, 'TaskPackage 偏离 session_register.task 单源');
  assert.deepEqual(props().task, { $ref: '#/components/schemas/TaskPackage' });
});

// ─────────────────────────────────────────────────────────────────────────────
// [OVERLAY] 覆盖层与 facade 约定
// ─────────────────────────────────────────────────────────────────────────────

test('[OVERLAY] workspaceId 传输层覆盖层保留（root bootstrap 依赖）', () => {
  const field = props().workspaceId;
  assert.equal(field.type, 'string');
  assert.equal(field.minLength, 1);
  assert.match(field.description, /extensionDiscover/);
});

test('[OVERLAY] nextCalls 策略感知覆盖层保留（off 模式 1..3）', () => {
  const field = props().nextCalls;
  assert.equal(field.minItems, 1);
  assert.equal(field.maxItems, 3);
  assert.deepEqual(field.items, { $ref: '#/components/schemas/PlannedToolCall' });
});

test('[OVERLAY] 池仍是 catchall 语义：无 required、additionalProperties=true', () => {
  const input = toolInput();
  assert.equal(input.type, 'object');
  assert.ok(!('required' in input), '池不得有 required（catchall 语义）');
  assert.equal(input.additionalProperties, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// [STALE] 单源没有的陈旧字段必须移除
// ─────────────────────────────────────────────────────────────────────────────

test('[STALE] 单源没有的陈旧字段移除（pattern/include/exclude/maxResults）', () => {
  for (const stale of ['pattern', 'include', 'exclude', 'maxResults']) {
    assert.ok(!(stale in props()), `${stale} 已不在单源中，应从池移除`);
  }
  // ADR-0045 #04 契约在池里同样成立（与 CONTRACT-4 同锚）
  assert.ok(!('provider' in props()));
  assert.ok(!('model' in props()));
});
