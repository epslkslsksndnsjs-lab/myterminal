/**
 * Theme — TUI 语义色角色系统（ADR-0004 决策 3）。
 * 12 个基础角色 + 4 个对话/工具语义角色（user/agent/tool/system）。
 * 组件只允许引用角色，禁止硬编码色值。
 */
export type Theme = {
  background: string;
  panel: string;
  panelAlt: string;
  selected: string;
  selectedText: string;
  text: string;
  muted: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
  border: string;
  /** 用户（TUI owner）消息与动作 */
  user: string;
  /** AI session（agent）消息与状态 */
  agent: string;
  /** 工具调用行与结果 */
  tool: string;
  /** 系统提示与运行时事件 */
  system: string;
};
