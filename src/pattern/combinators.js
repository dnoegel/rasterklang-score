// Generic pattern-transformation combinators, modeled on Strudel/TidalCycles.
// Operate purely on the abstract Pattern/Hap model from query.js - nothing
// here knows about SID registers, voices, or audio; the compiler attaches
// that meaning. Most of these only make sense for discrete patterns; where a
// combinator is a no-op or not really meaningful for a continuous signal,
// that's noted inline.

import { discrete, continuous, silence, queryCycleRange, Pattern } from './query.js';
import { seededRandom01 } from './prng.js';
import { parseScaleSpec, degreeToMidi } from './scales.js';

// rev(pattern) - reverse Hap order/positions within each cycle. Also
// well-defined for a continuous signal (reflect posFrac).
export function rev(pattern) {
  if (pattern.isContinuous) {
    return continuous((c, p) => pattern.queryAt(c, 1 - p));
  }
  return discrete((c) =>
    pattern.query(c).map((h) => ({
      ...h,
      startFrac: 1 - h.startFrac - h.durFrac,
    })),
  );
}

// fast(n, pattern) / slow(n, pattern) - function form of `*`/`/`. Both
// flavors are implemented once as Pattern methods (query.js); these are
// thin wrappers so every module (mini-notation, signals, combinators) uses
// the same code path instead of three near-duplicates.
export function fast(n, pattern) {
  return pattern.fast(n);
}

export function slow(n, pattern) {
  return pattern.slow(n);
}

// every(n, fn, pattern) - apply fn(pattern) only on cycles where
// cycleIndex % n === 0; otherwise pass the pattern through unchanged.
export function every(n, fn, pattern) {
  const transformed = fn(pattern);
  if (pattern.isContinuous) {
    return continuous((c, p) => (c % n === 0 ? transformed.queryAt(c, p) : pattern.queryAt(c, p)));
  }
  return discrete((c) => (c % n === 0 ? transformed.query(c) : pattern.query(c)));
}

// iter(n, pattern) - rotate step order by one position each cycle, over n
// cycles (cycle 0 = original order, cycle n = back to original). Assumes
// the pattern's per-cycle Hap count matches n (the typical usage, e.g.
// iter(4, "0 1 2 3")); if it doesn't, rotation still runs modulo the actual
// Hap count so it degrades gracefully instead of throwing.
export function iter(n, pattern) {
  return discrete((c) => {
    const haps = pattern.query(c);
    const k = haps.length;
    if (k === 0) return haps;
    const shift = ((c % n) + n) % n;
    // The rotated-in value comes from a *different* Hap than the slot's own
    // timing - so extra metadata (e.g. mini-notation source positions) must
    // follow the value's origin (`rotated`), not the display slot (`h`), or
    // a later "which source text is this playing" lookup would point at the
    // wrong token.
    return haps.map((h, i) => {
      const rotated = haps[(i + shift) % k];
      return { ...rotated, startFrac: h.startFrac, durFrac: h.durFrac };
    });
  });
}

// ply(n, pattern) - subdivide each Hap into n equal retriggers of the same
// value within its own slot.
export function ply(n, pattern) {
  return discrete((c) => {
    const result = [];
    for (const h of pattern.query(c)) {
      const subDur = h.durFrac / n;
      for (let i = 0; i < n; i += 1) {
        result.push({ ...h, startFrac: h.startFrac + i * subDur, durFrac: subDur });
      }
    }
    return result;
  });
}

// shiftedBy(pattern, timeFrac) - offset every Hap's start time by timeFrac
// (a fraction of a cycle), wrapping into neighbouring cycles as needed.
// Built on queryCycleRange so it composes correctly with patterns that vary
// cycle-to-cycle (e.g. alternation), the same way fast()/slow() do.
export function shiftedBy(pattern, timeFrac) {
  if (pattern.isContinuous) {
    return continuous((c, p) => {
      const abs = c + p - timeFrac;
      const cycle = Math.floor(abs);
      return pattern.queryAt(cycle, abs - cycle);
    });
  }
  return discrete((c) => {
    const clipped = queryCycleRange(pattern, c - timeFrac, c + 1 - timeFrac);
    // Spread `rest` first so extra per-Hap metadata (e.g. mini-notation
    // source positions) survives off()/shiftedBy(), same reasoning as
    // Pattern.fast() in query.js.
    return clipped.map(({ absStart, absDur, ...rest }) => ({
      ...rest,
      startFrac: absStart + timeFrac - c,
      durFrac: absDur,
    }));
  });
}
// Also available as pattern.shiftedBy(timeFrac), as used by off(). Attached
// here rather than in query.js, which only owns the fast/slow/range
// primitives.
Pattern.prototype.shiftedBy = function shiftedByMethod(timeFrac) {
  return shiftedBy(this, timeFrac);
};

