// Core Pattern/Hap abstraction shared by mini-notation, signals, and every
// combinator under src/pattern/. Nothing in src/pattern/ knows what a SID
// register, voice, or waveform bit is: this is a generic pattern engine and
// the compiler attaches SID meaning to its output.
//
// A Pattern wraps a cycle-relative query. Two flavors exist, and every
// Pattern instance answers both entry points regardless of flavor:
//
// - Discrete: produced by mini-notation sequences, stack/cat/fastcat, etc.
//   query(cycleIndex) -> Hap[], where
//     Hap = { startFrac, durFrac, value }
//   and startFrac/durFrac are fractions of the cycle (0..1, durFrac measured
//   from startFrac - a Hap never straddles a cycle boundary).
// - Continuous (a "signal"): produced by sine/saw/square/tri/rand/perlin.
//   No discrete onsets - only
//     queryAt(cycleIndex, posFrac) -> value
//   "what is the value at this exact point in the cycle".
//
// Every Pattern exposes both query() and queryAt(): for a discrete pattern,
// queryAt() is derived by finding whichever Hap contains posFrac (or
// undefined during a rest); for a continuous pattern, query() is derived by
// sampling queryAt() once at posFrac 0 and wrapping it in a single
// whole-cycle Hap (a reasonable stand-in - continuous patterns don't really
// have "one query() answer"). This lets the compiler ask "give me the value
// at this frame" uniformly via queryAt(), whether the underlying pattern is
// a stepped sequence or a continuous signal.

export class Pattern {
  constructor({ query = null, queryAt = null, isContinuous = false } = {}) {
    if (!query && !queryAt) {
      throw new Error('Pattern needs at least one of query/queryAt.');
    }
    this._query = query;
    this._queryAt = queryAt;
    this.isContinuous = isContinuous;
  }

  query(cycleIndex) {
    if (this._query) return this._query(cycleIndex);
    const value = this._queryAt(cycleIndex, 0);
    return [{ startFrac: 0, durFrac: 1, value }];
  }

  queryAt(cycleIndex, posFrac) {
    if (this._queryAt) return this._queryAt(cycleIndex, posFrac);
    const haps = this._query(cycleIndex);
    for (const hap of haps) {
      if (posFrac >= hap.startFrac && posFrac < hap.startFrac + hap.durFrac) {
        return hap.value;
      }
    }
    return undefined;
  }

  // .fast(n) - speed up by n. Implemented once, here, so mini-notation's
  // `*`, signals.js's `.fast()`, and combinators.js's `fast(n, pattern)`
  // function form all share one implementation instead of three.
  //
  // Discrete case: squeezes n consecutive underlying cycles into one output
  // cycle (via queryCycleRange's multi-cycle windowing below) - this is the
  // textbook Tidal/Strudel semantics, and it's what makes `fast(2, "<a b>")`
  // correctly show two *different* values per output cycle rather than
  // freezing on one.
  //
  // Continuous case: rescales absolute time (cycleIndex + posFrac) by n and
  // re-derives a (cycle, posFrac) pair from the result. Rescaling posFrac
  // alone would never vary with cycleIndex, so `sine.slow(4)` would repeat
  // the same values every cycle instead of stretching one period over 4.
  fast(n) {
    if (n === 0) return silence();
    if (this.isContinuous) {
      return continuous((cycleIndex, posFrac) => {
        const scaledAbs = (cycleIndex + posFrac) * n;
        const newCycle = Math.floor(scaledAbs);
        return this.queryAt(newCycle, scaledAbs - newCycle);
      });
    }
    return discrete((cycleIndex) => {
      const clipped = queryCycleRange(this, cycleIndex * n, cycleIndex * n + n);
      // Spread `rest` (h minus absStart/absDur) first so any extra per-Hap
      // metadata beyond startFrac/durFrac/value (e.g. mini-notation's
      // sourceStart/sourceEnd, see miniNotation.js) survives fast()/slow()
      // rather than being silently dropped by reconstructing a bare
      // {startFrac,durFrac,value} literal.
      return clipped.map(({ absStart, absDur, ...rest }) => ({
        ...rest,
        startFrac: (absStart - cycleIndex * n) / n,
        durFrac: absDur / n,
      }));
    });
  }

  // .slow(n) - function form of `/n`; exactly fast(1/n) for both flavors.
  slow(n) {
    return this.fast(1 / n);
  }

  // .range(lo, hi) - remap a 0..1-valued pattern to lo..hi. Non-numeric
  // values (e.g. word atoms) pass through unchanged.
  range(lo, hi) {
    const scale = (v) => (typeof v === 'number' ? lo + v * (hi - lo) : v);
    if (this.isContinuous) {
      return continuous((c, p) => scale(this.queryAt(c, p)));
    }
    return discrete((c) => this.query(c).map((h) => ({ ...h, value: scale(h.value) })));
  }
}

export function discrete(queryFn) {
  return new Pattern({ query: queryFn, isContinuous: false });
}

export function continuous(queryAtFn) {
  return new Pattern({ queryAt: queryAtFn, isContinuous: true });
}

// pure(value) - a discrete pattern with one Hap spanning the whole cycle.
export function pure(value) {
  return discrete(() => [{ startFrac: 0, durFrac: 1, value }]);
}

// silence() - a discrete pattern with no Haps in any cycle. Used as the
// identity/empty element (rests, `fast(0)`, empty groups).
export function silence() {
  return discrete(() => []);
}

// queryCycleRange(pattern, absFrom, absTo) - query a *discrete* pattern over
// an arbitrary absolute-time window, spanning possibly several integer
// cycles (absFrom/absTo are absolute cycle-fraction times, e.g. 2.5 means
// "halfway through cycle 2", not bounded to a single cycle). Returns Haps
// clipped to that window in absolute time: { absStart, absDur, value }
// (not cycle-relative - callers rebase as needed).
//
// This is the shared primitive behind Pattern.fast()/slow() and
// combinators.js's shiftedBy(). Strudel's query algebra is more general,
// but this engine is only ever sampled at single points once per SID frame,
// so a simple multi-cycle windowing helper is enough.
export function queryCycleRange(pattern, absFrom, absTo) {
  const results = [];
  if (!(absTo > absFrom)) return results;
  const EPS = 1e-9;
  let c = Math.floor(absFrom);
  while (c < absTo) {
    const haps = pattern.query(c);
    for (const hap of haps) {
      const hapAbsStart = c + hap.startFrac;
      const hapAbsEnd = hapAbsStart + hap.durFrac;
      const clipStart = Math.max(hapAbsStart, absFrom);
      const clipEnd = Math.min(hapAbsEnd, absTo);
      if (clipEnd - clipStart > EPS) {
        // Drop the original cycle-relative startFrac/durFrac (this function
        // defines its own absStart/absDur instead) but keep any other extra
        // per-Hap metadata (e.g. mini-notation source positions) so it
        // survives this multi-cycle windowing instead of being dropped.
        const { startFrac, durFrac, ...rest } = hap;
        results.push({ ...rest, absStart: clipStart, absDur: clipEnd - clipStart });
      }
    }
    c += 1;
  }
  return results;
}
