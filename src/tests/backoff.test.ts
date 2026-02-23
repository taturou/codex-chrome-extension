import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from '../shared/backoff';

describe('computeBackoffMs', () => {
  it('jitter無効時は指数的に増加し最大値で頭打ちになる', () => {
    expect(computeBackoffMs(0, 1000, 30000, 0)).toBe(1000);
    expect(computeBackoffMs(1, 1000, 30000, 0)).toBe(2000);
    expect(computeBackoffMs(2, 1000, 30000, 0)).toBe(4000);
    expect(computeBackoffMs(5, 1000, 30000, 0)).toBe(30000);
    expect(computeBackoffMs(10, 1000, 30000, 0)).toBe(30000);
  });

  it('負のattemptでもベース値を返す', () => {
    expect(computeBackoffMs(-1, 1000, 30000, 0)).toBe(1000);
  });

  it('jitter有効時は範囲内で揺らぐ', () => {
    const base = 4000;
    const min = 3200;
    const max = 4800;
    const low = computeBackoffMs(2, 1000, 30000, 0.2, () => 0);
    const high = computeBackoffMs(2, 1000, 30000, 0.2, () => 1);
    expect(low).toBeGreaterThanOrEqual(min);
    expect(low).toBeLessThanOrEqual(base);
    expect(high).toBeGreaterThanOrEqual(base);
    expect(high).toBeLessThanOrEqual(max);
  });
});
