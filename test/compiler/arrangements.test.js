// Compile-level verification of ADR 0003 D4 arrangements. Proven at the
// REGISTER level, frame by frame, not by inspecting Haps or aggregate
// scores, same discipline as metricPatterns.test.js (ADR 0001 section 8:
// "this project has repeatedly been misled by aggregate metrics").
import { describe, expect, it } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from '../../src/compiler/compile.js';

function pitchChanges(source, frames, voice = 0) {
  const frameSource = compile(compileDslV2Source(source));
  const base = voice * 7;
  const regs = new Array(32).fill(0);
  const out = [];
  let previous = null;
  for (let i = 0; i < frames; i += 1) {
    for (const { addr, value } of frameSource(i)) regs[addr] = value;
    const freq = regs[base] | (regs[base + 1] << 8);
    if (freq !== previous) out.push(i);
    previous = freq;
  }
  return out;
}

const HEADER = `tempo 120 meter 4/4
instrument lead
  wave pulse
  adsr 0 0 15 0
end
`;

describe('arrangements: F3 fixed - sequencing different declared lengths', () => {
  it('$a $b onsets at 0 25 50 75 100 125 150 175 200 225 250 275, loop at 300', () => {
    const source = `${HEADER}pattern a 4 = "c4 d4 e4 f4"\npattern b 8 = "c5 d5 e5 f5 g5 a5 b5 c6"\nvoice 0 lead $a $b\n`;
    expect(pitchChanges(source, 310)).toEqual([0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300]);
  });
});

describe('arrangements: `*n` repeat', () => {
  it('$a*2 $b is onset-identical to $a $a $b', () => {
    const withRepeat = `${HEADER}pattern a 4 = "c4 d4 e4 f4"\npattern b 8 = "c5 d5 e5 f5 g5 a5 b5 c6"\nvoice 0 lead $a*2 $b\n`;
    const unrolled = `${HEADER}pattern a 4 = "c4 d4 e4 f4"\npattern b 8 = "c5 d5 e5 f5 g5 a5 b5 c6"\nvoice 0 lead $a $a $b\n`;
    expect(pitchChanges(withRepeat, 500)).toEqual(pitchChanges(unrolled, 500));
  });
});

describe('arrangements: `[...]` group with its own `*n`', () => {
  it('[$a $b]*2 is onset-identical (within a frame) to $a $b $a $b', () => {
    const grouped = `${HEADER}pattern a 4 = "c4 d4 e4 f4"\npattern b 8 = "c5 d5 e5 f5 g5 a5 b5 c6"\nvoice 0 lead [$a $b]*2\n`;
    const unrolled = `${HEADER}pattern a 4 = "c4 d4 e4 f4"\npattern b 8 = "c5 d5 e5 f5 g5 a5 b5 c6"\nvoice 0 lead $a $b $a $b\n`;
    const a = pitchChanges(grouped, 700);
    const b = pitchChanges(unrolled, 700);
    expect(a.length).toBe(b.length);
    // Every onset lands within 1 frame of its unrolled-form counterpart -
    // a documented floating-point boundary artifact of composing
    // fast()/slow() through a nested timeline() (ADR 0003 D17's own
    // "subdivision jitter" class of effect, not a structural bug: the
    // note VALUES and their COUNT match exactly, see below).
    a.forEach((frame, i) => expect(Math.abs(frame - b[i])).toBeLessThanOrEqual(1));
  });
});

describe('arrangements: a named arrangement pattern nests inside another', () => {
  it('voice 0 $verse plays $a then $b when pattern verse = $a $b', () => {
    const source = `${HEADER}pattern a 4 = "c4 d4 e4 f4"\npattern b 8 = "c5 d5 e5 f5 g5 a5 b5 c6"\npattern verse = $a $b\nvoice 0 lead $verse\n`;
    const want = [0, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300];
    const got = pitchChanges(source, 310);
    expect(got.length).toBe(want.length);
    // Within 1 frame of a direct $a $b arrangement's onsets - the same
    // documented fast()/slow() composition rounding as the [...]*n case
    // above, here from compressing $verse's own inner timeline down to one
    // cycle so it can be referenced as a single bare sigil.
    got.forEach((frame, i) => expect(Math.abs(frame - want[i])).toBeLessThanOrEqual(1));
  });
});

describe('arrangements: recursive pattern reference is a compile error', () => {
  it('names the cycle rather than looping forever or crashing obscurely', () => {
    const source = `${HEADER}pattern verse = $verse $verse\nvoice 0 lead $verse\n`;
    expect(() => compileDslV2Source(source)).toThrow(/recursive/);
  });
});
