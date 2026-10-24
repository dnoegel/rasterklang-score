// ADR 0003 W4: the timeline primitive, tested standalone before anything
// wires it up to grammar (that's W5). See timeline.js's own header for the
// definition this file verifies against.
import { describe, expect, it } from 'vitest';
import { timeline } from '../../src/pattern/timeline.js';
import { parseMini } from '../../src/pattern/miniNotation.js';

function sorted(pattern, cycleIndex) {
  return pattern
    .query(cycleIndex)
    .slice()
    .sort((a, b) => a.startFrac - b.startFrac);
}

describe('timeline: a single entry of length 1', () => {
  it('is identical to the pattern queried directly (today\'s slow(1), the no-declared-length case)', () => {
    const p = parseMini('c4 d4 e4 f4');
    const tl = timeline([{ lengthCycles: 1, pattern: p }]);
    expect(sorted(tl, 0)).toEqual(sorted(p, 0));
    expect(sorted(tl, 1)).toEqual(sorted(p, 1));
    expect(sorted(tl, 5)).toEqual(sorted(p, 5));
  });

  it('also matches pattern.slow(1) exactly for a longer single entry', () => {
    const p = parseMini('c4 d4');
    const tl = timeline([{ lengthCycles: 3, pattern: p }]);
    const slowed = p.slow(3);
    for (const c of [0, 1, 2, 3, 4, 5, -1, -2, -3]) {
      const got = sorted(tl, c);
      const want = sorted(slowed, c);
      expect(got.length).toBe(want.length);
      got.forEach((h, i) => {
        expect(h.value).toBe(want[i].value);
        expect(h.startFrac).toBeCloseTo(want[i].startFrac, 9);
        expect(h.durFrac).toBeCloseTo(want[i].durFrac, 9);
      });
    }
  });
});

describe('timeline: two entries of length 1', () => {
  it('concatenates and repeats with period 2', () => {
    const a = parseMini('a');
    const b = parseMini('b');
    const tl = timeline([{ lengthCycles: 1, pattern: a }, { lengthCycles: 1, pattern: b }]);
    expect(sorted(tl, 0).map((h) => h.value)).toEqual(['a']);
    expect(sorted(tl, 1).map((h) => h.value)).toEqual(['b']);
    expect(sorted(tl, 2).map((h) => h.value)).toEqual(['a']);
    expect(sorted(tl, 3).map((h) => h.value)).toEqual(['b']);
  });
});

describe('timeline: entries of length 1 and 2', () => {
  it('places haps at the right absolute cycle offsets', () => {
    // a (length 1) occupies cycle [0,1); b (length 2, two notes per cycle
    // of its own) occupies cycles [1,3), playing once across that span.
    const a = parseMini('a');
    const b = parseMini('y1 y2');
    const tl = timeline([{ lengthCycles: 1, pattern: a }, { lengthCycles: 2, pattern: b }]);
    expect(sorted(tl, 0).map((h) => h.value)).toEqual(['a']);
    // b's content (b1 b2) stretched over 2 cycles: b1 in cycle 1, b2 in cycle 2.
    expect(sorted(tl, 1).map((h) => h.value)).toEqual(['y1']);
    expect(sorted(tl, 2).map((h) => h.value)).toEqual(['y2']);
    // period 3: repeats.
    expect(sorted(tl, 3).map((h) => h.value)).toEqual(['a']);
    expect(sorted(tl, 4).map((h) => h.value)).toEqual(['y1']);
    expect(sorted(tl, 5).map((h) => h.value)).toEqual(['y2']);
  });

  it('matches the ADR W5 acceptance numbers when driven at meter 4/4 tempo 120 beat granularity', () => {
    // pattern a 4 = "c4 d4 e4 f4" -> lengthCycles 1 (4 beats / 4 beats-per-bar)
    // pattern b 8 = "c5 d5 e5 f5 g5 a5 b5 c6" -> lengthCycles 2
    // voice 0 $a $b -> onsets (in BEAT units within each cycle) 0,1,2,3 | 4,4.5,5,5.5,6,6.5,7,7.5
    // i.e. cycle-fraction terms: cycle 0 has 4 equal quarter-slots; cycles 1-2
    // together hold 8 equal eighth-slots.
    const a = parseMini('c4 d4 e4 f4');
    const b = parseMini('c5 d5 e5 f5 g5 a5 b5 c6');
    const tl = timeline([{ lengthCycles: 1, pattern: a }, { lengthCycles: 2, pattern: b }]);
    const beatsIn = (cycleIndex) => sorted(tl, cycleIndex).map((h) => h.startFrac * 4 + cycleIndex * 4);
    expect(beatsIn(0)).toEqual([0, 1, 2, 3]);
    expect(beatsIn(1)).toEqual([4, 5, 6, 7]);
    expect(beatsIn(2)).toEqual([8, 9, 10, 11]);
  });
});

