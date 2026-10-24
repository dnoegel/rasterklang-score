import { describe, expect, it } from 'vitest';
import { Pattern, pure, silence, discrete, continuous, queryCycleRange } from '../../src/pattern/query.js';

describe('pure', () => {
  it('produces one Hap spanning the whole cycle, for any cycleIndex', () => {
    const p = pure('x');
    expect(p.query(0)).toEqual([{ startFrac: 0, durFrac: 1, value: 'x' }]);
    expect(p.query(5)).toEqual([{ startFrac: 0, durFrac: 1, value: 'x' }]);
  });

  it('is not continuous', () => {
    expect(pure(1).isContinuous).toBe(false);
  });
});

describe('silence', () => {
  it('produces no Haps in any cycle', () => {
    expect(silence().query(0)).toEqual([]);
    expect(silence().query(100)).toEqual([]);
  });
});

describe('queryAt uniformity', () => {
  it('derives queryAt for a discrete pattern by finding the containing Hap', () => {
    const p = discrete(() => [
      { startFrac: 0, durFrac: 0.5, value: 'a' },
      { startFrac: 0.5, durFrac: 0.5, value: 'b' },
    ]);
    expect(p.queryAt(0, 0)).toBe('a');
    expect(p.queryAt(0, 0.49)).toBe('a');
    expect(p.queryAt(0, 0.5)).toBe('b');
    expect(p.queryAt(0, 0.99)).toBe('b');
  });

  it('returns undefined during a rest', () => {
    const p = discrete(() => [{ startFrac: 0.5, durFrac: 0.25, value: 'a' }]);
    expect(p.queryAt(0, 0.1)).toBeUndefined();
  });

  it('derives query() for a continuous pattern as a single whole-cycle Hap', () => {
    const sig = continuous((_c, posFrac) => posFrac * 10);
    const haps = sig.query(0);
    expect(haps).toEqual([{ startFrac: 0, durFrac: 1, value: 0 }]);
  });

  it('queryAt on a continuous pattern samples directly, ignoring Hap machinery', () => {
    const sig = continuous((cycleIndex, posFrac) => cycleIndex * 100 + posFrac);
    expect(sig.queryAt(3, 0.25)).toBeCloseTo(300.25);
  });
});

describe('Pattern construction', () => {
  it('throws if neither query nor queryAt is provided', () => {
    expect(() => new Pattern({})).toThrow();
  });
});

describe('queryCycleRange', () => {
  it('clips Haps to an absolute-time window spanning multiple integer cycles', () => {
    // A cycle-invariant pattern: single Hap covering the full cycle each time.
    const p = pure('x');
    const clipped = queryCycleRange(p, 0.5, 2.5);
    // Covers: second half of cycle 0, all of cycle 1, first half of cycle 2.
    expect(clipped).toEqual([
      { absStart: 0.5, absDur: 0.5, value: 'x' },
      { absStart: 1, absDur: 1, value: 'x' },
      { absStart: 2, absDur: 0.5, value: 'x' },
    ]);
  });

  it('returns an empty array for a zero-or-negative-width window', () => {
    expect(queryCycleRange(pure('x'), 1, 1)).toEqual([]);
    expect(queryCycleRange(pure('x'), 2, 1)).toEqual([]);
  });
});
