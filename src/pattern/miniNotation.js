// Hand-rolled recursive-descent mini-notation parser.
//
// Grammar:
//
//   sequence    := step (WS step)*
//   step        := atom modifier*
//   atom        := NOTE | NUMBER | WORD | rest | group | alternation | choice
//   rest        := '~' | '-'
//   group       := '[' sequence (',' sequence)* ']'      // comma inside [] = stack
//   alternation := '<' sequence '>'                      // one step's-worth per cycle
//   choice      := atom ('|' atom)+                       // random pick per cycle
//   modifier    := '*' NUMBER        // speed up (NUMBER may be decimal)
//               | '/' INT ('.' | 't')?  // duration in beats (ADR 0003 D1):
//                                        // beatUnit/INT, dotted *1.5, triplet *2/3
//               | '@' NUMBER         // temporal weight
//               | '!' NUMBER         // replicate, no speed change
//               | '?' NUMBER?        // probabilistic drop, default 0.5
//               | '(' NUMBER ',' NUMBER (',' NUMBER)? ')'  // euclidean(beats,steps,rotation)
//   top-level   := sequence (',' sequence)*               // top-level comma = stack
//
// This module is SID-agnostic: note names resolve to plain MIDI-equivalent
// numbers (see parseAtomValue below), and non-note/non-number words (e.g.
// "bd") resolve to plain strings. Nothing here knows what a SID register,
// voice, or waveform is.
//
// Sequence-building reuses combinators.js's fastcat/cat/stack rather than
// reimplementing subdivision: a plain (unweighted) sequence or `[...]`
// group is literally `fastcat(...stepPatterns)`; `<...>` is literally
// `cat(...stepPatterns)`; `,` is literally `stack(...)`. Weighted sequences
// (`@n` present among the steps) can't be expressed as an equal-share
// fastcat, so those go through the local `timeCatWeighted` helper below,
// which generalizes fastcat's "each slot is queried at the real cycle, only
// its timing is compressed" approach (see combinators.js's fastcat comment)
// to unequal per-slot shares.
//
// `/N` durations (ADR 0003 D1) are a spelling of the same weight mechanism,
// not a second one: `c4/8` sets a step's weight to beatUnit/8 exactly the
// way `c4@0.5` would, so a pattern using durations goes through
// timeCatWeighted the same as one using `@n`. `/N` and `@n` in the same
// pattern is rejected (see MiniParser's mixing check below) since they are
// two different authoring models for the one underlying number.

import { discrete, silence } from './query.js';
import { stack, cat, fastcat } from './combinators.js';
import { seededRandom01 } from './prng.js';

// REST - the value tag parseMiniForHighlight's rest Haps carry (never
// produced by the default parseMini(), which uses silence()/zero Haps for
// rests instead - see MiniParser's constructor comment). Exported so a
// consumer (compile.js) can tell "this is a rest, not a real note" apart
// from a real note's numeric/string value if it ever needs to.
export const REST = Symbol('rest');

