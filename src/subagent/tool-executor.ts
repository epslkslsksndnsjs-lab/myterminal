// ADR-0007 决策 18：工具并行执行器——isConcurrencySafe + 批次策略 + 并行度上限 5
// ADR-0007 决策 18/30 Bug 4：sibling abort 在并行批次，串行批次保留链中断
// ADR-0007 决策 19：消息组预算——enforceMessageBudget + ensureNonEmpty
// ADR-0007 决策 31：isConcurrencySafe 函数化——分区时用实际 input 求值
// ADR-0007 决策 37：配对保证——执行端保证每个 tool_use 有 tool_result（不 crash）
// ADR-0007 决策 38：两层校验——schema + validateInput
// ADR-0007 决策 39：审计日志——已随 ADR-0048 #161 死通道删净（T6 砍读端后写端零消费）
// ADR-0007 决策 40：Pre/Post Hooks——v1 空数组但接口支撑

import type { JsonObject, JsonSchema } from '../types.js';
import { getTool, getToolNames } from './tools.js';
import type { SubagentTool, SubagentToolContext } from './tools.js';
import { enforceMessageBudget, ensureNonEmpty } from './result-budget.js';
import type { ToolResult } from './result-budget.js';

// ── 常量 ──

/** 决策 18：并行度上限——防止 20 个 glob 打爆文件系统 */
const MAX_PARALLEL = 5;

// ── 类型 ──

export type ToolCall = { id: string; name: string; input: JsonObject };

type Batch = { isConcurrencySafe: boolean; calls: ToolCall[] };

type SchemaError = { path: string; message: string };

// ── Step 1：轻量 schema 校验器（决策 38）──────────────────────────

/**
 * 轻量 schema 校验——不实现完整 JSON Schema，仅 4 类校验：
 * ① required 缺失
 * ② type 不匹配（string/number/boolean/object/array）
 * ③ enum 越界
 * ④ minLength 不满足
 *
 * 不引入 ajv——subagent 工具 inputSchema 足够简单，4 类覆盖所有场景。
 */