// off(timeFrac, fn, pattern) - stack the original with a copy shifted by
// timeFrac and transformed by fn: echo / call-response.
export function off(timeFrac, fn, pattern) {
  return stack(pattern, fn(pattern).shiftedBy(timeFrac));
}

// jux(fn, pattern) - this generic engine has no concept of stereo or SID
// voices, so it just returns the { left, right } pair; the compiler assigns
// left/right to hardware voices.
export function jux(fn, pattern) {
  return { left: pattern, right: fn(pattern) };
}

// degradeBy(p)/sometimesBy(p, fn) share a seeded-PRNG partition of a
// queried cycle's Haps, keyed by (cycleIndex, hapIndexWithinCycle) - same
// (cycle, index) always makes the same keep/drop decision, so playback is
// reproducible. `keepAboveThreshold` selects which side of the p threshold
// this call keeps.
function selectByPRNG(pattern, p, keepAboveThreshold, tag) {
  return discrete((c) =>
    pattern.query(c).filter((h, i) => {
      const r = seededRandom01(c, i, tag);
      return keepAboveThreshold ? r >= p : r < p;
    }),
  );
}

// degradeBy(p, pattern) - drop each Hap with probability p.
export function degradeBy(p, pattern) {
  return selectByPRNG(pattern, p, true, 'degradeBy');
}

// sometimesBy(p, fn, pattern) - apply fn to a p-fraction of Haps. Modeled
// on Tidal's actual definition (stack the untouched (1-p) subset with
// fn applied to *just* the selected p-subset pattern), not a same-index
// merge of two independently-queried full patterns - that distinction
// matters once fn changes Hap count/timing (e.g. fn = rev, fast, ply): fn
// only ever sees the subset it's meant to transform.
export function sometimesBy(p, fn, pattern) {
  const unaffected = selectByPRNG(pattern, p, true, 'sometimesBy');
  const affected = selectByPRNG(pattern, p, false, 'sometimesBy');
  return stack(unaffected, fn(affected));
}

// add(n, pattern) - add n to every Hap's (or signal sample's) numeric
// value; works for note patterns as transposition and for numeric control
// patterns as an offset. Non-numeric values (e.g. word/sample-name atoms)
// pass through unchanged.
export function add(n, pattern) {
  const bump = (v) => (typeof v === 'number' ? v + n : v);
  if (pattern.isContinuous) {
    return continuous((c, p) => bump(pattern.queryAt(c, p)));
  }
  return discrete((c) => pattern.query(c).map((h) => ({ ...h, value: bump(h.value) })));
}

// stack(...patterns) - simultaneous union: every pattern's Haps for a cycle
// all play at once. Reads each input through query() (defined for
// continuous patterns too, via query.js's single-Hap-per-cycle fallback),
// so stacking a continuous pattern in with discrete ones degrades
// gracefully rather than throwing - though stacking raw control signals is
// an unusual use of stack; chain add()/range() for combining signals.
export function stack(...patterns) {
  return discrete((c) => {
    const all = [];
    for (const p of patterns) {
      all.push(...p.query(c));
    }
    return all;
  });
}

// cat(...patterns) - one whole pattern per cycle, cycling through the list.
// Queries the selected pattern at the *true* global cycle index (not
// cycleIndex/n) - this is what makes a pattern nested inside a cat() entry
// (e.g. an inner `<a b>`) advance correctly every time it's selected,
// matching Strudel/Tidal's slowcat rather than dividing time per-pattern.
export function cat(...patterns) {
  const n = patterns.length;
  if (n === 0) return silence();
  return discrete((c) => {
    const idx = ((c % n) + n) % n;
    return patterns[idx].query(c);
  });
}

