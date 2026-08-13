import type { JsonObject, JsonSchema } from '../types.js';

/**
 * ADR-0047 D8 — L3 模型层抽象接口（纯类型、零运行时依赖）。
 *
 * L3（模型层）只依赖此接口，与 subagent/Anthropic 配置彻底解耦（实验分支把 L3 绑死在
 * subagent 配置上，纯网页端用户无 subagent → L3 静默失效，正是要修的坑）。接口签名
 * 由 ADR-0047「D8 实施设计」锁定，adapter 具体实现（node-llama-cpp 等）在 T10/T11 落地，
 * 真模型（~1.1GB）不进自动化测试——测试环境经 registry 注入 fake adapter。
 *
 * 硬要求：`supportsStructuredOutput` 必须为 true 才能满足 L3 的 `structured_result`
 * schema 解析（D8 决策：优先选支持结构化/JSON 输出的小模型）。
 */

/** L3 结构化解析请求（D8.4：prompt 是引擎输入的一部分，与 adapter 实现分离）。 */
export interface StructuredRequest {
  /** 自然语言解析指令（含 prompt 模板；T13 落地模板，可随评测迭代）。 */
  instruction: string;
  /** 目标结构化 schema。 */
  schema: JsonSchema;
  /** 默认 2048（D6 护栏1 上限）。 */
  maxTokens?: number;
  /** 默认 0（确定性）。 */
  temperature?: number;
}

/** L3 结构化解析结果。 */
export interface StructuredResult {
  /** 解析成功对象；超时/失败 → null。 */
  object: JsonObject | null;
  finishReason: 'stop' | 'length' | 'error' | 'timeout';
  latencyMs: number;
  modelId: string;
}

/** L3 本地模型适配器抽象（D8）。 */
export interface LocalModelAdapter {
  readonly id: string;
  /** L3 硬要求：必须 true（结构化/JSON 输出能力）。 */
  readonly supportsStructuredOutput: boolean;
  /** 冷加载 / 模型存在性检查。 */
  isReady(): Promise<boolean>;
  /** 单发结构化解析。 */
  complete(req: StructuredRequest): Promise<StructuredResult>;
}
