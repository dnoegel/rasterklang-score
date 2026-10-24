import { describe, expect, it } from 'vitest';
import { pure, continuous } from '../../src/pattern/query.js';
import {
  rev,
  fast,
  slow,
  every,
  iter,
  ply,
  shiftedBy,
  off,
  jux,
  degradeBy,
  sometimesBy,
  add,
  stack,
  cat,
  fastcat,
} from '../../src/pattern/combinators.js';

// A tiny fixed 4-step numeric pattern, cycle-invariant, used across several
// combinator tests below (values chosen so rotation/order changes are easy
// to eyeball: 0 1 2 3).
function fourStepPattern() {
  return fastcat(pure(0), pure(1), pure(2), pure(3));
}

function continuousRamp() {
  return continuous((_cycleIndex, posFrac) => posFrac);
}

function values(pattern, cycleIndex) {
  return pattern
    .query(cycleIndex)
    .slice()
    .sort((a, b) => a.startFrac - b.startFrac)
    .map((h) => h.value);
}

describe('rev', () => {
  it('reverses Hap order/positions within the cycle', () => {
    const p = fastcat(pure('a'), pure('b'), pure('c'));
    expect(values(p, 0)).toEqual(['a', 'b', 'c']);
    expect(values(rev(p), 0)).toEqual(['c', 'b', 'a']);
  });
});

describe('fast/slow (function form)', () => {
  it('fast(n, pattern) matches pattern.fast(n)', () => {
    const p = fastcat(pure('a'), pure('b'));
    expect(fast(2, p).query(0)).toEqual(p.fast(2).query(0));
  });

  it('slow(n, pattern) matches pattern.slow(n)', () => {
    const p = fastcat(pure('a'), pure('b'));
    expect(slow(2, p).query(0)).toEqual(p.slow(2).query(0));
  });
});

describe('every(n, fn, pattern)', () => {
  it('applies fn only on cycles where cycleIndex % n === 0, otherwise passes through', () => {
    const p = fastcat(pure('a'), pure('b'), pure('c'));
    const everied = every(4, rev, p);

    // Cycles 0, 4, 8: reversed.
    expect(values(everied, 0)).toEqual(['c', 'b', 'a']);
    expect(values(everied, 4)).toEqual(['c', 'b', 'a']);
    expect(values(everied, 8)).toEqual(['c', 'b', 'a']);

    // All other cycles: unchanged.
    expect(values(everied, 1)).toEqual(['a', 'b', 'c']);
    expect(values(everied, 2)).toEqual(['a', 'b', 'c']);
    expect(values(everied, 3)).toEqual(['a', 'b', 'c']);
    expect(values(everied, 5)).toEqual(['a', 'b', 'c']);
  });
});

describe('iter(n, pattern)', () => {
  it('rotates step order by one position per cycle, over n cycles, then repeats', () => {
    const p = fourStepPattern();
    const iterated = iter(4, p);

    expect(values(iterated, 0)).toEqual([0, 1, 2, 3]);
    expect(values(iterated, 1)).toEqual([1, 2, 3, 0]);
    expect(values(iterated, 2)).toEqual([2, 3, 0, 1]);
    expect(values(iterated, 3)).toEqual([3, 0, 1, 2]);
    expect(values(iterated, 4)).toEqual([0, 1, 2, 3]);
  });
});

describe('ply(n, pattern)', () => {
  it('triples Hap count per original Hap, same value repeated within its own slot', () => {
    const p = fastcat(pure('a'), pure('b'));
    const plied = ply(3, p);
    const haps = plied.query(0).slice().sort((a, b) => a.startFrac - b.startFrac);

    expect(haps).toHaveLength(6);
    expect(haps.map((h) => h.value)).toEqual(['a', 'a', 'a', 'b', 'b', 'b']);
    // Each retrigger of 'a' fits inside 'a's original [0, 0.5) slot.
    expect(haps[0].startFrac).toBeCloseTo(0, 10);
    expect(haps[2].startFrac + haps[2].durFrac).toBeCloseTo(0.5, 10);
    // Each retrigger of 'b' fits inside 'b's original [0.5, 1) slot.
    expect(haps[3].startFrac).toBeCloseTo(0.5, 10);
    expect(haps[5].startFrac + haps[5].durFrac).toBeCloseTo(1, 10);
  });
});

describe('shiftedBy', () => {
  it('offsets Hap start times by a cycle fraction, wrapping into the next cycle', () => {
    const p = fastcat(pure('a'), pure('b')); // a@[0,0.5), b@[0.5,1)
    const shifted = shiftedBy(p, 0.25);
    const haps = shifted.query(0).slice().sort((x, y) => x.startFrac - y.startFrac);
    // a moves to [0.25, 0.75); b moves to [0.75, 1) plus wraps to [0, 0.25).
    expect(haps.map((h) => [Math.round(h.startFrac * 100) / 100, h.value])).toEqual([
      [0, 'b'],
      [0.25, 'a'],
      [0.75, 'b'],
    ]);
  });
});