// fastcat(...patterns) - this is what mini-notation's `[a b]` subdivision
// (and a plain unweighted sequence) desugars to: each slot gets 1/n of the
// cycle, in order.
//
// Deliberately NOT `fast(n, cat(...patterns))`, the textbook Tidal
// definition: that queries slot `i` at the squeezed cycle index `c*n + i`,
// so a nested `<a b c d>` inside an 8-step sequence never leaves whichever
// entry `(8*c+i) % 4` lands on. Tidal/Strudel behave that way; here a nested
// `<...>` advances exactly one entry per real cycle. Each slot's pattern is
// queried at the real cycle `c` and only its timing is compressed into the
// slot. Explicit `.fast(n)` (the `*n` modifier) keeps the squeeze semantics,
// since speeding a pattern up is exactly when it should advance faster.
export function fastcat(...patterns) {
  const n = patterns.length;
  if (n === 0) return silence();
  return discrete((c) => {
    const haps = [];
    for (let i = 0; i < n; i += 1) {
      for (const h of patterns[i].query(c)) {
        haps.push({
          ...h,
          startFrac: (i + h.startFrac) / n,
          durFrac: h.durFrac / n,
        });
      }
    }
    return haps;
  });
}

// struct(boolPattern, pattern) - take the RHYTHM from boolPattern and the
// VALUES from pattern. A truthy Hap in boolPattern becomes an event whose
// value is whatever `pattern` holds at that moment; a falsy one becomes
// silence.
//
// This is the tracker-shaped way to write drums: the rhythm lives in one
// readable "x ~ x x" string, independent of what's being triggered, so the
// two can be edited (and reused) separately. Truthiness follows Strudel's
// mini-notation convention, where the usual spelling is `x`/`t` for on and
// `~` (a rest, which produces no Hap at all) for off; an explicit `0`/`f`
// also reads as off.
export function struct(boolPattern, pattern) {
  return discrete((c) =>
    boolPattern
      .query(c)
      .filter((h) => isTruthyStructValue(h.value))
      .map((h) => {
        // The value is sampled at the START of the boolean Hap: that's the
        // moment the event is triggered, and for a note pattern it's the only
        // point that corresponds to a real onset.
        const value = pattern.queryAt(c, h.startFrac);
        return { ...h, value };
      })
      .filter((h) => h.value !== undefined),
  );
}

function isTruthyStructValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '0' && v !== 'f' && v !== 'false';
  return Boolean(v);
}

// mask(boolPattern, pattern) - keep pattern's own events, but drop the ones
// falling where boolPattern is falsy. The complement of struct(): struct
// takes its rhythm from the boolean pattern, mask keeps the original rhythm
// and only filters it.
export function mask(boolPattern, pattern) {
  return discrete((c) => {
    const gates = boolPattern.query(c).filter((h) => isTruthyStructValue(h.value));
    return pattern.query(c).filter((h) =>
      gates.some((g) => h.startFrac >= g.startFrac && h.startFrac < g.startFrac + g.durFrac),
    );
  });
}

// chunk(n, fn, pattern) - apply fn to a different 1/n slice of the cycle each
// cycle, cycling through all n slices over n cycles.
//
// The point is gradual variation: `every` transforms a whole cycle at once
// (all or nothing), whereas chunk keeps most of the pattern intact and moves
// the affected window along, which is how a tracker song usually varies a
// repeated phrase.
export function chunk(n, fn, pattern) {
  const transformed = fn(pattern);
  return discrete((c) => {
    const slice = ((c % n) + n) % n;
    const lo = slice / n;
    const hi = (slice + 1) / n;
    const inSlice = (h) => h.startFrac >= lo && h.startFrac < hi;
    return [...pattern.query(c).filter((h) => !inSlice(h)), ...transformed.query(c).filter(inSlice)].sort(
      (a, b) => a.startFrac - b.startFrac,
    );
  });
}

// palindrome(pattern) - play forwards on even cycles, reversed on odd ones.
export function palindrome(pattern) {
  const reversed = rev(pattern);
  if (pattern.isContinuous) {
    return continuous((c, p) => (Math.abs(c % 2) === 1 ? reversed.queryAt(c, p) : pattern.queryAt(c, p)));
  }
  return discrete((c) => (Math.abs(c % 2) === 1 ? reversed.query(c) : pattern.query(c)));
}

