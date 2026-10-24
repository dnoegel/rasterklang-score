import { describe, expect, it } from 'vitest';
import { parseMini, parseMiniForHighlight, REST } from '../../src/pattern/miniNotation.js';
import { rev, iter, ply, off, fast, slow } from '../../src/pattern/combinators.js';

// Strudel-style "highlight the currently sounding note" (see compile.js's
// lastFrame.voices[].sourceStart/sourceEnd) depends on
// every combinator preserving a Hap's extra metadata fields (sourceStart/
// sourceEnd, set by miniNotation.js's pureWithSource) instead of dropping
// them by reconstructing bare {startFrac,durFrac,value} literals. These
// tests check that survival directly, independent of the SID compiler.

function sourceOf(str, hap) {
  return str.slice(hap.sourceStart, hap.sourceEnd);
}

// Haps aren't guaranteed to come back in time order from query() (rev()
// keeps the original array order but flips each Hap's own startFrac) - sort
// by startFrac first wherever a test cares about temporal order, not
// query()'s iteration order.
function sourcesInTimeOrder(str, haps) {
  return [...haps].sort((a, b) => a.startFrac - b.startFrac).map((h) => sourceOf(str, h));
}

describe('mini-notation source position tracking', () => {
  it('tags each leaf atom with its exact character range', () => {
    const str = 'c4 e4 g4';
    const haps = parseMini(str).query(0);
    expect(haps.map((h) => sourceOf(str, h))).toEqual(['c4', 'e4', 'g4']);
  });

  it('survives subdivision ([...]) and fastcat', () => {
    const str = 'c4 [e4 g4]';
    const haps = parseMini(str).query(0);
    expect(haps.map((h) => sourceOf(str, h))).toEqual(['c4', 'e4', 'g4']);
  });

  it('survives alternation (<...>) across cycles', () => {
    const str = '<c4 e4 g4>';
    const p = parseMini(str);
    expect([0, 1, 2].map((c) => sourceOf(str, p.query(c)[0]))).toEqual(['c4', 'e4', 'g4']);
  });

  it('survives weighted sequences (@n)', () => {
    const str = 'c4@2 e4';
    const haps = parseMini(str).query(0);
    expect(haps.map((h) => sourceOf(str, h))).toEqual(['c4', 'e4']);
  });

  it('survives stacks (,)', () => {
    const str = '[c4,e4,g4]';
    const haps = parseMini(str).query(0);
    expect(new Set(haps.map((h) => sourceOf(str, h)))).toEqual(new Set(['c4', 'e4', 'g4']));
  });

  it('fast()/slow() preserve source positions', () => {
    const str = 'c4 e4';
    const p = parseMini(str);
    expect(sourcesInTimeOrder(str, fast(2, p).query(0))).toEqual(['c4', 'e4', 'c4', 'e4']);
    // slow(2, "c4 e4") stretches one cycle's worth of content over 2 cycles:
    // cycle 0 only reaches "c4", cycle 1 reaches "e4".
    const slowed = slow(2, p);
    expect(sourcesInTimeOrder(str, slowed.query(0))).toEqual(['c4']);
    expect(sourcesInTimeOrder(str, slowed.query(1))).toEqual(['e4']);
  });

  it('rev() preserves source positions (just reorders timing)', () => {
    const str = 'c4 e4 g4 a4';
    const haps = rev(parseMini(str)).query(0);
    expect(sourcesInTimeOrder(str, haps)).toEqual(['a4', 'g4', 'e4', 'c4']);
  });

  it('ply(n) preserves the source position on every retrigger', () => {
    const str = 'c4 e4';
    const haps = ply(3, parseMini(str)).query(0);
    expect(sourcesInTimeOrder(str, haps)).toEqual(['c4', 'c4', 'c4', 'e4', 'e4', 'e4']);
  });

  it('iter(n) follows the rotated *value*, not the display slot', () => {
    const str = 'c4 e4 g4 a4';
    const it_ = iter(4, parseMini(str));
    // cycle 1 rotates in "e4" (source index 1) at slot 0.
    const cycle1 = it_.query(1);
    expect(sourceOf(str, cycle1[0])).toBe('e4');
  });

  it('off()/shiftedBy() preserve source positions on both the original and the echoed copy', () => {
    const str = 'c4 e4';
    const p = parseMini(str);
    const withEcho = off(0.25, (x) => x, p);
    // Original c4[0,0.5)/e4[0.5,1) stacked with a 0.25-shifted copy that
    // wraps a trailing sliver of the *previous* cycle's e4 in at [0,0.25)  -
    // every Hap should still resolve to a real substring of the source
    // string, and the un-shifted original pair must both be present intact.
    const sources = withEcho.query(0).map((h) => sourceOf(str, h));
    expect(sources).toEqual(expect.arrayContaining(['c4', 'e4']));
    for (const s of sources) expect(['c4', 'e4']).toContain(s);
  });
});

describe('parseMiniForHighlight (~ produces a positioned REST Hap, unlike parseMini)', () => {
  it('parseMini keeps rests as zero Haps (unchanged, audio-facing default)', () => {
    const str = 'c4 ~ e4';
    const haps = parseMini(str).query(0);
    expect(haps.map((h) => h.value)).toEqual([60, 64]);
  });

  it('parseMiniForHighlight gives the rest its own positioned Hap, tagged REST', () => {
    const str = 'c4 ~ e4';
    const haps = parseMiniForHighlight(str).query(0);
    expect(haps).toHaveLength(3);
    expect(haps.map((h) => h.value)).toEqual([60, REST, 64]);
    const restHap = haps.find((h) => h.value === REST);
    expect(str.slice(restHap.sourceStart, restHap.sourceEnd)).toBe('~');
  });

  it('parseMiniForHighlight agrees with parseMini on timing/step boundaries', () => {
    const str = 'c4 ~ e4 ~';
    const audioHaps = parseMini(str).query(0);
    const highlightHaps = parseMiniForHighlight(str).query(0);
    // Same real notes at the same positions...
    expect(audioHaps.map((h) => [h.startFrac, h.value])).toEqual([
      [0, 60],
      [0.5, 64],
    ]);
    // ...the highlight version just additionally has Haps for the two rests,
    // at the same slot boundaries a plain sequence would give them.
    expect(highlightHaps.map((h) => h.startFrac)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('handles the bare "-" rest synonym the same way as "~"', () => {
    const str = 'c4 -';
    const haps = parseMiniForHighlight(str).query(0);
    expect(haps.map((h) => h.value)).toEqual([60, REST]);
    expect(str.slice(haps[1].sourceStart, haps[1].sourceEnd)).toBe('-');
  });
});
