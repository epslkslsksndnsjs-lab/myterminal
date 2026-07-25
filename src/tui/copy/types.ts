/**
 * Copy — 文案系统类型（ADR-0004 决策 6）。
 * L1 俏皮层：问候语 / 空状态 / 状态动词；L2 精确层：操作、设置、错误提示。
 * 文案集中在 copy/ 模块，按语言 × 层级组织，不散落在组件里。
 */
export type EmptyStateKey = 'sessions' | 'messages' | 'extensions' | 'logs' | 'diffClean' | 'timeline';

export type Copy = {
  /** L1：按小时给问候语（中英各自创作，意译不直译） */
  greetingFor(hour: number): string;
  /** L1：状态动词表（随机轮换池；单次操作按 key 锁定一词） */
  statusVerbs: string[];
  /** L1：状态动词前缀（"正在" / ""），展示为 `${verbPrefix}${verb}…` 或 `${verb}…` */
  verbPrefix: string;
  /** L1：各页空状态 */
  emptyStates: Record<EmptyStateKey, string>;
  /** L2：输入栏 */
  inputPlaceholder: string;
  inputHintNormal: string;
  inputHintEditing: string;
  commandHint: string;
};