// linger(frac, pattern) - take the first `frac` of the cycle and repeat it
// for the rest of the cycle, so a phrase "sticks" on its own opening.
export function linger(frac, pattern) {
  if (frac <= 0 || frac > 1) return pattern;
  return discrete((c) => {
    const head = pattern.query(c).filter((h) => h.startFrac < frac);
    const out = [];
    const repeats = Math.ceil(1 / frac);
    for (let i = 0; i < repeats; i += 1) {
      for (const h of head) {
        const startFrac = h.startFrac + i * frac;
        if (startFrac >= 1) continue;
        out.push({ ...h, startFrac, durFrac: Math.min(h.durFrac, 1 - startFrac) });
      }
    }
    return out;
  });
}

// rot(n, pattern) - rotate the VALUES by n while leaving the rhythm alone.
// Distinct from iter(), which rotates whole events (values and timing
// together); rot keeps every onset exactly where it was and slides only what
// is played at each one.
export function rot(n, pattern) {
  return discrete((c) => {
    const haps = pattern.query(c);
    const k = haps.length;
    if (k === 0) return haps;
    const shift = ((n % k) + k) % k;
    return haps.map((h, i) => {
      const source = haps[(i + shift) % k];
      // Value-carrying metadata follows the VALUE's origin, timing follows
      // the slot -- same split iter() documents.
      const { startFrac, durFrac } = h;
      return { ...source, startFrac, durFrac };
    });
  });
}

// someCyclesBy(probability, fn, pattern) - apply fn to WHOLE cycles, chosen
// at random with the given probability. sometimesBy() decides per event,
// which for a note pattern means a scattered mix within one bar; this decides
// once per cycle, giving "every so often, a different bar" instead.
export function someCyclesBy(probability, fn, pattern) {
  const transformed = fn(pattern);
  const pick = (c) => seededRandom01(`someCycles:${c}`) < probability;
  if (pattern.isContinuous) {
    return continuous((c, p) => (pick(c) ? transformed.queryAt(c, p) : pattern.queryAt(c, p)));
  }
  return discrete((c) => (pick(c) ? transformed.query(c) : pattern.query(c)));
}

// superimpose(fn, pattern) - play the pattern AND a transformed copy at the
// same time. Identical in spirit to jux() (which this project already
// documents as claiming a second hardware voice, since one SID oscillator
// cannot sound two notes at once); superimpose is the name for the same
// operation without jux's stereo-panning connotation, which is meaningless
// on a real SID anyway.
export function superimpose(fn, pattern) {
  return stack(pattern, fn(pattern));
}

// scale(spec, pattern) - reinterpret the pattern's NUMERIC values as scale
// degrees, mapping each to a real pitch in the given key ("c4:minor").
//
// This is what makes transposition musical rather than chromatic: with
// degrees, `add 2` moves a phrase two SCALE steps and it stays in key,
// whereas on raw note numbers the same `add 2` shifts everything by two
// semitones and leaves the key behind.
//
// IMPORTANT, and easy to get wrong: the pattern must actually contain
// DEGREES. Note names are resolved to MIDI numbers by miniNotation.js at
// parse time ("c4" IS 60), so `scale` cannot tell a degree from an already-
// resolved pitch and would read that 60 as "degree 60" - several octaves up.
// Applying scale() to a note-name pattern is therefore meaningless, not a
// no-op. Strudel draws the same line by having a separate `n` (degree)
// control alongside `note`; here it is a matter of writing "0 2 4" rather
// than "c4 ef4 g4" in a pattern you intend to put through a scale. Rests are
// safe either way, since they produce no Hap at all. The typeof guard below
// only skips values that aren't numbers to begin with (a waveform-name
// pattern, say) rather than corrupting them.
export function scale(spec, pattern) {
  const resolved = parseScaleSpec(spec);
  return discrete((c) =>
    pattern.query(c).map((h) => (typeof h.value === 'number' ? { ...h, value: degreeToMidi(h.value, resolved) } : h)),
  );
}