export function validateSchema(input: JsonObject, schema: JsonSchema, path = ''): { ok: boolean; errors: SchemaError[] } {
  const errors: SchemaError[] = [];

  // ① required 缺失
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in input) || input[key] === undefined) {
        errors.push({ path: path ? `${path}.${key}` : key, message: `The required parameter '${key}' is missing` });
      }
    }
  }

  if (!schema.properties) return { ok: errors.length === 0, errors };

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const value = input[key];
    if (value === undefined) continue; // 未提供，由 required 检查统一报

    const propPath = path ? `${path}.${key}` : key;

    // ② type 不匹配
    if (propSchema.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== propSchema.type) {
        errors.push({
          path: propPath,
          message: `The parameter '${key}' type is expected as '${propSchema.type}' but provided as '${actualType}'`,
        });
        continue; // 类型错则跳过后续此 key 的检查
      }
    }

    // ③ enum 越界
    if (propSchema.enum) {
      if (!propSchema.enum.includes(value)) {
        const allowed = propSchema.enum.map((v: unknown) => JSON.stringify(v)).join(', ');
        errors.push({
          path: propPath,
          message: `The parameter '${key}' value ${JSON.stringify(value)} is not in the allowed values: [${allowed}]`,
        });
      }
    }

    // ④ minLength 不满足
    if (propSchema.minLength !== undefined && typeof value === 'string') {
      if (value.length < propSchema.minLength) {
        errors.push({
          path: propPath,
          message: `The parameter '${key}' must be at least ${propSchema.minLength} characters long`,
        });
      }
    }

    // 递归检查嵌套 object
    if (propSchema.type === 'object' && propSchema.properties && typeof value === 'object' && value !== null) {
      const nested = validateSchema(value as JsonObject, propSchema, propPath);
      errors.push(...nested.errors);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * LLM 友好格式——让模型看到具体哪个参数、什么问题，方便自我纠正。
 * 多个错误用换行连接。
 *
 * 决策 38：不是 Zod 原始错误，而是直接告诉 LLM 怎么改。
 */
export function formatSchemaError(errors: SchemaError[], toolName: string): string {
  const header = `Schema validation failed for tool "${toolName}":\n`;
  const body = errors.map((e) => `  - ${e.message}`).join('\n');
  return header + body;
}

// ── Step 2：分批算法 partitionToolCalls（决策 18 + 31）───────────

/**
 * 将 LLM 一轮返回的 tool_use 列表按并发安全性分批。
 *
 * 规则：
 * - 未知工具 → 打断当前批，单独成非并发批（执行时报 Unknown tool）
 * - isConcurrencySafe 是函数 → 用 call.input 求值；是布尔 → 直接用
 * - 连续并发安全的收进当前并发批次（满 MAX_PARALLEL 开新批）
 * - 连续非并发安全的收进同一串行批次（支持链中断语义）
 * - 并发 ↔ 非并发切换 → 新开批
 *
 * **不复制 call 对象**（保持对象引用），后续用 ID 映射回原始 index 更可靠。
 */
export function partitionToolCalls(calls: ToolCall[]): Batch[] {
  const batches: Batch[] = [];

  for (const call of calls) {
    const tool = getTool(call.name);

    if (!tool) {
      // 未知工具——打断当前批，单独成批
      batches.push({ isConcurrencySafe: false, calls: [call] });
      continue;
    }

    // 决策 31：isConcurrencySafe 函数化——求值时机在分区时
    // ADR-0017: try/catch 防崩溃——非法输入降级为非并发安全，走单条执行→schema 校验拒绝
    let concurrencySafe: boolean;
    try {
      concurrencySafe = typeof tool.isConcurrencySafe === 'function'
        ? tool.isConcurrencySafe(call.input)
        : tool.isConcurrencySafe;
    } catch {
      concurrencySafe = false;
    }

    const lastBatch = batches.length > 0 ? batches[batches.length - 1] : undefined;

    if (concurrencySafe) {
      // 并发安全——尝试合并到上一个并发批次
      if (lastBatch?.isConcurrencySafe && lastBatch.calls.length < MAX_PARALLEL) {
        lastBatch.calls.push(call);
      } else {
        batches.push({ isConcurrencySafe: true, calls: [call] });
      }
    } else {
      // 非并发安全——合并到上一个非并发批次（支持链中断）
      if (lastBatch && !lastBatch.isConcurrencySafe) {
        lastBatch.calls.push(call);
      } else {
        batches.push({ isConcurrencySafe: false, calls: [call] });
      }
    }
  }

  return batches;
}

// ── Step 3：单工具执行 executeSingleTool（决策 38 + 39 + 40）─────

/**
 * 执行单个工具调用——含完整的校验/权限/hooks/审计管道。
 *
 * 校验顺序（决策 38）：schema → validateInput → checkPermissions → pre-hooks → 执行 → post-hooks → 审计
 * 任何一步失败都返回 is_error: true 的 ToolResult 并写审计日志，不直接 throw。
 *
 * @param call 工具调用
 * @param ctx subagent 上下文
 * @param onEvent AG-UI 事件回调（M7 executor 注入，本模块不 import tui-bridge）
 * @param siblingSignal 并行兄弟工具的 abort 信号（串行批次不传）
 * @returns ToolResult——始终返回，不 throw
 */
async function executeSingleTool(
  call: ToolCall,
  ctx: SubagentToolContext,
  onEvent: (event: { type: string; data?: unknown }) => void,
  siblingSignal?: AbortSignal,
): Promise<ToolResult> {
  let errorMessage: string | undefined = undefined;

  try {
    // ① 未知工具（决策 3：名字对不上注册表）
    const tool = getTool(call.name);
    if (!tool) {
      errorMessage = `Unknown tool: ${call.name}`;
      const result: ToolResult = { tool_use_id: call.id, content: errorMessage, is_error: true };
      return result;
    }

    // ADR-0014: 只读执行层硬门禁——readOnly 模式下拒绝非只读工具
    if (ctx.readOnly && !getToolNames({ readOnly: true }).includes(call.name)) {
      errorMessage = `Tool "${call.name}" is not allowed in read-only mode.`;
      const result: ToolResult = { tool_use_id: call.id, content: errorMessage, is_error: true };
      return result;
    }

    // ② schema 校验（决策 38 第 1 层）
    const schemaResult = validateSchema(call.input, tool.inputSchema);
    if (!schemaResult.ok) {
      errorMessage = formatSchemaError(schemaResult.errors, call.name);
      const result: ToolResult = { tool_use_id: call.id, content: errorMessage, is_error: true };
      return result;
    }

    // ③ validateInput 语义校验（决策 38 第 2 层 / 决策 31）
    if (tool.validateInput) {
      const validation = tool.validateInput(call.input, ctx);
      if (!validation.ok) {
        errorMessage = validation.message ?? `Input validation failed for tool "${call.name}"`;
        const result: ToolResult = { tool_use_id: call.id, content: errorMessage, is_error: true };
        return result;
      }
    }

    // ④ 权限检查（决策 17 第 2-3 层）
    if (tool.checkPermissions) {
      const decision = tool.checkPermissions(call.input, ctx);
      if (decision === 'deny') {
        errorMessage = `Permission denied for tool "${call.name}" — command blocked by safety rules.`;
        const result: ToolResult = { tool_use_id: call.id, content: errorMessage, is_error: true };
        return result;
      }
    }

    // ⑤ preToolUseHooks（决策 40）
    let effectiveInput = call.input;
    if (ctx.preToolUseHooks && ctx.preToolUseHooks.length > 0) {
      for (const hook of ctx.preToolUseHooks) {
        if (!hook.before) continue;
        const hookResult = await hook.before(effectiveInput, ctx);
        if (!hookResult) continue;

        if (hookResult.blockExecution) {
          errorMessage = `Tool execution blocked by pre-hook "${hook.name}"`;
          const result: ToolResult = { tool_use_id: call.id, content: errorMessage, is_error: true };
          return result;
        }

        if (hookResult.modifiedInput) {
          effectiveInput = hookResult.modifiedInput;
        }
      }
    }

    // ⑥ AG-UI 事件：TOOL_CALL_START / TOOL_CALL_ARGS（决策 8 ADR-0008）
    onEvent({ type: 'TOOL_CALL_START', data: { name: call.name, id: call.id } });
    onEvent({ type: 'TOOL_CALL_ARGS', data: { id: call.id, input: effectiveInput } });

    // ⑦ 执行——合并 sibling signal（如果提供）
    const execCtx: SubagentToolContext = siblingSignal
      ? { ...ctx, signal: AbortSignal.any([ctx.signal, siblingSignal]) }
      : ctx;

    const rawResult = await tool.call(effectiveInput, execCtx);
    let finalResult = rawResult;

    // ⑧ postToolUseHooks（决策 40）
    if (ctx.postToolUseHooks && ctx.postToolUseHooks.length > 0) {
      for (const hook of ctx.postToolUseHooks) {
        if (!hook.after) continue;
        const hookResult = await hook.after(finalResult, ctx);
        if (hookResult?.modifiedResult) {
          finalResult = hookResult.modifiedResult;
        }
      }
    }

    // ⑨ AG-UI 事件：TOOL_CALL_RESULT
    const content = JSON.stringify(finalResult);
    const isError = finalResult.is_error === true;

    onEvent({ type: 'TOOL_CALL_RESULT', data: { id: call.id, result: finalResult } });

    if (isError) {
      errorMessage = content.slice(0, 500); // 截断错误内容
    }

    return { tool_use_id: call.id, content, is_error: isError };

  } catch (err) {
    // ⑩ 决策 21：工具崩溃包装成 tool_result（不 crash agent loop）
    errorMessage = (err as Error).message ?? 'Unknown error';
    const content = `Tool execution failed: ${errorMessage}`;

    onEvent({ type: 'TOOL_CALL_RESULT', data: { id: call.id, error: errorMessage } });

    return { tool_use_id: call.id, content, is_error: true };
  }
}

// ── Step 4：批量执行 executeToolCalls（决策 18 + Bug 4 修复）─────

/**
 * 执行 LLM 一轮返回的所有工具调用——
 * 自动按并发安全性分批，并行批次用 sibling abort，串行批次用链中断。
 *
 * **Bug 4 修复**：sibling abort 在并行批次（一个失败取消正在跑的兄弟），
 * 串行批次保留"链中断"（写工具失败后跳过后续调用）。
 *
 * 结果顺序 = 调用顺序（决策 18：不打乱）。
 *
 * @param calls LLM 返回的 tool_use 列表
 * @param ctx subagent 上下文
 * @param onEvent AG-UI 事件回调
 * @returns ToolResult[] 按原始调用顺序排列，已应用消息组预算和空结果保护
 */
export async function executeToolCalls(
  calls: ToolCall[],
  ctx: SubagentToolContext,
  onEvent: (event: { type: string; data?: unknown }) => void,
): Promise<ToolResult[]> {
  if (calls.length === 0) return [];

  const batches = partitionToolCalls(calls);
  const results: ToolResult[] = new Array(calls.length);

  // 用 ID 映射确保结果顺序 = 调用顺序（比 indexOf 更可靠，不依赖对象引用）
  const indexMap = new Map<string, number>();
  calls.forEach((c, i) => indexMap.set(c.id, i));

  for (const batch of batches) {
    if (batch.isConcurrencySafe && batch.calls.length > 1) {
      // ── 并行批次（Bug 4 修复：sibling abort 在这里）──
      const siblingController = new AbortController();

      const batchResults = await Promise.all(
        batch.calls.map((call) =>
          executeSingleTool(call, ctx, onEvent, siblingController.signal).then((r) => {
            // 并行兄弟失败 → 取消其余正在跑的（已完成的不受影响）
            if (r.is_error) {
              siblingController.abort('sibling_error');
            }
            return r;
          }),
        ),
      );

      // 映射回原始 index（结果顺序 = 调用顺序）
      for (let i = 0; i < batch.calls.length; i++) {
        const originalIndex = indexMap.get(batch.calls[i].id)!;
        results[originalIndex] = batchResults[i];
      }

    } else {
      // ── 串行批次（含独占工具）──
      for (let bi = 0; bi < batch.calls.length; bi++) {
        const call = batch.calls[bi];
        const result = await executeSingleTool(call, ctx, onEvent);

        const originalIndex = indexMap.get(call.id)!;
        results[originalIndex] = result;

        // 串行链中断：写工具（isReadOnly=false）失败 → 后续调用不再执行
        if (result.is_error) {
          const tool = getTool(call.name);
          if (tool && tool.isReadOnly === false) {
            // 为剩余 calls 填 Skipped 结果
            for (let sj = bi + 1; sj < batch.calls.length; sj++) {
              const skippedCall = batch.calls[sj];
              const skippedIndex = indexMap.get(skippedCall.id)!;
              results[skippedIndex] = {
                tool_use_id: skippedCall.id,
                content: `Skipped: previous tool "${call.name}" failed`,
                is_error: true,
              };
            }
            break;
          }
        }
      }
    }
  }

  // 决策 19：消息组预算（Bug 1 修复版——先应用冻结决策再做新预算检查）
  const budgeted = enforceMessageBudget(results, ctx.agentId);

  // 决策 19：空结果保护——空 tool_result 导致某些模型误判 turn 边界
  for (const r of budgeted) {
    r.content = ensureNonEmpty(r.content, 'tool');
  }

  return budgeted;
}
