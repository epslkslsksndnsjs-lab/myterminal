import type { ActionsContinuationMode } from './types.js';

export const HARNESS_CONTRACT_REVISION = 'actions-long-task-harness-v2';

export function continuationPolicy(mode: ActionsContinuationMode | undefined) {
  if (!mode) mode = 'off';
  if (mode === 'off') return { enabled: false, minCalls: 0, maxCalls: 0, exactCalls: undefined } as const;
  if (mode === 'next-call') return { enabled: true, minCalls: 1, maxCalls: 1, exactCalls: 1 } as const;
  if (mode === 'lookahead-3') return { enabled: true, minCalls: 3, maxCalls: 3, exactCalls: 3 } as const;
  return { enabled: true, minCalls: 1, maxCalls: 3, exactCalls: undefined } as const;
}

export function harnessRequirement(mode: ActionsContinuationMode | undefined): string {
  if (!mode) mode = 'off';
  if (mode === 'off') return 'Core session harness is active without enforced post-checkpoint calls. nextCalls is optional.';
  if (mode === 'adaptive') return 'Enhanced long-task harness is active. A working checkpoint requires 1-3 exact concrete nextCalls: prefer 3 for predictable sequential work, but use 1 when evidence, a test result, or a background task may require replanning.';
  if (mode === 'lookahead-3') return 'Enhanced diagnostic harness is active. Every working checkpoint requires exactly 3 ordered concrete nextCalls.';
  return 'Enhanced diagnostic harness is active. Every working checkpoint requires exactly 1 concrete nextCall.';
}

export function harnessContract(mode: ActionsContinuationMode | undefined) {
  const resolved = mode ?? 'off';
  return { mode: resolved, revision: HARNESS_CONTRACT_REVISION, requirement: harnessRequirement(resolved) };
}
