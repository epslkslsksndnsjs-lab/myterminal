import { randomBytes } from 'node:crypto';

/**
 * runId 形态 = `wf_<hex>`。
 *
 * 它是唯一被拼进磁盘路径的模型可控字符串，所以一切入口都先过形态闸——
 * 形状不对就拒，绝不允许 `..`、分隔符或绝对形态进路径（防路径穿越）。
 */

export const RUN_ID_PATTERN = /^wf_[0-9a-f]+$/;

export function newRunId(): string {
  return `wf_${randomBytes(8).toString('hex')}`;
}

export function isRunId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value);
}

/** 形态闸：不合形态抛错，消息带原值供审计与拒因回显。 */
export function assertRunId(value: unknown): string {
  if (!isRunId(value)) throw new Error(`runId must match ${RUN_ID_PATTERN.source}; received: ${String(value)}`);
  return value;
}

/** 每路文件的槽位序号（admission 序，1 起，4 位零填充）。 */
export function dispatchId(sequence: number): string {
  return `d${String(sequence).padStart(4, '0')}`;
}
