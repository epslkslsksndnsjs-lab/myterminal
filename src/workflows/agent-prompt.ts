import type { ToolMode } from './tool-face.js';

/**
 * 每路 agent 的系统提示词——模块自足拼接，一份一段地按这一跑的形状生成。
 *
 * 五块内容按固定次序（行为锁测试逐条点名）：
 *   角色与任务框架 → 工具用法 → 环境 → 输出约束 → 模式追加项。
 * 三条硬约束写在"输出约束"里：最终文本就是返回值、不许出现确认语、JSON 裸出无围栏；
 * schema 模式再加一条：结构化结果只能经 structured_output 出口交回。
 * 声明了隔离的那一路再加一段：收尾必须回报所改的目录与分支——那是它对人的交代，
 * 与它有没有拿到写工具是两件事（写面随隔离交付，#231）。
 */

export type SystemPromptInput = {
  label: string;
  cwd: string;
  platform: string;
  toolNames: readonly string[];
  /** 这一跑的工具面模式（命令闸与可见性）。 */
  mode: ToolMode;
  /** 脚本是否声明了隔离运行（isolation: 'worktree'）。 */
  isolated: boolean;
  schema: boolean;
  /** 隔离面的分支名（尚未知时为 undefined，仍要求回报）。 */
  branch?: string;
};

const ROLE_LINES: readonly string[] = [
  'You are one path inside a local workflow run. Sibling paths work the same assignment elsewhere at the same time; nothing you do here reaches them.',
  'You have one task and one deliverable. The text you finish on is the value the script receives.',
  'Nobody is watching live: do not wait for permission, do not ask a question, do not stop halfway through.',
];

const TOOL_LINES: readonly string[] = [
  'Each tool here does one action to one target. There are no composite tools and no task ledger.',
  'You cannot start another run, spawn another agent, message a human, or touch the parent session — those tools are not on this face, and asking for them is wasted work.',
  'A path outside your working directory is refused by the tool itself; do not try to route around it.',
];

const OUTPUT_LINES: readonly string[] = [
  'End with the result itself. No acknowledgement, no "let me know if you need anything", no narration of next steps.',
  'When you hand back JSON, write it bare: no code fence, no prose around it, no trailing comments.',
];

export function buildAgentSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [
    `# Path "${input.label}"`,
    ROLE_LINES.join(' '),
    '',
    '# Tools on this path',
    ...TOOL_LINES,
    `Available here: ${input.toolNames.join(', ')}.`,
    '',
    '# Where this path runs',
    `Working directory: ${input.cwd}`,
    `Platform: ${input.platform}`,
    '',
    '# How you hand back',
    ...OUTPUT_LINES,
  ];

  if (input.schema) {
    sections.push('This path hands back its result through the structured_output tool. Narrating an answer in free text is not the submission; a fenced block is not a submission either.');
  }
  if (input.isolated) {
    sections.push('');
    sections.push('# If you change files');
    sections.push('This path was declared to run isolated from the shared checkout.');
    sections.push(
      `Report the absolute directory and the branch you changed${input.branch ? ` (branch: ${input.branch})` : ''} at the end of your answer, so the work can be found and merged later.`,
    );
  }
  return sections.join('\n');
}