describe('off(timeFrac, fn, pattern)', () => {
  it('stacks the original with a shifted, fn-transformed copy', () => {
    const p = fastcat(pure('a'), pure('b')); // a@[0,0.5), b@[0.5,1)
    const withEcho = off(0.5, (pat) => pat, p);
    const haps = withEcho.query(0);
    expect(haps).toHaveLength(4);

    // Original a@0, b@0.5 plus an echo shifted by half a cycle: b@0, a@0.5
    // (order among Haps that share a startFrac isn't semantically
    // meaningful for a stack, so group-and-compare rather than assert exact
    // array order).
    const valuesAt = (startFrac) =>
      haps
        .filter((h) => Math.abs(h.startFrac - startFrac) < 1e-9)
        .map((h) => h.value)
        .sort();
    expect(valuesAt(0)).toEqual(['a', 'b']);
    expect(valuesAt(0.5)).toEqual(['a', 'b']);
  });
});

describe('jux(fn, pattern)', () => {
  it('returns a { left, right } pair; left unchanged, right transformed', () => {
    const p = fastcat(pure('a'), pure('b'));
    const { left, right } = jux(rev, p);
    expect(values(left, 0)).toEqual(['a', 'b']);
    expect(values(right, 0)).toEqual(['b', 'a']);
  });
});

describe('degradeBy/sometimesBy determinism', () => {
  it('degradeBy: same cycle -> same kept/dropped Haps across repeated calls', () => {
    const p = fastcat(...Array.from({ length: 16 }, (_v, i) => pure(i)));
    const degraded = degradeBy(0.5, p);
    expect(degraded.query(5)).toEqual(degraded.query(5));

    const degradedAgain = degradeBy(0.5, p);
    expect(degradedAgain.query(5)).toEqual(degraded.query(5));
  });

  it('sometimesBy: same cycle -> same result across repeated calls', () => {
    const p = fastcat(...Array.from({ length: 16 }, (_v, i) => pure(i)));
    const sometimed = sometimesBy(0.5, rev, p);
    expect(sometimed.query(7)).toEqual(sometimed.query(7));

    const sometimedAgain = sometimesBy(0.5, rev, p);
    expect(sometimedAgain.query(7)).toEqual(sometimed.query(7));
  });

  it('degradeBy(0.5) drops roughly half of many Haps', () => {
    const p = fastcat(...Array.from({ length: 200 }, () => pure('x')));
    const kept = degradeBy(0.5, p).query(0).length;
    expect(kept).toBeGreaterThan(60);
    expect(kept).toBeLessThan(140);
  });
});

describe('add(n, pattern)', () => {
  it('adds n to every numeric Hap value (transposition/offset)', () => {
    const p = fastcat(pure(60), pure(64));
    expect(values(add(12, p), 0)).toEqual([72, 76]);
  });

  it('leaves non-numeric values untouched', () => {
    const p = pure('bd');
    expect(values(add(12, p), 0)).toEqual(['bd']);
  });

  it('works on continuous patterns too', () => {
    const sig = continuousRamp();
    const bumped = add(10, sig);
    expect(bumped.queryAt(0, 0.3)).toBeCloseTo(10.3, 10);
  });
});

describe('stack/cat/fastcat', () => {
  it('stack: all patterns play simultaneously', () => {
    const p = stack(pure('a'), pure('b'));
    expect(values(p, 0)).toEqual(['a', 'b']);
  });

  it('cat: one whole pattern per cycle, cycling through the list', () => {
    const p = cat(pure('a'), pure('b'), pure('c'));
    expect(values(p, 0)).toEqual(['a']);
    expect(values(p, 1)).toEqual(['b']);
    expect(values(p, 2)).toEqual(['c']);
    expect(values(p, 3)).toEqual(['a']);
  });

  it('fastcat: all patterns crammed proportionally into one cycle', () => {
    const p = fastcat(pure('a'), pure('b'), pure('c'), pure('d'));
    const haps = p.query(0).slice().sort((x, y) => x.startFrac - y.startFrac);
    expect(haps.map((h) => h.value)).toEqual(['a', 'b', 'c', 'd']);
    expect(haps.map((h) => h.startFrac)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(haps.every((h) => Math.abs(h.durFrac - 0.25) < 1e-10)).toBe(true);
  });

  it('cat on an empty pattern list is silence, not an error', () => {
    expect(cat().query(0)).toEqual([]);
    expect(fastcat().query(0)).toEqual([]);
  });
});
