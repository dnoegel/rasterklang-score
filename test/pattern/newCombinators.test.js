// Behaviour tests for the Strudel-derived combinators added in DSL 2.14.0.
// These exercise the pattern engine directly (not through the DSL text
// surface) so a failure points at combinators.js rather than the parser.
import { describe, expect, it } from 'vitest';
import { parseMini } from '../../src/pattern/miniNotation.js';
import { struct, mask, chunk, palindrome, linger, rot, someCyclesBy, superimpose, scale, add, rev } from '../../src/pattern/combinators.js';
import { parseScaleSpec, degreeToMidi, SCALE_INTERVALS } from '../../src/pattern/scales.js';

const values = (p, c = 0) => p.query(c).map((h) => h.value);
const starts = (p, c = 0) => p.query(c).map((h) => Number(h.startFrac.toFixed(4)));

describe('struct / mask', () => {
  it('struct takes the rhythm from the boolean pattern and the value from the pattern', () => {
    const p = struct(parseMini('x ~ x x'), parseMini('c4'));
    expect(starts(p)).toEqual([0, 0.5, 0.75]);
    expect(values(p)).toEqual([60, 60, 60]);
  });

  it('struct treats 0/f as off, so a boolean pattern can be written either way', () => {
    expect(starts(struct(parseMini('1 0 1 1'), parseMini('c4')))).toEqual([0, 0.5, 0.75]);
    expect(starts(struct(parseMini('t f t t'), parseMini('c4')))).toEqual([0, 0.5, 0.75]);
  });

  it("mask keeps the pattern's own rhythm and only filters it (the complement of struct)", () => {
    const p = mask(parseMini('1 0 1 1'), parseMini('c4 d4 e4 f4'));
    expect(starts(p)).toEqual([0, 0.5, 0.75]);
    // Values stay the ORIGINAL ones at those positions -- struct would have
    // resampled them all from a single source pattern.
    expect(values(p)).toEqual([60, 64, 65]);
  });
});

describe('chunk', () => {
  it('transforms a different 1/n slice each cycle, leaving the rest alone', () => {
    const p = chunk(2, (x) => add(12, x), parseMini('c4 d4 e4 f4'));
    expect(values(p, 0)).toEqual([72, 74, 64, 65]); // first half up an octave
    expect(values(p, 1)).toEqual([60, 62, 76, 77]); // second half up an octave
    expect(values(p, 2)).toEqual([72, 74, 64, 65]); // wraps back round
  });
});

