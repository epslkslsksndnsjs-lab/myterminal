/**
 * relative-time — 将 ISO 时间字符串转为人类可读的相对时间（ADR-0004 决策 7）。
 * 纯函数，无副作用，可单测。
 */

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

/**
 * 返回相对时间描述。
 * - <60s → 刚刚 / just now
 * - <60m → N 分钟前 / Nm ago
 * - <24h → N 小时前 / Nh ago
 * - 否则 → 日期字符串
 */
export function relativeTime(iso: string, now: Date, zh: boolean): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const diff = now.getTime() - at.getTime();
  if (diff < 0) return zh ? '刚刚' : 'just now';
  if (diff < MS_MINUTE) return zh ? '刚刚' : 'just now';
  if (diff < MS_HOUR) {
    const mins = Math.floor(diff / MS_MINUTE);
    return zh ? `${mins} 分钟前` : `${mins}m ago`;
  }
  if (diff < MS_DAY) {
    const hours = Math.floor(diff / MS_HOUR);
    return zh ? `${hours} 小时前` : `${hours}h ago`;
  }
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