const NOTE_LETTER_SEMITONE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const NOTE_RE = /^([a-gA-G])([sf#]?)(-?\d+)$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

// parseAtomValue(raw) - resolve one scanned atom token to a value.
// - A bare number ("200", "-3", "2.75") becomes a JS number.
// - A note name (c4, cs4, c#4, gs3, b4 ...) becomes its MIDI-equivalent
//   number: (octave + 1) * 12 + semitone-from-C (+1 for s/#, -1 for f),
//   e.g. g3 -> (3+1)*12 + 7 = 55.
// - Anything else (sample/word names like "bd") stays a plain string -
//   this module doesn't know what a SID register or a sample is.
export function parseAtomValue(raw) {
  if (NUMBER_RE.test(raw)) return Number(raw);

  const m = raw.match(NOTE_RE);
  if (m) {
    const [, letter, accidental, octaveStr] = m;
    let semitone = NOTE_LETTER_SEMITONE[letter.toLowerCase()];
    if (accidental === 's' || accidental === '#') semitone += 1;
    if (accidental === 'f') semitone -= 1;
    const octave = Number(octaveStr);
    return (octave + 1) * 12 + semitone;
  }

  return raw;
}

// pureWithSource(value, sourceStart, sourceEnd) - like query.js's pure(), but
// tags the single whole-cycle Hap with the atom's character range in the
// original mini-notation string. This is what lets the live-coding editor
// highlight the currently-sounding note in the source text (Strudel does the
// same thing): compile.js reads sourceStart/sourceEnd off whichever Hap is
// active this frame and the editor draws a decoration over that range.
// Combinators must therefore preserve extra Hap fields (spread the Hap
// rather than rebuilding a bare {startFrac,durFrac,value} literal); the
// ones in this file, query.js and combinators.js do.
function pureWithSource(value, sourceStart, sourceEnd, extra) {
  return discrete(() => [{ startFrac: 0, durFrac: 1, value, sourceStart, sourceEnd, ...extra }]);
}

// SLIDE_TO_PREFIX (ADR 0003 D12) - 'slideTo:c5' is a per-note ATTRIBUTE,
// not a second value shape: parseAtomValue still resolves 'c5' the normal
// way (so `tone`/`boundTone` stay plain numbers everywhere compile.js does
// arithmetic on them), and the 'slideTo:' prefix is carried as an extra
// `slideTo: true` field on the Hap itself instead - reusing exactly the
// spread-preserving infrastructure already built and verified for
// sourceStart/sourceEnd (see pureWithSource's comment above). compile.js
// reads it to treat this note's transition as legato (no retrigger) so the
// instrument's own `slide TIME` glide can reach it. ADR 0003 D12 explains
// why this was chosen over the `fx` lane.
const SLIDE_TO_PREFIX = 'slideTo:';

// REF_NAME_RE - identifier shape after '$' inside mini-notation (ADR 0003
// D5): same charset SIGIL uses at the grammar level.
const REF_NAME_RE = /[a-zA-Z_][a-zA-Z0-9_]*/y;

// --- Euclidean rhythm (Bjorklund) ------------------------------------------

// bjorklund(pulses, steps) -> boolean[steps], the standard "distribute
// pulses as evenly as possible over steps" recursive algorithm. E.g.
// bjorklund(3, 8) = [T,F,F,T,F,F,T,F] (the canonical tresillo "x..x..x.").
function bjorklund(pulses, steps) {
  if (steps <= 0) return [];
  if (pulses <= 0) return new Array(steps).fill(false);
  if (pulses >= steps) return new Array(steps).fill(true);

  let groups = Array.from({ length: pulses }, () => [true]);
  let remainder = Array.from({ length: steps - pulses }, () => [false]);

  while (remainder.length > 1) {
    const pairs = Math.min(groups.length, remainder.length);
    const merged = [];
    for (let i = 0; i < pairs; i += 1) {
      merged.push(groups[i].concat(remainder[i]));
    }
    const leftoverGroups = groups.slice(pairs);
    const leftoverRemainder = remainder.slice(pairs);
    groups = merged;
    remainder = leftoverGroups.length > 0 ? leftoverGroups : leftoverRemainder;
  }

  return [...groups, ...remainder].flat();
}

function rotateArray(arr, rotation) {
  const n = arr.length;
  if (n === 0) return arr;
  const r = ((Math.trunc(rotation) % n) + n) % n;
  return arr.slice(r).concat(arr.slice(0, r));
}

function applyEuclid(pattern, beats, steps, rotation) {
  const bits = rotateArray(bjorklund(Math.trunc(beats), Math.trunc(steps)), rotation);
  return fastcat(...bits.map((onset) => (onset ? pattern : silence())));
}

// --- weighted sequences (`@n`) ----------------------------------------------

// timeCatWeighted(entries) - like fastcat, but slots get unequal shares of
// the cycle.
function timeCatWeighted(entries) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  return discrete((c) => {
    const haps = [];
    let acc = 0;
    entries.forEach(({ pattern, weight }) => {
      const slotStart = acc / total;
      const slotDur = weight / total;
      // Query each slot at the real cycle `c`, not a squeezed `c*n+i` -
      // see fastcat's comment in combinators.js for why: a nested `<...>`
      // (or any other cycle-dependent pattern) in a weighted slot should
      // still advance once per real cycle, unaffected by sibling weights.
      for (const h of pattern.query(c)) {
        // Spread `h` first so source-position metadata (see parseAtomUnit's
        // pureWithSource below) survives weighted (`@n`) sequences too.
        haps.push({
          ...h,
          startFrac: slotStart + h.startFrac * slotDur,
          durFrac: h.durFrac * slotDur,
        });
      }
      acc += weight;
    });
    return haps;
  });
}

// --- probabilistic drop (`?`) and random choice (`|`) -----------------------
//
// Both are seeded by (cycleIndex, a per-occurrence "site id" assigned at
// parse time), not by Hap-index-within-cycle the way combinators.js's
// degradeBy is: two independent `?`-marked atoms in the same sequence (e.g.
// "a? b?") each always resolve to their own single Hap at index 0 within
// their own sub-pattern, so indexing by Hap-index alone would make sibling
// `?`s rise and fall together instead of independently. The site id (a
// simple parse-order counter) decorrelates them while staying fully
// deterministic per (source string, cycle).

function applyProbabilisticDrop(pattern, prob, siteId) {
  return discrete((c) => (seededRandom01(c, siteId, 'mini?') < prob ? [] : pattern.query(c)));
}

function makeChoice(patterns, siteId) {
  const n = patterns.length;
  return discrete((c) => {
    const r = seededRandom01(c, siteId, 'mini|');
    const idx = Math.min(n - 1, Math.floor(r * n));
    return patterns[idx].query(c);
  });
}

// --- parser ------------------------------------------------------------

class MiniParser {
  // tagRestsWithSource: false (default) - `~`/`-` produce silence() (zero
  // Haps). compile.js's chord/gate logic relies on rests being absent from
  // the Hap timeline. true is used only by parseMiniForHighlight, so the
  // editor has a Hap to highlight during a rest; that parallel Pattern is
  // never used for audio.
  //
  // beatUnit: the meter's denominator D (`meter N/D`, ADR 0003 D2), for
  // converting a `/K` duration into D/K beats (D1). Defaults to 4.
  //
  // docOffset (ADR 0003 D5): added to every sourceStart/sourceEnd, so
  // positions are absolute in the whole document rather than relative to
  // `str`. A `$name` reference's Haps therefore keep the positions of NAME's
  // own declaration (parsed earlier with its own docOffset) when spliced
  // into another string. Default 0 keeps positions relative to `str`.
  //
  // refs (ADR 0003 D5): (name) -> Pattern | undefined, resolving a `$name`
  // atom to the already-built Pattern of that named pattern (a structural
  // reference, not text substitution). Without refs, `$` is not a legal
  // atom character and fails like any other unscannable character.
  constructor(str, { tagRestsWithSource = false, beatUnit = 4, docOffset = 0, refs = null, weightRefs = null } = {}) {
    this.str = str;
    this.pos = 0;
    this.siteCounter = 0;
    this.tagRestsWithSource = tagRestsWithSource;
    this.beatUnit = beatUnit;
    this.docOffset = docOffset;
    this.refs = refs;
    // weightRefs (ADR 0003 D5, F1): (name) -> beats, a $ref atom's default
    // sequence-slot weight. Separate from `refs` (content), mirroring
    // rasterklang-dsl's miniLength.js, which also resolves content and
    // weight separately.
    this.weightRefs = weightRefs;
    this.pendingRefWeight = null;
    // Position of the first `/N` duration and first `@n` weight seen so
    // far, for the "mixed /N and @n in one pattern" error (D1, D14) - one
    // is a duration and the other a proportional weight, and mixing them
    // in a single pattern has no single sensible reading.
    this.sawDurationAt = null;
    this.sawWeightAt = null;
  }

  // pure(value, start, end) - pureWithSource shifted by this parser's
  // docOffset. Every atom-producing site in this class goes through this,
  // never pureWithSource directly, so docOffset is applied exactly once,
  // uniformly.
  pure(value, start, end, extra) {
    return pureWithSource(value, start + this.docOffset, end + this.docOffset, extra);
  }

  // parseDuration() -> beats, for a `/` modifier already consumed. Shape is
  // `INT ('.' | 't')?`, parsed with a dedicated digit scan (not
  // parseNumberLiteral) because that would swallow the dot of `/4.` as a
  // decimal point.
  parseDuration() {
    const start = this.pos;
    let digits = '';
    while (!this.eof() && /[0-9]/.test(this.peekChar())) {
      digits += this.peekChar();
      this.pos += 1;
    }
    if (digits === '') {
      throw new Error(`Expected a duration (e.g. /4, /8., /4t) at position ${start} in mini-notation "${this.str}"`);
    }
    const denom = Number(digits);
    let beats = this.beatUnit / denom;
    if (this.peekChar() === '.') {
      this.pos += 1;
      beats *= 1.5;
    } else if (this.peekChar() === 't') {
      this.pos += 1;
      beats *= 2 / 3;
    }
    return beats;
  }

  failMixedDurationWeight() {
    throw new Error(
      `mini-notation "${this.str}" mixes /N durations (first at position ${this.sawDurationAt}) with @N weights ` +
        `(first at position ${this.sawWeightAt}) - one is a duration and the other a proportional weight, use one or the other`,
    );
  }

  nextSiteId() {
    this.siteCounter += 1;
    return this.siteCounter;
  }

  peekChar() {
    return this.pos < this.str.length ? this.str[this.pos] : undefined;
  }

  eof() {
    return this.pos >= this.str.length;
  }

  skipWs() {
    while (!this.eof() && /\s/.test(this.peekChar())) this.pos += 1;
  }

  expect(ch) {
    if (this.peekChar() !== ch) {
      throw new Error(
        `Expected '${ch}' at position ${this.pos} in mini-notation "${this.str}" (found '${this.peekChar() ?? 'EOF'}')`,
      );
    }
    this.pos += 1;
  }

  parseNumberLiteral() {
    const start = this.pos;
    if (this.peekChar() === '-') this.pos += 1;
    while (!this.eof() && /[0-9.]/.test(this.peekChar())) this.pos += 1;
    const raw = this.str.slice(start, this.pos);
    if (raw === '' || raw === '-') {
      throw new Error(`Expected a number at position ${start} in mini-notation "${this.str}"`);
    }
    return Number(raw);
  }

  tryParseNumberLiteral(defaultValue) {
    if (this.eof()) return defaultValue;
    const ch = this.peekChar();
    const next = this.str[this.pos + 1];
    if (/[0-9.]/.test(ch) || (ch === '-' && next && /[0-9]/.test(next))) {
      return this.parseNumberLiteral();
    }
    return defaultValue;
  }

  scanWordToken() {
    const start = this.pos;
    if (this.peekChar() === '-' && /[0-9]/.test(this.str[this.pos + 1] || '')) {
      this.pos += 1;
    }
    // ':' is only ever meaningful as part of 'slideTo:' (ADR 0003 D12) -
    // included in the general word-token charset (rather than a dedicated
    // scan) because it must land in the same raw token as the note name
    // that follows it. rasterklang-dsl's miniLength.js scanner mirrors this
    // charset.
    while (!this.eof() && /[A-Za-z0-9.#:]/.test(this.peekChar())) this.pos += 1;
    const raw = this.str.slice(start, this.pos);
    if (raw === '') {
      throw new Error(`Expected a step at position ${start} in mini-notation "${this.str}"`);
    }
    return raw;
  }

  // atom := NOTE | NUMBER | WORD | rest | group | alternation
  // (choice is handled one level up, in parseChoice, since `a|b|c` wraps a
  // sequence of these atoms)
  parseAtomUnit() {
    this.skipWs();
    // Cleared before every atom; only parseRef() sets it, to the referenced
    // pattern's declared length, which becomes its default slot weight
    // (ADR 0003 D5, F1). A following "@n"/"/N" still overrides it.
    this.pendingRefWeight = null;
    const ch = this.peekChar();
    if (ch === '~') {
      const start = this.pos;
      this.pos += 1;
      return this.tagRestsWithSource ? this.pure(REST, start, this.pos) : silence();
    }
    // Bare '-' is the rest synonym; '-' immediately followed by a digit is
    // a negative-number atom instead (grammar only documents '-' as rest,
    // but disallowing negative numeric atoms entirely would be needlessly
    // restrictive for numeric control patterns - a judgment call).
    if (ch === '-' && !/[0-9]/.test(this.str[this.pos + 1] || '')) {
      const start = this.pos;
      this.pos += 1;
      return this.tagRestsWithSource ? this.pure(REST, start, this.pos) : silence();
    }
    if (ch === '[') return this.parseGroup();
    if (ch === '<') return this.parseAlternation();
    if (ch === '{') return this.parsePolymeter();
    // `$name` (ADR 0003 D5): a structural reference to a named pattern,
    // resolved via this.refs. Only recognized when a resolver was given;
    // elsewhere (e.g. a table row's mini-notation) `$` is an unscannable
    // character.
    if (ch === '$' && this.refs) return this.parseRef();
    if (ch === undefined) {
      throw new Error(`Unexpected end of input while parsing a step in mini-notation "${this.str}"`);
    }
    const start = this.pos;
    const raw = this.scanWordToken();
    if (raw.startsWith(SLIDE_TO_PREFIX)) {
      const target = raw.slice(SLIDE_TO_PREFIX.length);
      if (target === '') throw new Error(`'slideTo:' needs a target note at position ${start} in mini-notation "${this.str}"`);
      return this.pure(parseAtomValue(target), start, this.pos, { slideTo: true });
    }
    return this.pure(parseAtomValue(raw), start, this.pos);
  }

  // parseRef() - `$name`, already confirmed present by parseAtomUnit. The
  // resolved Pattern is used DIRECTLY as this atom's contribution to the
  // enclosing sequence, the same way a `[...]` group's fastcat is - which
  // is what makes `$a!3` replicate the WHOLE referenced pattern (parseStep's
  // generic `!` handling doesn't know or care that this atom came from a
  // reference rather than a literal group) and `<$a $a>` a genuine
  // two-element alternation (each entry is pattern a's own full content,
  // not one spliced token).
  parseRef() {
    const start = this.pos;
    this.pos += 1; // '$'
    REF_NAME_RE.lastIndex = this.pos;
    const m = REF_NAME_RE.exec(this.str);
    if (!m) {
      throw new Error(`Expected a pattern name after '$' at position ${this.pos} in mini-notation "${this.str}"`);
    }
    const name = m[0];
    this.pos += name.length;
    const resolved = this.refs(name);
    if (!resolved) {
      throw new Error(`pattern "$${name}" is not defined (declare it with \`pattern ${name} = "..."\` before this use - forward references aren't supported) at position ${start} in mini-notation "${this.str}"`);
    }
    if (this.weightRefs) this.pendingRefWeight = this.weightRefs(name);
    return resolved;
  }

  // choice := atom ('|' atom)+
  parseChoice() {
    const first = this.parseAtomUnit();
    if (this.peekChar() !== '|') return first;
    // A choice's own default weight isn't any one branch's ref-weight -
    // clear it so parseStep() falls back to the ordinary default (1, or
    // each's defaultWeight).
    this.pendingRefWeight = null;
    const branches = [first];
    while (this.peekChar() === '|') {
      this.pos += 1;
      branches.push(this.parseAtomUnit());
    }
    return makeChoice(branches, this.nextSiteId());
  }

  // step := atom modifier*
  // Returns an array of { pattern, weight } - length 1 normally, length n
  // when `!n` replicates the step into n separate slots.
  parseStep() {
    let pattern = this.parseChoice();
    // ADR 0003 D5 (F1): a bare $name atom's default weight is the
    // referenced pattern's own beats - "a metric pattern referenced
    // anywhere occupies its metric length" - not the usual 1. `@n`/`/N`
    // below still overrides it explicitly, same as `each`'s default.
    let weight = this.pendingRefWeight != null ? this.pendingRefWeight : 1;
    let replicate = 1;

    for (;;) {
      const ch = this.peekChar();
      if (ch === '*') {
        this.pos += 1;
        pattern = pattern.fast(this.parseNumberLiteral());
      } else if (ch === '/') {
        const modStart = this.pos;
        this.pos += 1;
        weight = this.parseDuration();
        if (this.sawDurationAt === null) this.sawDurationAt = modStart;
        if (this.sawWeightAt !== null) this.failMixedDurationWeight();
      } else if (ch === '@') {
        const modStart = this.pos;
        this.pos += 1;
        weight = this.parseNumberLiteral();
        if (this.sawWeightAt === null) this.sawWeightAt = modStart;
        if (this.sawDurationAt !== null) this.failMixedDurationWeight();
      } else if (ch === '!') {
        this.pos += 1;
        // Bare '!' with no following number means "one extra copy" (total
        // 2) - the grammar's `'!' NUMBER` doesn't define the number-less
        // case explicitly, so this is a judgment call following Strudel's
        // own convention for bare `!`.
        replicate = Math.trunc(this.tryParseNumberLiteral(2));
      } else if (ch === '?') {
        this.pos += 1;
        const prob = this.tryParseNumberLiteral(0.5);
        pattern = applyProbabilisticDrop(pattern, prob, this.nextSiteId());
      } else if (ch === '(') {
        this.pos += 1;
        this.skipWs();
        const beats = this.parseNumberLiteral();
        this.skipWs();
        this.expect(',');
        this.skipWs();
        const steps = this.parseNumberLiteral();
        this.skipWs();
        let rotation = 0;
        if (this.peekChar() === ',') {
          this.pos += 1;
          this.skipWs();
          rotation = this.parseNumberLiteral();
          this.skipWs();
        }
        this.expect(')');
        pattern = applyEuclid(pattern, beats, steps, rotation);
      } else {
        break;
      }
    }

    const entries = [];
    for (let i = 0; i < replicate; i += 1) entries.push({ pattern, weight });
    return entries;
  }

  // sequence := (step | barLine) (WS (step | barLine))*, combined via
  // fastcat (equal shares) or timeCatWeighted (when an `@n` weight is
  // present). A standalone `|` (ADR 0003 D6) is a checked bar line: an
  // assertion that rasterklang-dsl validates against the meter before this
  // parser runs, so here it is skipped like whitespace.
  parseSequence(stopChars) {
    this.skipWs();
    const entries = [];
    while (!this.eof() && !stopChars.includes(this.peekChar())) {
      if (this.peekChar() === '|') {
        this.pos += 1;
        this.skipWs();
        continue;
      }
      entries.push(...this.parseStep());
      this.skipWs();
    }
    if (entries.length === 0) return silence();
    if (entries.length === 1) return entries[0].pattern;
    if (entries.every((e) => e.weight === 1)) {
      return fastcat(...entries.map((e) => e.pattern));
    }
    return timeCatWeighted(entries);
  }

  // group := '[' sequence (',' sequence)* ']'
  parseGroup() {
    this.expect('[');
    const seqs = [this.parseSequence([',', ']'])];
    this.skipWs();
    while (this.peekChar() === ',') {
      this.pos += 1;
      seqs.push(this.parseSequence([',', ']']));
      this.skipWs();
    }
    this.expect(']');
    // Deliberately NOT clearing this.pendingRefWeight: a single-element
    // bracket around a bare $ref (`[$a]`) keeps that ref's weight, so
    // "[$a] g4" honours $a's declared length like "$a g4" (ADR 0003 D5, F1).
    // Known limitation: for a multi-element bracket, whatever the last inner
    // atom left behind leaks through as the bracket's weight.
    return seqs.length === 1 ? seqs[0] : stack(...seqs);
  }

  // alternation := '<' sequence '>' - but unlike a plain sequence, each
  // step gets its own full cycle (cat), not a proportional slice of one
  // cycle (fastcat/timeCat).
  parseAlternation() {
    this.expect('<');
    const entries = [];
    this.skipWs();
    while (!this.eof() && this.peekChar() !== '>') {
      entries.push(...this.parseStep());
      this.skipWs();
    }
    this.expect('>');
    this.pendingRefWeight = null; // see parseGroup()'s comment
    if (entries.length === 0) return silence();
    return cat(...entries.map((e) => e.pattern));
  }

  // polymeter := '{' sequence '}' ('%' number)?
  //
  // The sequence is laid out at a FIXED number of steps per cycle (the `%n`,
  // defaulting to however many steps the sequence itself has), and keeps
  // running across cycle boundaries instead of restarting - so a 3-step
  // sequence at `%4` plays 3 of its steps in cycle 0, wraps to its first step
  // for cycle 0's fourth slot, and is offset by one for the whole of cycle 1.
  // That drift is the point: it is how a tracker gets a phrase that "turns
  // over" against the bar without writing out every permutation.
  parsePolymeter() {
    this.expect('{');
    const entries = [];
    this.skipWs();
    while (!this.eof() && this.peekChar() !== '}') {
      entries.push(...this.parseStep());
      this.skipWs();
    }
    this.expect('}');
    this.pendingRefWeight = null; // see parseGroup()'s comment
    const elements = entries.map((e) => e.pattern);
    if (elements.length === 0) return silence();

    let stepsPerCycle = elements.length;
    if (this.peekChar() === '%') {
      this.pos += 1;
      stepsPerCycle = Math.max(1, Math.round(this.parseNumberLiteral()));
    }

    const k = elements.length;
    const n = stepsPerCycle;
    return discrete((c) => {
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const absoluteStep = c * n + i;
        const element = elements[((absoluteStep % k) + k) % k];
        // Which cycle of the ELEMENT to query: elements are themselves
        // patterns (an alternation inside a polymeter should keep advancing),
        // so each pass through the sequence counts as one of its cycles.
        const elementCycle = Math.floor(absoluteStep / k);
        for (const h of element.query(elementCycle)) {
          out.push({
            ...h,
            startFrac: (i + h.startFrac) / n,
            durFrac: h.durFrac / n,
          });
        }
      }
      return out;
    });
  }

  // top-level := sequence (',' sequence)*
  parseTopLevel() {
    const seqs = [this.parseSequence([','])];
    this.skipWs();
    while (this.peekChar() === ',') {
      this.pos += 1;
      seqs.push(this.parseSequence([',']));
      this.skipWs();
    }
    return seqs.length === 1 ? seqs[0] : stack(...seqs);
  }
}

// parseMini(str, { beatUnit, docOffset, refs }) -> Pattern. beatUnit is the
// meter's denominator D (ADR 0003 D1/D2), default 4, used only to convert a
// `/N` duration token into a beat-weight. docOffset/refs are ADR 0003 D5's
// structural $name references - see MiniParser's constructor comment.
export function parseMini(str, { beatUnit = 4, docOffset = 0, refs = null, weightRefs = null } = {}) {
  const parser = new MiniParser(str, { beatUnit, docOffset, refs, weightRefs });
  const pattern = parser.parseTopLevel();
  parser.skipWs();
  if (!parser.eof()) {
    throw new Error(`Unexpected character '${parser.peekChar()}' at position ${parser.pos} in mini-notation "${str}"`);
  }
  return pattern;
}

// parseMiniForHighlight(str) -> Pattern - identical parse to parseMini(),
// except `~`/`-` rests produce a real (REST-valued) Hap carrying their own
// source position instead of silence()'s zero Haps. Never used for audio -
// only for the live-coding editor's "highlight the currently playing token"
// feature (see song.js's noteHighlightPattern, compile.js), where a rest
// step needs a Hap to highlight too ("nothing is playing here"), not just a
// gap in the timeline. Structurally identical to parseMini() otherwise, so
// this and parseMini(str) always agree on timing/step boundaries for the
// same input string - only whether a rest step is a Hap or an absence.
export function parseMiniForHighlight(str, { beatUnit = 4, docOffset = 0, refs = null, weightRefs = null } = {}) {
  const parser = new MiniParser(str, { tagRestsWithSource: true, beatUnit, docOffset, refs, weightRefs });
  const pattern = parser.parseTopLevel();
  parser.skipWs();
  if (!parser.eof()) {
    throw new Error(`Unexpected character '${parser.peekChar()}' at position ${parser.pos} in mini-notation "${str}"`);
  }
  return pattern;
}
