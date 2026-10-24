import { describe, expect, it } from 'vitest';
import { parseMini, parseAtomValue } from '../../src/pattern/miniNotation.js';

function sorted(pattern, cycleIndex) {
  return pattern
    .query(cycleIndex)
    .slice()
    .sort((a, b) => a.startFrac - b.startFrac);
}

describe('note name parsing (SID-agnostic MIDI-equivalent numbers)', () => {
  it('c4 -> 60 (the documented convention)', () => {
    expect(parseAtomValue('c4')).toBe(60);
  });

  it('g3 -> 55, the MIDI note number for G3', () => {
    expect(parseAtomValue('g3')).toBe(55);
  });

  it('cs4 and c#4 both -> 61 (one semitone above c4)', () => {
    expect(parseAtomValue('cs4')).toBe(61);
    expect(parseAtomValue('c#4')).toBe(61);
  });

  it('gs3 -> 56 (one semitone above g3)', () => {
    expect(parseAtomValue('gs3')).toBe(56);
  });

  it('plain numbers stay numbers, plain words stay strings', () => {
    expect(parseAtomValue('200')).toBe(200);
    expect(parseAtomValue('2.75')).toBe(2.75);
    expect(parseAtomValue('bd')).toBe('bd');
  });
});

describe('"[e5 b4]*2" - subdivision + speed', () => {
  it('produces e5 b4 e5 b4 within one cycle', () => {
    const p = parseMini('[e5 b4]*2');
    const haps = sorted(p, 0);
    expect(haps.map((h) => h.value)).toEqual([76, 71, 76, 71]); // e5=76, b4=71
    expect(haps.map((h) => h.startFrac)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(haps.every((h) => Math.abs(h.durFrac - 0.25) < 1e-9)).toBe(true);
  });
});

describe('"<e5 b4 d5 c5>" - alternation queried across multiple cycles', () => {
  it('plays one value per cycle, cycling', () => {
    const p = parseMini('<e5 b4 d5 c5>');
    const valueAt = (c) => sorted(p, c)[0].value;
    expect(valueAt(0)).toBe(76); // e5
    expect(valueAt(1)).toBe(71); // b4
    expect(valueAt(2)).toBe(74); // d5
    expect(valueAt(3)).toBe(72); // c5
    expect(valueAt(4)).toBe(76); // wraps back to e5
    expect(valueAt(5)).toBe(71);
  });
});

describe('nested "<...>" inside a fixed-length sequence advances by one entry every real cycle', () => {
  it('an 8-step sequence with a 4-way alternation at one slot still visits all four entries in order (regression: used to freeze, since 8 is a multiple of 4)', () => {
    const p = parseMini('~ c4 ~ e4 ~ <g4 a4 b4 c5> ~ e4');
    const valueAtAlternationSlot = (c) => sorted(p, c)[2].value; // 3rd Hap: the <...> slot
    expect(valueAtAlternationSlot(0)).toBe(67); // g4
    expect(valueAtAlternationSlot(1)).toBe(69); // a4
    expect(valueAtAlternationSlot(2)).toBe(71); // b4
    expect(valueAtAlternationSlot(3)).toBe(72); // c5
    expect(valueAtAlternationSlot(4)).toBe(67); // wraps back to g4
  });

  it('a 3-step sequence with a 3-way alternation still advances forward, not in reverse (regression: N mod m == m-1 used to look reversed)', () => {
    const p = parseMini('x x <a b c>');
    const valueAtAlternationSlot = (c) => sorted(p, c)[2].value;
    expect(valueAtAlternationSlot(0)).toBe('a');
    expect(valueAtAlternationSlot(1)).toBe('b');
    expect(valueAtAlternationSlot(2)).toBe('c');
    expect(valueAtAlternationSlot(3)).toBe('a');
  });

  it('a weighted sequence ("@n") with a nested alternation also advances by one entry per real cycle', () => {
    const p = parseMini('x@2 <a b c>');
    const valueAtAlternationSlot = (c) => sorted(p, c)[1].value;
    expect(valueAtAlternationSlot(0)).toBe('a');
    expect(valueAtAlternationSlot(1)).toBe('b');
    expect(valueAtAlternationSlot(2)).toBe('c');
    expect(valueAtAlternationSlot(3)).toBe('a');
  });
});

describe('"bd(3,8,0)" - euclidean rhythm', () => {
  it('produces the canonical tresillo hit pattern: onsets at steps 0, 3, 6 of 8', () => {
    const p = parseMini('bd(3,8,0)');
    const haps = sorted(p, 0);
    expect(haps).toHaveLength(3);
    expect(haps.map((h) => Math.round(h.startFrac * 8))).toEqual([0, 3, 6]);
    expect(haps.every((h) => h.value === 'bd')).toBe(true);
    expect(haps.every((h) => Math.abs(h.durFrac - 1 / 8) < 1e-9)).toBe(true);
  });

  it('is stable across cycles (no cycle-dependent randomness)', () => {
    const p = parseMini('bd(3,8,0)');
    expect(sorted(p, 5).map((h) => Math.round(h.startFrac * 8))).toEqual([0, 3, 6]);
  });
});

describe('"a@2 b" - temporal weight', () => {
  it('gives "a" 2/3 of the cycle and "b" 1/3', () => {
    const p = parseMini('a@2 b');
    const haps = sorted(p, 0);
    expect(haps.map((h) => h.value)).toEqual(['a', 'b']);
    expect(haps[0].startFrac).toBeCloseTo(0, 10);
    expect(haps[0].durFrac).toBeCloseTo(2 / 3, 10);
    expect(haps[1].startFrac).toBeCloseTo(2 / 3, 10);
    expect(haps[1].durFrac).toBeCloseTo(1 / 3, 10);
  });
});

// ADR 0003 D1: `/N[.t]` is a duration in beats (beatUnit/N, dotted *1.5,
// triplet *2/3), the same weight mechanism `@n` uses - not the pre-4.0.0
// slow operator.
describe('"c4/4 d4/8 e4/8 f4/2" - durations', () => {
  it('is timing-identical to the equivalent @n weights, at the default beatUnit 4', () => {
    const durations = sorted(parseMini('c4/4 d4/8 e4/8 f4/2'), 0);
    const weights = sorted(parseMini('c4@1 d4@.5 e4@.5 f4@2'), 0);
    expect(durations.map((h) => [h.startFrac, h.durFrac])).toEqual(weights.map((h) => [h.startFrac, h.durFrac]));
  });

  it('scales by the given beatUnit (meter N/D)', () => {
    // In 7/8 (beatUnit 8), /8 is one beat and /4 is two.
    const p = parseMini('c4/8 d4/4', { beatUnit: 8 });
    const haps = sorted(p, 0);
    expect(haps[0].durFrac).toBeCloseTo(1 / 3, 10);
    expect(haps[1].durFrac).toBeCloseTo(2 / 3, 10);
  });

  it('dotted (.) multiplies by 1.5 and triplet (t) by 2/3', () => {
    expect(sorted(parseMini('c4/4. d4/4.'), 0)[0].durFrac).toBeCloseTo(0.5, 10);
    expect(sorted(parseMini('c4/4t d4/4t d4/4t'), 0)[0].durFrac).toBeCloseTo(1 / 3, 10);
  });

  it('rejects mixing /N durations with @n weights in one pattern', () => {
    expect(() => parseMini('c4/4 d4@2')).toThrow(/mixes \/N durations/);
  });
});

describe('"a!3 b" - replicate', () => {
  it('expands to four equal-share slots: a a a b', () => {
    const p = parseMini('a!3 b');
    const haps = sorted(p, 0);
    expect(haps.map((h) => h.value)).toEqual(['a', 'a', 'a', 'b']);
    expect(haps.map((h) => h.startFrac)).toEqual([0, 0.25, 0.5, 0.75]);
  });
});

describe('"a?" - probabilistic drop', () => {
  it('drops roughly 50% of the time across many cycles', () => {
    const p = parseMini('a?');
    let kept = 0;
    const N = 2000;
    for (let c = 0; c < N; c += 1) {
      if (p.query(c).length > 0) kept += 1;
    }
    const rate = kept / N;
    expect(rate).toBeGreaterThan(0.4);
    expect(rate).toBeLessThan(0.6);
  });

  it('is deterministic: querying the same cycle twice gives the same result', () => {
    const p = parseMini('a?');
    expect(p.query(42)).toEqual(p.query(42));
  });

  it('an explicit probability "a?0.9" drops much more often than "a?0.1"', () => {
    const rareKeep = parseMini('a?0.9');
    const oftenKeep = parseMini('a?0.1');
    const N = 1000;
    let rareKept = 0;
    let oftenKept = 0;
    for (let c = 0; c < N; c += 1) {
      if (rareKeep.query(c).length > 0) rareKept += 1;
      if (oftenKeep.query(c).length > 0) oftenKept += 1;
    }
    expect(rareKept).toBeLessThan(oftenKept);
  });

  it('sibling "?" atoms in the same sequence decorrelate (not identical draws)', () => {
    const p = parseMini('a? b?');
    let bothSame = 0;
    const N = 500;
    for (let c = 0; c < N; c += 1) {
      const haps = p.query(c);
      const aKept = haps.some((h) => h.value === 'a');
      const bKept = haps.some((h) => h.value === 'b');
      if (aKept === bKept) bothSame += 1;
    }
    // If both sites used the exact same draw, this would be ~100%; with
    // independent per-site seeding it should land near 50%.
    expect(bothSame).toBeGreaterThan(150);
    expect(bothSame).toBeLessThan(350);
  });
});

describe('"[g3,b3,e4]" - stack inside brackets', () => {
  it('plays all three notes simultaneously, each spanning the full cycle', () => {
    const p = parseMini('[g3,b3,e4]');
    const haps = sorted(p, 0);
    expect(haps).toHaveLength(3);
    expect(haps.map((h) => h.value).sort((a, b) => a - b)).toEqual([55, 59, 64]); // g3, b3, e4
    expect(haps.every((h) => h.startFrac === 0 && h.durFrac === 1)).toBe(true);
  });
});

describe('rests', () => {
  it('~ and - both produce a rest (no Hap)', () => {
    const p = parseMini('a ~ b -');
    const haps = sorted(p, 0);
    expect(haps.map((h) => h.value)).toEqual(['a', 'b']);
    expect(haps.map((h) => h.startFrac)).toEqual([0, 0.5]);
  });
});

describe('top-level comma stack', () => {
  it('"a b, c" stacks a 2-step sequence against a 1-step sequence', () => {
    const p = parseMini('a b, c');
    const haps = sorted(p, 0);
    expect(haps.map((h) => h.value).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('random choice "a|b|c"', () => {
  it('always picks one of the listed values, never something else', () => {
    const p = parseMini('a|b|c');
    for (let c = 0; c < 100; c += 1) {
      const haps = p.query(c);
      expect(haps).toHaveLength(1);
      expect(['a', 'b', 'c']).toContain(haps[0].value);
    }
  });

  it('is deterministic per cycle and does not always pick the same branch', () => {
    const p = parseMini('a|b|c');
    const seen = new Set();
    for (let c = 0; c < 50; c += 1) {
      expect(p.query(c)).toEqual(p.query(c));
      seen.add(p.query(c)[0].value);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('parse errors', () => {
  it('throws on an unclosed group', () => {
    expect(() => parseMini('[a b')).toThrow();
  });

  it('throws on a stray closing bracket', () => {
    expect(() => parseMini('a b]')).toThrow();
  });
});

// ADR 0003 D5: $name is a structural reference (parseRef()), not text
// substitution - resolved via the refs/weightRefs options, matching the
// $a/$b naming convention rasterklang-dsl's own PatternDecl-time resolution
// uses. Compile-level coverage (F1/F2/$name!n) is in rasterklang-dsl's
// test/dsl/analyze.test.js and test/compiler/arrangements.test.js; this
// file covers the primitive in isolation.
describe('"$name" - structural pattern reference (ADR 0003 D5)', () => {
  it('resolves to the referenced Pattern directly, with absolute sourceStart/sourceEnd via docOffset', () => {
    const a = parseMini('c4 d4', { docOffset: 100 });
    const refs = (name) => (name === 'a' ? a : undefined);
    const p = parseMini('$a e4', { docOffset: 0, refs });
    const haps = sorted(p, 0);
    expect(haps.map((h) => h.value)).toEqual([60, 62, 64]);
    expect(haps[0].sourceStart).toBe(100); // "c4" inside a's OWN parse, docOffset 100
  });

  it('F2: "<$a $a>" is a genuine two-element alternation (one full pass of a per bar), not one token per bar', () => {
    const a = parseMini('c4 d4 e4 f4');
    const refs = (name) => (name === 'a' ? a : undefined);
    const p = parseMini('<$a $a>', { refs });
    expect(sorted(p, 0).map((h) => h.value)).toEqual([60, 62, 64, 65]);
    expect(sorted(p, 1).map((h) => h.value)).toEqual([60, 62, 64, 65]);
  });

  it('$a!3 replicates the WHOLE referenced pattern, not just its last token', () => {
    const a = parseMini('c4 d4');
    const refs = (name) => (name === 'a' ? a : undefined);
    const p = parseMini('$a!3', { refs });
    expect(sorted(p, 0).map((h) => h.value)).toEqual([60, 62, 60, 62, 60, 62]);
  });

  it('F1: a bare $ref\'s default sequence weight is the referenced pattern\'s own beats (via weightRefs), not 1', () => {
    const a = parseMini('c4 d4 e4 f4');
    const refs = (name) => (name === 'a' ? a : undefined);
    const weightRefs = (name) => (name === 'a' ? 4 : undefined);
    // "$a g4": a (weight 4) + g4 (weight 1) = 5 slots; a gets 4/5, g4 gets 1/5.
    const p = parseMini('$a g4', { refs, weightRefs });
    const haps = sorted(p, 0);
    expect(haps.map((h) => h.value)).toEqual([60, 62, 64, 65, 67]);
    expect(haps.map((h) => h.durFrac)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
  });

  it('an explicit @n/duration after $name overrides the reference\'s own weight', () => {
    const a = parseMini('c4 d4 e4 f4');
    const refs = (name) => (name === 'a' ? a : undefined);
    const weightRefs = (name) => (name === 'a' ? 4 : undefined);
    const p = parseMini('$a@1 g4', { refs, weightRefs });
    const haps = sorted(p, 0);
    // a's 4 inner notes fill the FIRST HALF of the cycle (weight 1 of 1+1),
    // not 4/5 as F1's test above shows for the un-overridden default.
    const aSlotDur = haps.slice(0, 4).reduce((sum, h) => sum + h.durFrac, 0);
    expect(aSlotDur).toBeCloseTo(0.5, 9);
    expect(haps[4].durFrac).toBeCloseTo(0.5, 9); // g4's slot: the other 1 of (1+1)
  });

  it('rejects an unresolved reference with a clear error', () => {
    expect(() => parseMini('$missing', { refs: () => undefined })).toThrow(/not defined/);
  });

  it('without a refs resolver, "$" is not a recognized atom (unaffected default behavior)', () => {
    expect(() => parseMini('$a')).toThrow();
  });
});