describe('timeline: a fractional total', () => {
  it('wraps correctly (0.5 + 1 = period 1.5)', () => {
    const a = parseMini('x1 x2'); // length 0.5: half of "a1 a2" per period? see below
    const b = parseMini('b');
    // a occupies [0, 0.5) playing once across that HALF cycle; b occupies
    // [0.5, 1.5) playing once across that full cycle.
    const tl = timeline([{ lengthCycles: 0.5, pattern: a }, { lengthCycles: 1, pattern: b }]);
    // cycle 0: [0,1) covers all of a's span [0,0.5) and the first half of b's [0.5,1.5).
    const c0 = sorted(tl, 0);
    expect(c0.map((h) => h.value)).toEqual(['x1', 'x2', 'b']);
    expect(c0[0].startFrac).toBeCloseTo(0, 9);
    expect(c0[2].startFrac).toBeCloseTo(0.5, 9);
    expect(c0[2].durFrac).toBeCloseTo(0.5, 9); // clipped: b's own span is 1 cycle wide, half visible in cycle 0
    // cycle 1: [1,2) covers the back half of b's span [0.5,1.5) -> [1,1.5)
    // relative-to-cycle-1 that's [0,0.5) - then period 1.5 wraps and a's
    // NEXT repeat starts at absolute 1.5, i.e. cycle-relative 0.5.
    const c1 = sorted(tl, 1);
    expect(c1.map((h) => h.value)).toEqual(['b', 'x1', 'x2']);
    expect(c1[0].startFrac).toBeCloseTo(0, 9);
    expect(c1[0].durFrac).toBeCloseTo(0.5, 9);
    expect(c1[1].startFrac).toBeCloseTo(0.5, 9);
  });
});

describe('timeline: a negative cycle index', () => {
  it('queries the right element (period 2: a at even cycles, b at odd)', () => {
    const a = parseMini('a');
    const b = parseMini('b');
    const tl = timeline([{ lengthCycles: 1, pattern: a }, { lengthCycles: 1, pattern: b }]);
    expect(sorted(tl, -1).map((h) => h.value)).toEqual(['b']);
    expect(sorted(tl, -2).map((h) => h.value)).toEqual(['a']);
    expect(sorted(tl, -3).map((h) => h.value)).toEqual(['b']);
  });
});

describe('timeline: provenance', () => {
  it('survives on every hap (sourceStart/sourceEnd from mini-notation)', () => {
    const a = parseMini('c4 d4');
    const b = parseMini('e4');
    const tl = timeline([{ lengthCycles: 1, pattern: a }, { lengthCycles: 1, pattern: b }]);
    for (const h of tl.query(0)) {
      expect(typeof h.sourceStart).toBe('number');
      expect(typeof h.sourceEnd).toBe('number');
    }
    for (const h of tl.query(1)) {
      expect(typeof h.sourceStart).toBe('number');
      expect(typeof h.sourceEnd).toBe('number');
    }
  });
});

describe('timeline: no hap straddles a cycle boundary', () => {
  it('every hap satisfies 0 <= startFrac and startFrac + durFrac <= 1', () => {
    const a = parseMini('x1 x2 x3');
    const b = parseMini('y1 y2');
    const tl = timeline([{ lengthCycles: 0.5, pattern: a }, { lengthCycles: 1.25, pattern: b }]);
    for (const c of [-2, -1, 0, 1, 2, 3, 4]) {
      for (const h of tl.query(c)) {
        expect(h.startFrac).toBeGreaterThanOrEqual(-1e-9);
        expect(h.startFrac + h.durFrac).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});
