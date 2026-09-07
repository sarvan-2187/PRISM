/** Small shared formatters. Money is always integer paise on the wire. */

/**
 * Rupees to paise. Rounds rather than truncates, and happens exactly once per
 * payment: the amount is hashed into the intent, and a value that can be
 * formatted two ways can be hashed two ways.
 */
export function rupeesToPaise(rupees: string): number {
  return Math.round(Number(rupees) * 100);
}

/** "4m ago", "3d ago". Coarse on purpose: exact times live on the timeline. */
export function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/** Clock time for log lines, where ordering matters more than the date. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
