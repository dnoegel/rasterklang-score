// Deterministic, seed-keyed pseudo-random unit-interval generator.
//
// Used by signals.js (`rand`, `perlin`) and combinators.js (`degradeBy`,
// `sometimesBy`) and by miniNotation.js (`?` probabilistic drop, `a|b|c`
// random choice) so pattern playback is always reproducible: the same key
// (cycleIndex, hap/site index, ...) always produces the same value, with no
// dependency on Math.random() or wall-clock state. The emulator's live
// session is fully determined by the ordered stream of pokes it receives,
// and the pattern layer must not introduce non-determinism upstream of it.
//
// Implementation: a standard 32-bit integer avalanche hash (the
// "triple xorshift-multiply" mix popularized for hash maps), folded over
// however many key components are passed in. Numeric keys are scaled into
// an integer domain first (so fractional posFrac/probability keys still mix
// well); string keys (tags used to decorrelate otherwise-identical-looking
// call sites, e.g. `degradeBy` vs `sometimesBy`) are folded in via a simple
// running hash. This is not cryptographic - it just needs to be fast, pure,
// and well-distributed enough for ~50% drop rates etc. to average out.

function hash32(x) {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = h ^ (h >>> 16);
  return h >>> 0;
}

function foldKey(seed, key) {
  let intKey;
  if (typeof key === 'number') {
    intKey = Math.floor(key * 1000003) | 0;
  } else {
    const s = String(key);
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    intKey = h;
  }
  return hash32(seed ^ intKey);
}

// seededRandom01(...keys) -> a value in [0, 1), fully determined by `keys`.
export function seededRandom01(...keys) {
  let seed = 0x9e3779b9;
  for (const key of keys) {
    seed = foldKey(seed, key);
  }
  return seed / 4294967296; // 2**32
}
