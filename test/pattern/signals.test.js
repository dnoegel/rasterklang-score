import { describe, expect, it } from 'vitest';
import { sine, saw, square, tri, rand, perlin } from '../../src/pattern/signals.js';

describe('basic waveforms', () => {
  it('sine: 0 at posFrac 0/0.5 (midline), peak at 0.25, trough at 0.75', () => {
    expect(sine.queryAt(0, 0)).toBeCloseTo(0.5, 6);
    expect(sine.queryAt(0, 0.25)).toBeCloseTo(1, 6);
    expect(sine.queryAt(0, 0.5)).toBeCloseTo(0.5, 6);
    expect(sine.queryAt(0, 0.75)).toBeCloseTo(0, 6);
  });

  it('saw: ramps 0..1 across the cycle', () => {
    expect(saw.queryAt(0, 0)).toBeCloseTo(0, 6);
    expect(saw.queryAt(0, 0.5)).toBeCloseTo(0.5, 6);
    expect(saw.queryAt(0, 0.9)).toBeCloseTo(0.9, 6);
  });

  it('square: 0 for first half, 1 for second half', () => {
    expect(square.queryAt(0, 0.1)).toBe(0);
    expect(square.queryAt(0, 0.6)).toBe(1);
  });

  it('tri: ramps up 0->1 in the first half, down 1->0 in the second', () => {
    expect(tri.queryAt(0, 0)).toBeCloseTo(0, 6);
    expect(tri.queryAt(0, 0.25)).toBeCloseTo(0.5, 6);
    expect(tri.queryAt(0, 0.5)).toBeCloseTo(1, 6);
    expect(tri.queryAt(0, 0.75)).toBeCloseTo(0.5, 6);
  });

  it('all signals report isContinuous', () => {
    for (const s of [sine, saw, square, tri, rand, perlin]) {
      expect(s.isContinuous).toBe(true);
    }
  });
});

describe('sine.range(200,2000).slow(4) sampled at known points', () => {
  // Hand-computed: slow(4) stretches one sine period across 4 cycles, so
  // sampling at posFrac=0 on cycles 0..4 walks through exactly one quarter
  // of the sine period per cycle: midline, peak, midline, trough, midline.
  const chain = sine.range(200, 2000).slow(4);

  it('cycle 0, pos 0 -> midline (1100)', () => {
    expect(chain.queryAt(0, 0)).toBeCloseTo(1100, 4);
  });

  it('cycle 1, pos 0 -> peak (2000)', () => {
    expect(chain.queryAt(1, 0)).toBeCloseTo(2000, 4);
  });

  it('cycle 2, pos 0 -> midline (1100)', () => {
    expect(chain.queryAt(2, 0)).toBeCloseTo(1100, 4);
  });

  it('cycle 3, pos 0 -> trough (200)', () => {
    expect(chain.queryAt(3, 0)).toBeCloseTo(200, 4);
  });

  it('cycle 4, pos 0 -> back to midline (1100), one full period elapsed', () => {
    expect(chain.queryAt(4, 0)).toBeCloseTo(1100, 4);
  });
});

describe('rand/perlin determinism', () => {
  it('rand: same (cycleIndex, posFrac) always yields the same value', () => {
    expect(rand.queryAt(3, 0.42)).toBe(rand.queryAt(3, 0.42));
    expect(rand.queryAt(7, 0.1)).toBe(rand.queryAt(7, 0.1));
  });

  it('rand: different positions generally yield different values', () => {
    const a = rand.queryAt(0, 0.1);
    const b = rand.queryAt(0, 0.9);
    expect(a).not.toBe(b);
  });

  it('rand: values stay within [0, 1)', () => {
    for (let i = 0; i < 50; i += 1) {
      const v = rand.queryAt(i, i / 50);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('perlin: same (cycleIndex, posFrac) always yields the same value', () => {
    expect(perlin.queryAt(2, 0.33)).toBe(perlin.queryAt(2, 0.33));
  });

  it('perlin: is smooth (small position deltas produce small value deltas)', () => {
    const a = perlin.queryAt(0, 0.5);
    const b = perlin.queryAt(0, 0.501);
    expect(Math.abs(a - b)).toBeLessThan(0.05);
  });
});

describe('.fast/.slow/.range are usable on any signal, chainable', () => {
  it('square.fast(2) completes two square cycles within one output cycle', () => {
    const fastSquare = square.fast(2);
    // First half of output cycle == one full square cycle compressed:
    expect(fastSquare.queryAt(0, 0)).toBe(0);
    expect(fastSquare.queryAt(0, 0.24)).toBe(0);
    expect(fastSquare.queryAt(0, 0.26)).toBe(1);
    // Second compressed cycle starts again at posFrac 0.5:
    expect(fastSquare.queryAt(0, 0.5)).toBe(0);
    expect(fastSquare.queryAt(0, 0.76)).toBe(1);
  });

  it('saw.range(0,127) rescales output to a MIDI-CC-like range', () => {
    const scaled = saw.range(0, 127);
    expect(scaled.queryAt(0, 0)).toBeCloseTo(0, 5);
    expect(scaled.queryAt(0, 1 / 127)).toBeCloseTo(1, 3);
  });
});