describe('palindrome / linger / rot', () => {
  it('palindrome plays forwards on even cycles and reversed on odd', () => {
    expect(values(palindrome(parseMini('c4 d4 e4')), 0)).toEqual([60, 62, 64]);
    const odd = palindrome(parseMini('c4 d4 e4')).query(1).sort((a, b) => a.startFrac - b.startFrac);
    expect(odd.map((h) => h.value)).toEqual([64, 62, 60]);
  });

  it('linger repeats the first fraction of the cycle for the rest of it', () => {
    const p = linger(0.5, parseMini('c4 d4 e4 f4'));
    expect(values(p)).toEqual([60, 62, 60, 62]);
    expect(starts(p)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('rot moves the VALUES and leaves every onset where it was', () => {
    const source = parseMini('c4 d4 e4 f4');
    const rotated = rot(1, source);
    expect(starts(rotated)).toEqual(starts(source));
    expect(values(rotated)).toEqual([62, 64, 65, 60]);
  });
});

describe('someCyclesBy', () => {
  it('decides once per CYCLE, so a chosen cycle is transformed in its entirety', () => {
    const p = someCyclesBy(0.5, rev, parseMini('c4 d4 e4 f4'));
    // Whatever the per-cycle coin flip gives, each cycle must be either the
    // pattern untouched or the whole thing reversed -- never a mix, which is
    // exactly what distinguishes this from sometimesBy's per-event choice.
    for (let c = 0; c < 12; c += 1) {
      const got = p.query(c).sort((a, b) => a.startFrac - b.startFrac).map((h) => h.value);
      expect([[60, 62, 64, 65], [65, 64, 62, 60]]).toContainEqual(got);
    }
  });

  it('is deterministic for a given cycle (seeded), so playback is reproducible', () => {
    const build = () => someCyclesBy(0.5, rev, parseMini('c4 d4 e4 f4'));
    for (let c = 0; c < 8; c += 1) expect(values(build(), c)).toEqual(values(build(), c));
  });
});

describe('superimpose', () => {
  it('plays the original and the transformed copy at once', () => {
    const p = superimpose((x) => add(12, x), parseMini('c4 e4'));
    expect(values(p).sort((a, b) => a - b)).toEqual([60, 64, 72, 76]);
  });
});

describe('scale', () => {
  it('maps degrees to real pitches, so a triad is spelled the same in any key', () => {
    expect(values(scale('c4:minor', parseMini('0 2 4')))).toEqual([60, 63, 67]);
    expect(values(scale('c4:major', parseMini('0 2 4')))).toEqual([60, 64, 67]);
  });

  it('wraps past the end of the scale into the next octave, and downward for negatives', () => {
    expect(values(scale('c4:major', parseMini('7')))).toEqual([72]);
    expect(values(scale('c4:major', parseMini('-1')))).toEqual([59]);
  });

  it('keeps transposition IN KEY, which is the whole point of degrees', () => {
    // Degrees 0/2/4 up two scale steps is 2/4/6 -- a diatonic third, still in
    // C minor. The same `add 2` on raw note numbers would shift by two
    // SEMITONES and leave the key.
    expect(values(scale('c4:minor', add(2, parseMini('0 2 4'))))).toEqual([63, 67, 70]);
  });

  it('reads note-name patterns as degrees, because by then they ARE numbers', () => {
    // Documents a real constraint rather than a feature: miniNotation
    // resolves "c4" to 60 at parse time, so scale() sees degree 60, not the
    // pitch C4. Patterns meant for a scale have to be written as degrees
    // ("0 2 4"), the same split Strudel makes between its `n` and `note`
    // controls. Asserted so the behaviour can't drift silently into a
    // half-working heuristic.
    expect(values(scale('c4:minor', parseMini('c4 e4')))).toEqual([163, 170]);
  });

  it('defaults the root octave to 4, matching what a bare "c4" note name means', () => {
    expect(parseScaleSpec('c:minor').rootMidi).toBe(60);
    expect(parseScaleSpec('c4:minor').rootMidi).toBe(60);
  });

  it('accepts sharps/flats in the root, both spellings', () => {
    expect(parseScaleSpec('fs4:major').rootMidi).toBe(66);
    expect(parseScaleSpec('f#4:major').rootMidi).toBe(66);
    expect(parseScaleSpec('ef4:major').rootMidi).toBe(63);
  });

  it('rejects an unknown scale or a malformed spec rather than silently doing nothing', () => {
    expect(() => parseScaleSpec('c4:nope')).toThrow(/unknown scale/);
    expect(() => parseScaleSpec('c4')).toThrow(/needs a root and a scale name/);
    expect(() => parseScaleSpec('h4:major')).toThrow(/isn't a note name/);
  });

  it('every listed scale is usable and starts on the root', () => {
    for (const name of Object.keys(SCALE_INTERVALS)) {
      expect(degreeToMidi(0, parseScaleSpec(`c4:${name}`))).toBe(60);
    }
  });
});

describe('polymeter {a b c}%n', () => {
  it('lays the sequence over a fixed step grid and keeps running across cycles', () => {
    const p = parseMini('{c4 d4 e4}%4');
    expect(values(p, 0)).toEqual([60, 62, 64, 60]);
    // Cycle 1 starts one element in -- the drift against the bar is the point.
    expect(values(p, 1)).toEqual([62, 64, 60, 62]);
    expect(starts(p, 0)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('defaults the step count to the sequence length, making it a plain sequence', () => {
    expect(values(parseMini('{c4 d4 e4}'), 0)).toEqual([60, 62, 64]);
    expect(values(parseMini('{c4 d4 e4}'), 1)).toEqual([60, 62, 64]);
  });
});
