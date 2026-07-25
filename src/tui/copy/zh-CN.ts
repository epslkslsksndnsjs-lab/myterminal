import type { Copy } from './types.js';

/** zh-CN 文案（L1 俏皮原创，非英文翻译）。 */
export const zhCN: Copy = {
  greetingFor(hour: number): string {
    if (hour >= 23 || hour < 5) return '夜深了。';
    if (hour < 11) return '早上好。';
    if (hour < 13) return '中午好。';
    if (hour < 18) return '下午好。';
    return '晚上好。';
  },
  statusVerbs: ['捣鼓', '琢磨', '摆弄', '拾掇', '鼓捣', '忙活', '打磨'],
  verbPrefix: '正在',
  emptyStates: {
    sessions: '还没有 session。按 n 派个活儿出去，或输入 /new。',
    messages: '静悄悄的……按 m 说点什么，或直接在下方输入消息。',
    extensions: '还没有自定义扩展。按 e 造一个出来。',
    logs: '暂无日志。有动静的时候会第一时间出现在这里。',
    diffClean: '工作区干干净净，没有未提交的改动。',
    timeline: '还没有动静。session 一开工，这里就热闹了。',
  },
  inputPlaceholder: '输入命令或消息…',
  inputHintNormal: 'i 或点击输入 · / 命令 · Tab 页面 · q 退出',
  inputHintEditing: 'Enter 发送 · Tab 补全 · ↑ 历史 · Esc 退出输入',
  commandHint: '输入 / 查看全部命令',
};
