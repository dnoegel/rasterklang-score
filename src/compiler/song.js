// Fluent song builder: song(tempoBPM, opts).voice(i, chain).filter(fn) -> a
// plain data object compile.js turns into a frameSource. Every control
// parameter accepts a constant, a mini-notation string, or an
// already-built Pattern/signal; this module normalizes all three into
// Patterns (via pure()/parseMini()) so compile.js never has to special-case
// raw values.
//
// jux() on a note pattern produces a { left, right } pair of Patterns (see
// combinators.js). song.js only marks that shape; compile.js assigns the
// second half to a free hardware voice.

import { Pattern, pure } from '../pattern/query.js';
import { parseMini, parseMiniForHighlight } from '../pattern/miniNotation.js';

// toPattern(x) -> Pattern. Constants and strings are wrapped; an existing
// Pattern (mini-notation result, signal, or combinator output) passes
// through unchanged.
export function toPattern(x) {
  if (x instanceof Pattern) return x;
  if (typeof x === 'string') return parseMini(x);
  return pure(x);
}

// isVoiceSplitPair(x) -> true for the { left, right } shape jux() returns
// (see combinators.js). That shape is not a Pattern instance, so this check
// never fires on a plain Pattern.
function isVoiceSplitPair(x) {
  return x != null && typeof x === 'object' && !(x instanceof Pattern) && 'left' in x && 'right' in x;
}

// normalizeNoteInput(x) -> either a Pattern, or a
// { isVoiceSplit: true, left: Pattern, right: Pattern } marker that
// compile.js resolves into two hardware voices.
function normalizeNoteInput(x) {
  if (isVoiceSplitPair(x)) {
    return { isVoiceSplit: true, left: toPattern(x.left), right: toPattern(x.right) };
  }
  return toPattern(x);
}

// A per-voice parameter chain. Note the deliberate naming split between
// chain-building methods (`.s()`, `.pw()`, `.sync()`, `.ring()`) and the
// instance fields they set (`waveform`, `pulseWidth`, `syncPattern`,
// `ringPattern`) - giving a method and its backing field the same name would
// let the constructor's instance property shadow the prototype method.
export class VoiceChain {
  constructor(notePatternLike) {
    this.notePattern = normalizeNoteInput(notePatternLike);
    // The mini-notation string the note pattern was built from, if any.
    // Haps' sourceStart/sourceEnd (see miniNotation.js) are offsets into
    // this string, not into the whole document.
    this.noteSourceText = typeof notePatternLike === 'string' ? notePatternLike : null;
    // Ordered { textStart, textEnd, docStart } spans that together cover
    // noteSourceText, mapping each stretch of it to its position in the full
    // document. Several spans are needed when a voice combines named
    // patterns (`"[$a]|[$b]"`) whose text lives in different places.
    // rasterklang-dsl's interpret.js assigns this after construction; it is
    // null otherwise, and editors then have to locate noteSourceText by
    // searching the document, which is ambiguous when the same text occurs
    // twice.
    this.noteSourceSegments = null;
    // A parallel Pattern from the same string in which `~`/`-` rests are
    // real REST-valued Haps (see parseMiniForHighlight), so a rest can be
    // highlighted. Used only for highlighting; notePattern drives audio.
    this.noteHighlightPattern = typeof notePatternLike === 'string' ? parseMiniForHighlight(notePatternLike) : null;
    this.waveform = pure('triangle');
    // Like noteSourceText, for the string passed to .s().
    this.waveformSourceText = null;
    // Like noteSourceText/noteSourceSegments, for the `insts` field. Set by
    // rasterklang-dsl's interpret.js after .instPattern().
    this.instSourceSegments = null;
    this.instSourceText = null;
    this.attack = pure(0);
    this.decay = pure(0);
    this.sustain = pure(15);
    this.release = pure(0);
    this.pulseWidth = pure(2048);
    this.syncPattern = pure(false);
    this.ringPattern = pure(false);
    // Fraction of each note's slot the gate is held; see .gate().
    this.gatePattern = pure(1);
    // Control-byte bit 3 (test bit); see .test().
    this.testPattern = pure(false);
    // Table-driven instrument (rasterklang-dsl's src/dsl/instrument.js), or
    // null. With null, compile.js skips instrument-table sampling and uses
    // this chain's own .s()/.pw()/.adsr() values. See .inst().
    this.instrument = null;
    // Per-note instrument switching (the `insts` voice field), or null. A
    // Pattern whose Hap values are resolved instrument objects, sampled by
    // compile.js at each note onset (cycle-position clock) and held for the
    // note; `this.instrument` is the fallback. Field and method names differ
    // (instrumentPattern vs .instPattern()) so the instance property does
    // not shadow the prototype method, as with the other fields.
    this.instrumentPattern = null;
    // Per-row effect-command lane (the `fx` voice field, rasterklang-dsl's
    // src/dsl/fx.js), or null. Hap values are parsed effect objects
    // ({ op, a, b }). Sampled on its own hap boundaries rather than at note
    // onsets, because tracker commands also run on rows without a note.
    this.effectPattern = null;
    // Raw register escape hatch (the `reg` voice field): { addr, pattern }
    // entries with addr already resolved to a chip-relative index.
    // compile.js applies these after every other write for the frame.
    this.rawRegs = [];
  }

