import { describe, expect, it } from 'vitest';
import { mergeToken } from '../shared/token';

describe('mergeToken', () => {
  it('トークンを順次連結する', () => {
    const s1 = mergeToken(undefined, 'Hel');
    const s2 = mergeToken(s1, 'lo');
    const s3 = mergeToken(s2, ' World');
    expect(s3).toBe('Hello World');
  });
});
