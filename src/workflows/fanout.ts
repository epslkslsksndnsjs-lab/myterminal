import { AgentCallShapeError, isRunLevelError } from './failures.js';

/**
 * 扇出语义——parallel() 与 pipeline() 的批处理规则。
 *
 * 两者的分工是这张票最容易被写错的地方：
 *   parallel(thunks)  一次整批：全部同时起步，**栅栏在批的末尾**（调用方 await 才拿到数组）；
 *   pipeline(items, ...stages)  逐条链：每条 item 独立流过各段，**段与段之间没有栅栏**，
 *                              1 号可以已经进第二段而 3 号还在第一段。
 * 组间栅栏只在脚本显式分段（写完一段 await 再起下一段）时出现，引擎不额外加栅栏。
 *
 * 三态在这里的落点：
 *   · 批输入的**形状**（非数组、元素非函数、段非函数）→ 整批 reject，属调用形状错；
 *   · 单个 thunk / 单段自身的非 run 级失败 → 该槽 null（或该 item 丢弃），兄弟不受连坐；
 *   · run 级错误（预算 / 上限 / 取消）→ 整批拒，一路都不许被静默降成 null。
 * null 是哨兵：pipeline 只在 null 上短路，`0 / '' / false` 是合法传递值。
 */

export type FanoutStage = (previous: unknown, item: unknown, index: number) => unknown;

function rejectShape(message: string): never {
  throw new AgentCallShapeError(message);
}

function shape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function assertThunks(value: unknown): Array<() => unknown> {
  if (!Array.isArray(value)) rejectShape(`parallel() expects an array of thunks (got ${shape(value)})`);
  const bad = value.findIndex((entry) => typeof entry !== 'function');
  if (bad >= 0) {
    rejectShape(`parallel() expects thunks, not already-started promises or values: element ${bad} is ${shape(value[bad])}`);
  }
  return value as Array<() => unknown>;
}

export function assertItemsAndStages(items: unknown, stages: unknown): { items: unknown[]; stages: FanoutStage[] } {
  if (!Array.isArray(items)) rejectShape(`pipeline() expects an array of items (got ${shape(items)})`);
  if (!Array.isArray(stages) || stages.length === 0) rejectShape('pipeline() expects at least one stage function');
  const bad = stages.findIndex((entry) => typeof entry !== 'function');
  if (bad >= 0) rejectShape(`pipeline() stage ${bad} is ${shape(stages[bad])}, not a function`);
  return { items, stages: stages as FanoutStage[] };
}

/**
 * 整批同时起步；结果按位置对齐。
 * 被拒的槽位坍缩为 null，run 级错误原样上抛（整批判败）。
 */
/** 把 allSettled 的结果塌成对齐数组：run 级上抛，其余失败坍缩为该槽 null。 */
function collapse<T>(settled: Array<PromiseSettledResult<T>>): unknown[] {
  const out: unknown[] = [];
  for (const entry of settled) {
    if (entry.status === 'fulfilled') {
      out.push(entry.value === undefined ? null : entry.value);
      continue;
    }
    if (isRunLevelError(entry.reason)) throw entry.reason;
    out.push(null);
  }
  return out;
}

export async function runParallel(thunks: unknown): Promise<unknown[]> {
  const list = assertThunks(thunks);
  return collapse(await Promise.allSettled(list.map((thunk) => Promise.resolve().then(thunk))));
}

/**
 * 逐条链：每条 item 独立走完全部段，段间无栅栏。
 * 上一段为 null → 该 item 就此止步（槽位 null）；普通错误同样丢弃该 item。
 */
export async function runPipeline(items: unknown, stages: unknown): Promise<unknown[]> {
  const plan = assertItemsAndStages(items, stages);
  const chains = plan.items.map(async (item, index) => {
    let previous: unknown = null;
    for (let stage = 0; stage < plan.stages.length; stage++) {
      if (stage > 0 && previous === null) return null;
      try {
        previous = await Promise.resolve().then(() => plan.stages[stage](previous, item, index));
      } catch (error) {
        if (isRunLevelError(error)) throw error;
        return null;
      }
      if (previous === undefined) previous = null;
    }
    return previous === undefined ? null : previous;
  });
  return collapse(await Promise.allSettled(chains));
}
