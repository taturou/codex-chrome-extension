import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from '../shared/backoff';

describe('computeBackoffMs', () => {
  it('指数的に増加し最大値で頭打ちになる', () => {
    expect(computeBackoffMs(0)).toBe(1000);
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(2)).toBe(4000);
    expect(computeBackoffMs(5)).toBe(30000);
    expect(computeBackoffMs(10)).toBe(30000);
  });

  it('負のattemptでもベース値を返す', () => {
    expect(computeBackoffMs(-1)).toBe(1000);
  });
});
