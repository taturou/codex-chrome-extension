export function computeBackoffMs(
  attempt: number,
  baseMs = 1000,
  maxMs = 30000,
  jitterRatio = 0.2,
  randomFn: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, attempt);
  const capped = Math.min(maxMs, baseMs * (2 ** safeAttempt));
  if (jitterRatio <= 0 || capped <= 0) {
    return capped;
  }
  const jitterRange = Math.floor(capped * jitterRatio);
  if (jitterRange <= 0) {
    return capped;
  }
  const random = Math.min(1, Math.max(0, randomFn()));
  const delta = Math.floor((random * 2 - 1) * jitterRange);
  return Math.min(maxMs, Math.max(0, capped + delta));
}
