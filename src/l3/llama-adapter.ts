import type { JsonObject } from '../types.js';
import type { LocalModelAdapter, StructuredRequest, StructuredResult } from './adapter.js';

/**
 * ADR-0047 D8.3 — node-llama-cpp 具体实现（L3 唯一推荐运行时，T12）。
 *
 * 硬约束落地：
 *   1. 强制 non-thinking（D8.3 决策1）：`QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })`
 *      —— 结构化 JSON 落正文、可被 GBNF 解析，绝不落 `reasoning_content`。
 *   2. GBNF 令牌级约束（D8.3 决策3）：`createGrammarForJsonSchema` 在 token 级强制目标 schema，
 *      输出 100% 语法合法（仅防御性 JSON.parse，D8.4「默认零重试」）。
 *   3. ctx 窗口（D6/D8.3 决策5）：实测 Qwen3.5-2B max ctx = 262144（256K）≥ 26K，
 *      RAW_BUDGET_TOKENS 维持 24000（见 tool-parse.ts 回标）。运行时 context 用 32768（32K）——
 *      26K 约束（24K 预算 + 2K 输出）+ 余量，避免按 256K 全量分配 KV cache 撑爆内存。
 *
 * 依赖策略：node-llama-cpp 是原生模块，**只在首次 isReady()/complete() 懒加载时动态 import**
 * （`await import("node-llama-cpp")`），顶层仅 `import type`（擦除后零运行时依赖）——这样
 * registry / engine / tool-parse 静态 import 本模块都不会加载原生绑定，测试环境安全。
 *
 * 真模型（~1.3GB GGUF）不进自动化测试：测试经 `registerAdapterFactory` 注入 fake adapter
 * （见 test/issue-37）；本 adapter 的正确性由 T12 探测脚本 + 20 条微评测实证。
 */

/** D8.4 SYSTEM（prompt 模板规则，T13 可随评测迭代；adapter 接口不变）。 */
const SYSTEM_PROMPT = [
  '你是工具结果解析器。把给定的工具原始返回按目标 JSON Schema 抽取为结构化对象。',
  '规则：',
  '1. 只输出 schema 中声明的字段，绝不发明新字段',
  '2. 字段值必须直接来自原始返回文本（原样保留：不翻译、不改写、不总结、不推断）',
  '3. 原始返回中不存在的字段：标量 → 省略该字段；数组 → 输出空数组',
  '4. 只输出 JSON 本体，不输出任何解释文字或思考过程',
].join('\n');

/** 运行时 L3 context 窗口（26K 硬约束 + 余量；见文件头注释）。 */
const L3_CONTEXT_SIZE = 32768;

/** node-llama-cpp 动态导入的类型子集（避免顶层静态依赖原生模块）。 */
type LlamaNative = {
  getLlama(options: { gpu: string }): Promise<any>;
  LlamaChatSession: new (options: any) => any;
  QwenChatWrapper: new (options: any) => any;
};

export class LlamaLocalAdapter implements LocalModelAdapter {
  readonly id = 'qwen3.5-2b';
  readonly supportsStructuredOutput = true;

  private readonly modelPath: string;
  private loaded = false;
  private llama: any;
  private model: any;
  private context: any;
  private session: any;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  /** 冷加载 / 模型存在性检查（首次懒加载；失败 → false，引擎据此 fail-open）。 */
  async isReady(): Promise<boolean> {
    try {
      await this.ensureLoaded();
      return true;
    } catch {
      return false;
    }
  }

  /** 单发结构化解析（GBNF + non-thinking）。 */
  async complete(req: StructuredRequest): Promise<StructuredResult> {
    const start = Date.now();
    try {
      await this.ensureLoaded();
      const grammar = await this.llama.createGrammarForJsonSchema(req.schema);
      const text: string = await this.session.prompt(req.instruction, {
        grammar,
        maxTokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0,
      });
      const object = JSON.parse(text) as JsonObject;
      return { object, finishReason: 'stop', latencyMs: Date.now() - start, modelId: this.id };
    } catch {
      // 模型加载失败 / 解析失败 → error；引擎（D8.4 失败矩阵）据此 fail-open。
      return { object: null, finishReason: 'error', latencyMs: Date.now() - start, modelId: this.id };
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const native = (await import('node-llama-cpp')) as unknown as LlamaNative;
    this.llama = await native.getLlama({ gpu: 'auto' });
    this.model = await this.llama.loadModel({ modelPath: this.modelPath });
    this.context = await this.model.createContext({ contextSize: L3_CONTEXT_SIZE });
    this.session = new native.LlamaChatSession({
      contextSequence: this.context.getSequence(),
      chatWrapper: new native.QwenChatWrapper({ variation: '3.5', thoughts: 'discourage' }),
      systemPrompt: SYSTEM_PROMPT,
    });
    this.loaded = true;
  }
}
