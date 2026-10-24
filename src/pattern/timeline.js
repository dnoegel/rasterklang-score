// timeline(entries) - ADR 0003 D4's concatenation primitive: places a list
// of same-shaped patterns end to end in cycle time, each occupying its own
// length, repeating with the period of their sum (ADR 0003 section 5.2,
// in rasterklang-dsl's docs/adr). Arrangements, $name references and
// `*n`/`[...]` grouping are authoring sugar over this.
//
// Concatenating differently-sized blocks cannot be expressed as a single
// `slow`/`fast` factor, because each element needs its own stretch over its
// own span (ADR 0003 section 1.2, failure F3).
//
// entries: [{ lengthCycles, pattern }], where each `pattern` is content
// filling exactly ONE cycle on its own (bar = 1 cycle, matching every
// other cycle-unit convention in this codebase). Definition, from the ADR:
//
//   total    = sum(lengthCycles)
//   offset_i = sum(lengthCycles[0..i-1])
//   element i occupies absolute cycles [offset_i, offset_i + lengthCycles_i)
//      and plays its content once across that span, i.e. pattern_i.slow(lengthCycles_i)
//   the whole repeats with period `total`
//
// query(c) returns the haps falling in the window [c, c+1), mapped into
// that timeline modulo total, with startFrac/durFrac relative to cycle c.
//
// `total` may be fractional (so the window can wrap the period, and can
// even span SEVERAL periods when total < 1), and a Hap must never straddle
// a cycle boundary (query.js's own invariant) - both handled by splitting
// the window at period boundaries first, then at element boundaries within
// each period-local slice, and clipping each entry's own (slowed) pattern
// to its slice via queryCycleRange - the same multi-cycle windowing
// primitive Pattern.fast()/slow() already use, so provenance (source
// positions, etc.) survives the same way: spread first, only
// startFrac/durFrac recomputed.
//
// Negative cycle indices occur (see the backward branch of compile.js's
// makeCycleClock); `Math.floor` (not truncation) keeps the period-index
// arithmetic below correct for negative `c`.
import { discrete, silence, queryCycleRange } from './query.js';

const EPS = 1e-9;

export function timeline(entries) {
  const active = entries.filter((e) => e.lengthCycles > 0);
  const total = active.reduce((sum, e) => sum + e.lengthCycles, 0);
  if (!(total > 0)) return silence();

  const offsets = [];
  let acc = 0;
  for (const e of active) {
    offsets.push(acc);
    acc += e.lengthCycles;
  }
  const slowed = active.map((e) => e.pattern.slow(e.lengthCycles));

  return discrete((c) => {
    const haps = [];
    let winFrom = c;
    const winTo = c + 1;

    while (winTo - winFrom > EPS) {
      // Which repeat of the whole timeline winFrom falls in, and that
      // repeat's own absolute start - Math.floor (not truncation) so this
      // stays correct for a negative winFrom.
      const periodIndex = Math.floor(winFrom / total);
      const periodStartAbs = periodIndex * total;
      const localFrom = winFrom - periodStartAbs;
      const periodEndAbs = periodStartAbs + total;
      const localTo = Math.min(winTo, periodEndAbs) - periodStartAbs;

      for (let i = 0; i < active.length; i += 1) {
        const entryFrom = offsets[i];
        const entryTo = offsets[i] + active[i].lengthCycles;
        const a = Math.max(localFrom, entryFrom);
        const b = Math.min(localTo, entryTo);
        if (b - a <= EPS) continue;

        // This entry's own (slowed) pattern advances by one full cycle
        // every time the OUTER timeline completes a full period - so its
        // query window is offset by periodIndex * lengthCycles_i, not by
        // periodIndex * total - which is what lets a cycle-dependent
        // pattern nested inside an element (e.g. a `<...>` alternation)
        // advance once per timeline repeat instead of freezing.
        const qFrom = periodIndex * active[i].lengthCycles + (a - entryFrom);
        const qTo = periodIndex * active[i].lengthCycles + (b - entryFrom);
        const clipped = queryCycleRange(slowed[i], qFrom, qTo);
        for (const hap of clipped) {
          const { absStart, absDur, ...rest } = hap;
          const entryLocal = absStart - periodIndex * active[i].lengthCycles;
          const periodLocal = entryLocal + entryFrom;
          const trueAbsStart = periodStartAbs + periodLocal;
          haps.push({ ...rest, startFrac: trueAbsStart - c, durFrac: absDur });
        }
      }

      winFrom = periodStartAbs + localTo;
    }

    return haps;
  });
}
