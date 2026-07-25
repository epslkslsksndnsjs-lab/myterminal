import type { Copy } from './types.js';

/** en 文案（L1 Claude Code 式俏皮原创）。 */
export const en: Copy = {
  greetingFor(hour: number): string {
    if (hour >= 23 || hour < 5) return 'Burning the midnight oil.';
    if (hour < 12) return 'Good morning.';
    if (hour < 18) return 'Good afternoon.';
    return 'Good evening.';
  },
  statusVerbs: ['Tinkering', 'Pondering', 'Fiddling', 'Noodling', 'Whittling', 'Cogitating', 'Tuning'],
  verbPrefix: '',
  emptyStates: {
    sessions: 'No sessions yet. Press n to delegate some work, or type /new.',
    messages: 'Crickets… press m to say something, or just type below.',
    extensions: 'No custom extensions yet. Press e to build one.',
    logs: 'No log entries yet. Activity will land here first.',
    diffClean: 'Working tree is squeaky clean.',
    timeline: 'Nothing yet. Once sessions get moving, this place lights up.',
  },
  inputPlaceholder: 'Type a command or message…',
  inputHintNormal: 'i or click to type · / commands · Tab pages · q quit',
  inputHintEditing: 'Enter send · Tab complete · ↑ history · Esc back',
  commandHint: 'Type / for all commands',
};
