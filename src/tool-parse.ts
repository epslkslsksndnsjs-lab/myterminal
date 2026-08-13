import type { InvocationContext, ShapingAudit, ToolDefinition, ToolResponse } from './types.js';
export type { ShapingAudit } from './types.js';

/**
 * ADR-0047 — 工具结果整形系统（L1 静态规则 / L2 执行 / L3 模型）。
 *
 * T01（#29）：整形系统骨架 + 接线。`TOOL_SHAPES` 空注册表 + `shapeToolResponse(response, ctx)`
 * 签名改造，所有工具响应经 shaper 后与未接线时逐字段一致（passthrough），建立零行为变化
 * 回归基线。T03 起由 L2 执行层填充路由、预算门、reducer 与双版本审计。
 */

/** 整形介入原因（D7/D11 权威枚举；T01 仅产生 passthrough） */
export type ShapingReason =
  | 'reducer-threw'
  | 'l3-unavailable-timeout'
  | 'non-object'
  | 'over-budget'
  | 'nested-over-budget'
  | 'quota'
  | 'passthrough';

/** 整形审计记录（D7）：`{ applied, reason? }`，只进审计、永不进模型上下文（D17）。类型单源在 types.ts。 */
export type ShapingAuditRecord = {
  rawResult: ToolResponse;
  shapedResult: ToolResponse;
  shaping: ShapingAudit;
};

/** L1 中心注册表条目（D5/D10：主注册表）。T03 起填充 reducer 变体 + 派生字段 spec。 */
export type ToolShape = {};

/**
 * L1 中心注册表（D5）：未声明 → passthrough（绝不套壳）。
 * T01 为空注册表：零整形。
 */
export const TOOL_SHAPES: ReadonlyMap<string, ToolShape> = new Map();

/** shapeToolResponse 上下文（ADR「实现前置」签名：transport / sessionId / resolveTool / audit） */
export type ShapeContext = {
  transport: InvocationContext['transport'];
  /** 会话标识；bootstrap（session_register / session_inherit 无 identity）时缺省 */
  sessionId?: string;
  /** 按工具名解析 ToolDefinition（builtin + custom），未注册 → undefined */
  resolveTool: (name: string) => ToolDefinition | undefined;
  /** 审计接收器：整形记录只进审计、永不进模型上下文（D7/D11/D17） */
  audit: (record: ShapingAuditRecord) => void;
};

/**
 * 工具响应整形入口（D13：包住最终装饰响应，含 decorateContinuation 后的长任务结构）。
 * T01（#29）：注册表为空 → 全量 passthrough（D3 未声明工具原样放行），行为与未接线时
 * 逐字段一致；审计记 passthrough 原因。shaper 自身失败由调用方 fail-open（D11）。
 */
export function shapeToolResponse(response: ToolResponse, ctx: ShapeContext): ToolResponse {
  ctx.audit({
    rawResult: response,
    shapedResult: response,
    shaping: { applied: false, reason: 'passthrough' },
  });
  return response;
}
