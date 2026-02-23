export function computeBackoffMs(attempt: number, baseMs = 1000, maxMs = 30000): number {
  const safeAttempt = Math.max(0, attempt);
  return Math.min(maxMs, baseMs * (2 ** safeAttempt));
}
