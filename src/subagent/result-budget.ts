// ADR-0007 决策 19：工具结果预算——大小限制 + 截断 + 消息组预算
// ADR-0007 决策 30 Bug 1：replacementDecisions 跨 turn 冻结必须“先 get 再 set”
// ADR-0007 决策 18：ToolResult 类型在此定义并导出，M5 直接 import
// ADR-0032 #34：replacementDecisions 曾收敛到 SubagentContext；#77 改为模块级按 agentId 分桶（见下方），不再依赖单例 ctx。

// ── 常量（决策 19）──

export const MAX_RESULT_SIZE_CHARS = 50_000; // 单结果上限（#151 内存快照帽复用同源——一个数字两处用）
const PREVIEW_SIZE = 2_000;               // 截断后预览字符数
const MAX_RESULTS_PER_MESSAGE = 200_000;  // 消息组预算
const BUDGET_COMPRESS_THRESHOLD = PREVIEW_SIZE * 2; // 已经很小的结果不压缩（≤ 4000 字符）

// ── 类型（决策 18：M5 从此处 import，不许重复定义）──

export type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error: boolean;
};

// ── 跨 turn 冻结 Map（ADR-0032 #34 收敛意图 + ADR-0035 #77 按 agentId 分桶止血）──
// 模块级按 agentId 分桶：每个 agent 独立一份 replacementDecisions，
// resetReplacementDecisions(agentId) 只清该 agent 的桶，互不串扰。
// （SubagentContext.replacementDecisions 字段已随 A48-W1 清理删除——本模块级分桶为唯一实现。）
const agentReplacementDecisions = new Map<string, Map<string, 'full' | 'preview'>>();

function bucketFor(agentId: string): Map<string, 'full' | 'preview'> {
  let bucket = agentReplacementDecisions.get(agentId);
  if (!bucket) {
    bucket = new Map();
    agentReplacementDecisions.set(agentId, bucket);
  }
  return bucket;
}

/**
 * 重置某 agent 的冻结决策——compact 后或测试用。
 * 只清该 agent 的桶，不影响其他并发/相继运行的 agent（#77 修复）。
 */
export function resetReplacementDecisions(agentId: string = '__default__'): void {
  agentReplacementDecisions.delete(agentId);
}

// ── 单结果截断（决策 19）──

/**
 * 结果超过 MAX_RESULT_SIZE_CHARS 时截断为预览 + 尾部标记。
 * 不超限则原样返回。
 */
export function truncateResult(content: string): string {
  if (content.length <= MAX_RESULT_SIZE_CHARS) return content;

  const preview = content.slice(0, PREVIEW_SIZE);
  return `${preview}\n\n[Result truncated. Original size: ${content.length} chars. Use read_file with offset/limit to see more.]`;
}

/**
 * #151：内存封顶后的快照截断——content 已帽到 MAX_RESULT_SIZE_CHARS（超量丢弃），
 * totalChars 为全量字符数（诚实记账）。输出与 truncateResult(全量) 逐字节一致：
 * ≤ 帽 → 原样；超帽 → 2000 预览 + Original size 通知。
 */
export function truncateCappedResult(content: string, totalChars: number): string {
  if (totalChars <= MAX_RESULT_SIZE_CHARS) return content;
  const preview = content.slice(0, PREVIEW_SIZE);
  return `${preview}\n\n[Result truncated. Original size: ${totalChars} chars. Use read_file with offset/limit to see more.]`;
}

// ── 辅助：压缩为预览（Bug 1 修复共用逻辑）──

function truncateToPreview(content: string): string {
  const preview = content.slice(0, PREVIEW_SIZE);
  return `${preview}\n\n[Result budget-compressed. Original: ${content.length} chars.]`;
}

// ── 消息组预算（决策 19 + Bug 1 修复）──

/**
 * 对一批 ToolResult 应用消息组预算。
 *
 * **Bug 1 修复版**（决策 30）：顺序必须如此——
 * ① 先遍历 results，凡本 agent 冻结决策 get(id) === 'preview' 的强制压成预览
 * ② 再算总字符，≤ 200K 直接返回
 * ③ 超预算：按 content 长度降序，逐个把"还不够小"的结果压成预览并冻结
 *
 * @param results 本消息组的所有工具结果
 * @param agentId 调用方 subagent 的 id——冻结决策按 agentId 分桶隔离（#77 修复）
 * @returns 应用预算后的结果数组（原地修改）
 */
export function enforceMessageBudget(results: ToolResult[], agentId: string = '__default__'): ToolResult[] {
  const decisions = bucketFor(agentId);

  // ① 先应用已冻结的截断决策（Bug 1 修复：之前只 set 不 get）
  for (const r of results) {
    if (decisions.get(r.tool_use_id) === 'preview') {
      r.content = truncateToPreview(r.content);
    }
  }

  // ② 算总字符，≤ 200K 直接返回
  const totalChars = results.reduce((sum, r) => sum + r.content.length, 0);
  if (totalChars <= MAX_RESULTS_PER_MESSAGE) return results;

  // ③ 超预算——最大优先替换
  const indexed = results
    .map((r, i) => ({ r, i, size: r.content.length }))
    .sort((a, b) => b.size - a.size); // 降序

  let currentTotal = totalChars;
  for (const { r } of indexed) {
    if (currentTotal <= MAX_RESULTS_PER_MESSAGE) break;

    // 已经很小的结果不压缩
    if (r.content.length <= BUDGET_COMPRESS_THRESHOLD) continue;

    const originalSize = r.content.length;
    r.content = truncateToPreview(r.content);
    currentTotal -= originalSize - r.content.length;

    // 冻结决策——后续 turn 也用截断版
    decisions.set(r.tool_use_id, 'preview');
  }

  return results;
}

// ── 空结果处理（决策 19）──

/**
 * 空 tool_result 会导致某些模型误判 turn 边界。
 * 空/纯空白内容替换为 "(toolName completed with no output)"。
 * 非空内容原样返回。
 */
export function ensureNonEmpty(content: string, toolName: string): string {
  if (!content || content.trim().length === 0) {
    return `(${toolName} completed with no output)`;
  }
  return content;
}