  // .s(waveformPattern) - "triangle"/"saw"/"pulse"/"noise", combinable via a
  // mini-notation stack (e.g. "[pulse,triangle]") which compile.js OR-combines.
  s(waveformLike) {
    this.waveform = toPattern(waveformLike);
    this.waveformSourceText = typeof waveformLike === 'string' ? waveformLike : null;
    return this;
  }

  // .adsr(a, d, s, r) - each argument independently patternable.
  adsr(a, d, s, r) {
    this.attack = toPattern(a);
    this.decay = toPattern(d);
    this.sustain = toPattern(s);
    this.release = toPattern(r);
    return this;
  }

  // .pw(pattern) - 12-bit pulse width (0..4095).
  pw(pwLike) {
    this.pulseWidth = toPattern(pwLike);
    return this;
  }

  // .sync(boolPattern) - hard-syncs this voice's phase to voice (i+2)%3.
  sync(boolLike) {
    this.syncPattern = toPattern(boolLike);
    return this;
  }

  // .ring(boolPattern) - ring-modulates this voice's triangle output.
  ring(boolLike) {
    this.ringPattern = toPattern(boolLike);
    return this;
  }

  // .gate(fractionPattern) - note length independent of slot width: holds
  // the gate high for `fraction` (0..1) of the sounding Hap's duration and
  // low for the rest, while pitch and waveform keep the full slot. Default 1
  // (whole slot). A negative value is an absolute release time in frames;
  // see compile.js's gateReleaseFrames.
  //
  // A slot's width and a note's held duration are different things: a short
  // staccato note inside a wide beat slot is common in chip music, and
  // without this the only workaround is faking it with zero sustain and a
  // fast decay.
  gate(fractionLike) {
    this.gatePattern = toPattern(fractionLike);
    return this;
  }

  // .test(boolPattern) - drives control-byte bit 3, the test bit SID tunes
  // use to reset an oscillator to a known phase (hard restart tricks). Same
  // shape as .sync()/.ring(): a raw control-byte bit.
  test(boolLike) {
    this.testPattern = toPattern(boolLike);
    return this;
  }

  // .inst(instrumentObj) - attaches an instrument (the plain object
  // rasterklang-dsl's src/dsl/instrument.js builds: wave/arp/pw/filterTable/
  // test tables plus adsr/vib/slide/gate defaults). Duck-typed; song.js does
  // not import the DSL. compile.js samples the tables by frames since note
  // onset, not by cycle position.
  inst(instrumentObj) {
    this.instrument = instrumentObj;
    return this;
  }

  // .instPattern(pattern) - attaches a per-note instrument-switching pattern
  // (the `insts` voice field), like a tracker's per-row instrument column.
  // compile.js samples it at each note onset, falling back to .inst()'s
  // instrument when nothing is active.
  instPattern(patternObj) {
    this.instrumentPattern = patternObj;
    return this;
  }

  // .fxPattern(pattern) - attaches the per-row effect-command lane (the `fx`
  // voice field). See compile.js's fx block for the runtime semantics.
  fxPattern(patternObj) {
    this.effectPattern = patternObj;
    return this;
  }

  // .reg(addr, pattern) - raw register escape hatch. addr is a resolved
  // chip-relative register index (0x00-0x1f); the DSL interpreter maps
  // register names to indices before calling this.
  reg(addr, patternLike) {
    this.rawRegs.push({ addr, pattern: toPattern(patternLike) });
    return this;
  }
}

// note(pattern) - starts a per-voice chain.
export function note(notePatternLike) {
  return new VoiceChain(notePatternLike);
}

// The shared filter track. Same method/field-naming split as VoiceChain, for
// the same shadowing reason.
export class FilterChain {
  constructor() {
    // Neutral defaults: with mode 'none' (no mode bits set) the SID filter
    // contributes nothing to the mix regardless of cutoff, resonance and
    // routing, so a song that never calls .filter() is unaffected.
    this.cutoffPattern = pure(0);
    this.resonancePattern = pure(0);
    this.modePattern = pure('none');
    this.routingPattern = pure({ voice0: false, voice1: false, voice2: false });
  }

  cutoff(x) {
    this.cutoffPattern = toPattern(x);
    return this;
  }

  resonance(x) {
    this.resonancePattern = toPattern(x);
    return this;
  }

  // .mode("lowpass" | "bandpass" | "highpass" | "none"), combinable via a
  // mini-notation stack (e.g. "[lowpass,bandpass]") which compile.js
  // OR-combines, same mechanism as waveform combination.
  mode(x) {
    this.modePattern = toPattern(x);
    return this;
  }

