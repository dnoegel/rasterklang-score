// Continuous 0..1 signal generators - no discrete onsets, just "what's the
// value at this point in the cycle" (see query.js's continuous()/queryAt()).
// `.range(lo,hi)`, `.slow(n)`, `.fast(n)` are Pattern methods (query.js) so
// they're implemented exactly once and work identically whether chained
// onto one of these signals or onto a discrete mini-notation pattern - e.g.
// `sine.range(200,2000).slow(4)`.
//
// SID-agnostic: these are plain 0..1 (or, post-`.range()`, lo..hi) numeric
// waveforms. The compiler decides what a signal chained onto `cutoff` or
// `pulseWidth` means; this module has no opinion.

import { continuous } from './query.js';
import { seededRandom01 } from './prng.js';

function sineAt(posFrac) {
  return (Math.sin(2 * Math.PI * posFrac) + 1) / 2;
}

function sawAt(posFrac) {
  return posFrac;
}

function squareAt(posFrac) {
  return posFrac < 0.5 ? 0 : 1;
}

function triAt(posFrac) {
  return posFrac < 0.5 ? 2 * posFrac : 2 * (1 - posFrac);
}

export const sine = continuous((_cycleIndex, posFrac) => sineAt(posFrac));
export const saw = continuous((_cycleIndex, posFrac) => sawAt(posFrac));
export const square = continuous((_cycleIndex, posFrac) => squareAt(posFrac));
export const tri = continuous((_cycleIndex, posFrac) => triAt(posFrac));

// rand - seeded PRNG keyed by (cycleIndex, posFrac), so it's a genuinely
// noisy (non-continuous-looking) signal, but fully reproducible: querying
// the same point twice always returns the same value.
export const rand = continuous((cycleIndex, posFrac) => seededRandom01(cycleIndex, posFrac, 'rand'));

// perlin - a smoothed-noise approximation, not real Perlin noise: value
// noise over a small per-cycle lattice, smoothstep-interpolated between
// lattice points. Deterministic via the same seeded hash as `rand`. Lattice
// points are keyed per cycle (no cross-cycle blending), so there can be a
// small discontinuity at a cycle boundary.
const PERLIN_LATTICE_PER_CYCLE = 8;

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

export const perlin = continuous((cycleIndex, posFrac) => {
  const scaledPos = posFrac * PERLIN_LATTICE_PER_CYCLE;
  const i0 = Math.floor(scaledPos);
  const i1 = i0 + 1;
  const t = smoothstep(scaledPos - i0);
  const v0 = seededRandom01(cycleIndex, i0, 'perlin');
  const v1 = seededRandom01(cycleIndex, i1, 'perlin');
  return v0 + (v1 - v0) * t;
});