  // .route(...voiceIndices) - e.g. .route(0, 1) routes voices 0 and 1 into
  // the shared filter. Also accepts a single Pattern/mini-notation string
  // argument for a time-varying routing pattern, whose sampled value should
  // already be a { voice0, voice1, voice2 } object.
  route(...args) {
    if (args.length === 1 && (args[0] instanceof Pattern || typeof args[0] === 'string')) {
      this.routingPattern = toPattern(args[0]);
      return this;
    }
    const claimed = new Set(args);
    this.routingPattern = pure({ voice0: claimed.has(0), voice1: claimed.has(1), voice2: claimed.has(2) });
    return this;
  }
}

// song(tempoBPMOrPattern, { beatsPerCycle, arpeggioFrameRate, masterVolume,
// startOffsetFrames }) -> a fluent builder. `compile()` (compile.js) consumes
// the builder's plain fields directly (tempoBPM, tempoPattern, beatsPerCycle,
// voices, filterChain, ...) - the builder itself never talks to Patterns
// beyond storing them.
//
// tempoBPMOrPattern is normally a number. A mini-notation string ("<120 96>")
// or a Pattern gives a tempo that varies per cycle (like GoatTracker's
// funktempo; see rasterklang-dsl's docs/dsl-grammar-spec.md, "Tempo").
// Exactly one of builder.tempoBPM/tempoPattern is set; compile.js's
// makeCycleClock() branches on which.
export function song(tempoBPMOrPattern, options = {}) {
  const {
    beatsPerCycle = 4,
    // How often (in frames) a chord's arpeggio moves to the next tone.
    // 3 frames (60ms at 50fps) is a classic chiptune arpeggio speed.
    arpeggioFrameRate = 3,
    // SID master volume (low nibble of $18) is 0 on a fresh chip, which
    // would make every song silent, so compile.js writes this default.
    masterVolume = 15,
    // Offset (in frames) subtracted from frameIndex before deriving
    // cycleIndex/posFrac: real frame N is compiler frame
    // N - startOffsetFrames. Lets a bar grid start where a tune's first
    // downbeat actually falls (e.g. after a pickup) instead of at frame 0.
    startOffsetFrames = 0,
    // ADR 0002 (rasterklang-dsl's docs/adr/0002-native-play-rate.md): the
    // drive rate, i.e. CPU cycles between two play calls, and the clock they
    // are counted at. A "frame" in this module is one play call; this pair
    // converts frames to wall-clock time. The defaults are PAL 50Hz
    // (985248/19705 = 50.0000).
    driveCycles = 19705,
    cpuClockHz = 985248,
    // ADR 0003 D15 (rasterklang-dsl's
    // docs/adr/0003-musical-durations-and-song-structure.md): the SID model
    // the song declares (6581, 8580), or null to leave the choice to the
    // exporter or live engine.
    chipModel = null,
  } = options;

  // A Pattern or a mini-notation string means "varies per cycle"; anything
  // else is the constant tempo compile.js's fast path expects.
  const tempoIsPattern = tempoBPMOrPattern instanceof Pattern || typeof tempoBPMOrPattern === 'string';

  const builder = {
    tempoBPM: tempoIsPattern ? undefined : tempoBPMOrPattern,
    tempoPattern: tempoIsPattern ? toPattern(tempoBPMOrPattern) : undefined,
    beatsPerCycle,
    arpeggioFrameRate,
    masterVolume,
    startOffsetFrames,
    driveCycles,
    cpuClockHz,
    chipModel,
    voices: [undefined, undefined, undefined],
    filterChain: new FilterChain(),

    // .voice(index, chain) - assign a chain to hardware voice 0, 1, or 2.
    voice(index, chain) {
      if (!Number.isInteger(index) || index < 0 || index > 2) {
        throw new Error(`song.voice(): voice index must be 0, 1, or 2 (got ${index}).`);
      }
      builder.voices[index] = chain;
      return builder;
    },

    // .stack(...chains) - sugar for assigning several chains to whichever
    // hardware voices are still free, in order. Distinct from combinators.js's
    // stack() (which stacks Patterns in time); this stacks whole voice chains
    // across hardware voices for true polyphony.
    stack(...chains) {
      for (const chain of chains) {
        const freeIndex = builder.voices.findIndex((v) => v === undefined);
        if (freeIndex === -1) {
          throw new Error('song.stack(): no free SID voice available (voices 0, 1, and 2 are all already assigned).');
        }
        builder.voice(freeIndex, chain);
      }
      return builder;
    },

    // .filter(fn) - fn receives a FilterChain builder and configures it via
    // .cutoff()/.resonance()/.mode()/.route(); its return value is ignored
    // (the chain is mutated in place).
    filter(fn) {
      fn(builder.filterChain);
      return builder;
    },
  };

  return builder;
}
