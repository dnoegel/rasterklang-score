// compile(song) -> frameSource(frameIndex), the contract liveEngine.js
// consumes: an array of chip-relative { addr, value } register pokes for one
// frame (one player call; 50 per second on PAL unless the song declares
// another drive rate, see driveRateOf()).
//
// Design summary:
// - cycleIndex/posFrac derive from frameIndex via tempo and beatsPerCycle.
// - Every attached pattern is sampled once per frame via queryAt(). Note
//   patterns are additionally queried via query() to see *all*
//   simultaneously-active Haps, because a mini-notation stack ("c4,e4,g4",
//   "[pulse,triangle]") is represented as several overlapping Haps, never as
//   one Hap holding an array. Chord tones round-robin into an arpeggio;
//   simultaneous waveform/filter-mode values OR-combine their bits.
// - jux() on a note pattern ({ left, right } pair) auto-claims a
//   second free hardware voice for `right`, or throws if none is free.
// - A byte image of all 32 registers is diffed frame to frame and only
//   changed bytes are emitted, except that a new note onset always forces a
//   gate-off-then-gate-on pair on the control register (the SID envelope
//   only restarts on a gate low-to-high transition).
//
// frameSource keeps register-diff and onset state between calls, so it must
// be called with a non-decreasing sequence of frame indices starting at 0
// (liveEngine.js's calling convention). Calling it out of order or with gaps
// gives wrong onsets and diffs.

import {
  voiceBase,
  noteToFreqRegister,
  splitFreq,
  splitPulseWidth,
  packAD,
  packSR,
  packControl,
  packFilterRouting,
  packFilterMode,
  packCutoff,
  waveformBitsFromValue,
  midiNoteToName,
  FILTER_REGISTERS,
} from './registerMap.js';
import { decodeWaveforms } from './registerSnapshot.js';

// The drive rate a song means when it declares none: PAL, 985248/19705 =
// exactly 50.00 play calls per second. Per ADR 0002 (rasterklang-dsl's
// docs/adr/0002-native-play-rate.md) a song can declare its own rate;
// driveRateOf() reads it from song.driveCycles / song.cpuClockHz, which
// rasterklang-dsl's src/dsl/driveRate.js resolves from a `target { ... }`
// block.
const DEFAULT_DRIVE_CYCLES = 19705;
const DEFAULT_CPU_CLOCK_HZ = 985248;

// driveRateOf(song) -> { framesPerSecond, framesPerMinute }. A "frame" is
// one play call throughout this module, so this is the only place the
// frame axis touches wall-clock time. Everything downstream of tempo
// (row/beat timing, gate lengths, arpeggio rates) is expressed in frames.
export function driveRateOf(song) {
  const cycles = song && song.driveCycles > 0 ? song.driveCycles : DEFAULT_DRIVE_CYCLES;
  const clock = song && song.cpuClockHz > 0 ? song.cpuClockHz : DEFAULT_CPU_CLOCK_HZ;
  const framesPerSecond = clock / cycles;
  return { framesPerSecond, framesPerMinute: framesPerSecond * 60, driveCycles: cycles, cpuClockHz: clock };
}

// activeHapsAt(pattern, cycleIndex, posFrac) -> every Hap (of a discrete
// pattern's query(cycleIndex)) that contains posFrac. Unlike
// Pattern.queryAt() (which returns only the first match's value), this
// exposes *all* simultaneously-active Haps - the mechanism this compiler
// needs for chord/combined-value reinterpretation.
function activeHapsAt(pattern, cycleIndex, posFrac) {
  return pattern.query(cycleIndex).filter((h) => posFrac >= h.startFrac && posFrac < h.startFrac + h.durFrac);
}

// activeValuesAt(pattern, cycleIndex, posFrac) -> plain value list, falling
// back to queryAt() for patterns with no discrete Haps at all (continuous
// signals) so callers get a single-element list instead of an empty one.
//
// Continuous patterns (isContinuous, built via query.js's continuous()) go
// straight to queryAt(): Pattern's generic query() fallback for them samples
// only once, at posFrac 0, and wraps that in one whole-cycle Hap, so going
// through activeHapsAt() would return a value frozen at the cycle start.
function activeValuesAt(pattern, cycleIndex, posFrac) {
  if (pattern.isContinuous) {
    const v = pattern.queryAt(cycleIndex, posFrac);
    return v === undefined ? [] : [v];
  }
  const haps = activeHapsAt(pattern, cycleIndex, posFrac);
  if (haps.length > 0) return haps.map((h) => h.value);
  const v = pattern.queryAt(cycleIndex, posFrac);
  return v === undefined ? [] : [v];
}

// activeKeyFor(activeNoteHaps, cycleIndex) -> a string uniquely identifying
// *which* Hap(s) are currently sounding, or null if none are. Two frames
// with the same key are the same ongoing note/chord event; a different key
// (including "was null, now something") is a fresh onset. Keyed by
// (cycleIndex, startFrac) per Hap, not by value - so a chord whose tones
// happen to repeat next cycle is still correctly seen as a new onset (the
// pattern engine treats every cycle as a fresh query()), and a rev()'d
// pattern (which changes each Hap's startFrac) is compared correctly too.
function activeKeyFor(activeNoteHaps, cycleIndex) {
  if (activeNoteHaps.length === 0) return null;
  return activeNoteHaps
    .map((h) => `${cycleIndex}:${h.startFrac}`)
    .sort()
    .join('|');
}

// combineWaveformBits(values) -> OR together every simultaneously-active
// waveform value's control-byte bits (see waveformBitsFromValue).
function combineWaveformBits(values) {
  return values.reduce((acc, v) => acc | waveformBitsFromValue(v), 0);
}

const MODE_NAMES = ['lowpass', 'bandpass', 'highpass'];

// resolveModeObject(values) -> { lowpass, bandpass, highpass } from every
// simultaneously-active filter-mode value (e.g. a stack "[lowpass,bandpass]"
// combines both; "none" or any other word is silently ignored so it never
// throws on unrecognized/placeholder mode words). Each entry in `values` is
// normally a single string (one Hap's value), but may itself be an array of
// strings: a continuous() mode pattern can return e.g. ["lowpass","bandpass"]
// from one queryAt() call, which arrives here as a single-element `values`
// list (see activeValuesAt's continuous branch).
function resolveModeObject(values) {
  const flat = [];
  for (const v of values) {
    if (Array.isArray(v)) flat.push(...v);
    else flat.push(v);
  }
  const present = new Set(flat.filter((v) => typeof v === 'string'));
  const mode = {};
  for (const name of MODE_NAMES) mode[name] = present.has(name);
  return mode;
}

function clampRound(v, lo, hi, fallback = 0) {
  const n = Number.isFinite(v) ? v : fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// isVoiceSplit(notePattern) -> true for the { isVoiceSplit, left, right }
// marker song.js produces from a jux() note pattern.
function isVoiceSplit(notePattern) {
  return notePattern != null && typeof notePattern === 'object' && notePattern.isVoiceSplit === true;
}

// resolveVoiceAssignments(rawVoices) -> a length-3 array of resolved chain
// views (or null for an unassigned voice), auto-claiming a second free
// hardware voice for any jux() note-pattern split. Throws a clear
// compile-time error naming the origin voice if no voice is free.
function resolveVoiceAssignments(rawVoices) {
  const resolved = [null, null, null];
  // A voice explicitly assigned via .voice(i, ...) is reserved even before we
  // know whether it holds a plain chain or a split, so a split's auto-claim
  // never takes a voice the song assigns later in the list.
  const explicitlyAssigned = rawVoices.map((v) => v != null);

  for (let i = 0; i < 3; i += 1) {
    const chain = rawVoices[i];
    if (chain == null) continue;

    if (isVoiceSplit(chain.notePattern)) {
      resolved[i] = { ...chain, notePattern: chain.notePattern.left };

      const freeIndex = resolved.findIndex((r, idx) => r === null && !explicitlyAssigned[idx]);
      if (freeIndex === -1) {
        throw new Error(
          `compile(): voice ${i}'s note pattern is a jux/off split and needs a second free SID voice, ` +
            'but voices 0, 1, and 2 are all already assigned. Free up a voice or remove the split.',
        );
      }
      resolved[freeIndex] = { ...chain, notePattern: chain.notePattern.right };
      explicitlyAssigned[freeIndex] = true;
    } else {
      resolved[i] = { ...chain, notePattern: chain.notePattern };
    }
  }

  return resolved;
}

export const DEFAULT_MASTER_VOLUME = 15;

// sampleTable(table, framesSinceOnset, loopIndex, speed, delay) -> the table
// entry active `framesSinceOnset` frames after this voice's current note
// onset. Used for the instrument wave/arp/pw/filterTable/test/gate tables
// (rasterklang-dsl's src/dsl/instrument.js). Tracker semantics: tables run on
// frames since THIS note's onset, a different clock from a voice's `notes`
// pattern, which is sampled by cycle position.
//
// speed/delay (ADR 0003 D10) resolve to a table index first, so the
// wraparound logic below only deals in indices: the index holds at 0 for
// `delay` frames, then advances one step per `speed` frames. The defaults
// (1, 0) make the index plain `framesSinceOnset`.
//
// Past the last entry the index wraps back to `loopIndex` and keeps cycling
// through [loopIndex, length): the tracker sustain-loop idiom (a short
// attack transient, then a looping sustain segment while the gate is open).
// loopIndex 0 reduces this to `index % length`.
// Returns undefined for a null/empty table.
function sampleTable(table, framesSinceOnset, loopIndex = 0, speed = 1, delay = 0) {
  if (!table || table.length === 0) return undefined;
  const index = Math.floor(Math.max(0, framesSinceOnset - delay) / (speed > 0 ? speed : 1));
  const len = table.length;
  if (index < len) return table[index];
  const li = Math.max(0, Math.min(Math.trunc(loopIndex) || 0, len - 1));
  const loopLen = len - li;
  if (loopLen <= 0) return table[len - 1];
  return table[li + ((index - len) % loopLen)];
}

// resolveLoopIndex(inst, tableName) -> the loop index sampleTable() should
// use for one table (wave/pw/arp/filterTable/test/gate) of this instrument.
// inst.loop (rasterklang-dsl's normalizeLoop()) is either a plain integer
// applied to every table, or a `{ TABLE: N, ... }` map giving each table its
// own loop point, as trackers do (a wave table's and a filter table's loop
// markers are independent). A table missing from the map loops from 0.
function resolveLoopIndex(inst, tableName) {
  const loop = inst.loop;
  if (loop && typeof loop === 'object') return Number.isInteger(loop[tableName]) ? loop[tableName] : 0;
  return loop;
}

// resolveSpeedDelay(inst, tableName) -> [speed, delay] for one table
// (ADR 0003 D10), from the per-table map rasterklang-dsl's
// normalizeSpeedDelay() builds; (1, 0) for a table not mentioned. Does not
// affect arpeggioFrameRate, the chord round-robin rate (ADR 0003 section
// 5.4). Returned as a tuple so call sites can spread it into sampleTable()'s
// trailing arguments.
function resolveSpeedDelay(inst, tableName) {
  const sd = inst.speed && inst.speed[tableName];
  const speed = sd && Number.isFinite(sd.speed) && sd.speed > 0 ? sd.speed : 1;
  const delay = sd && Number.isFinite(sd.delay) && sd.delay > 0 ? sd.delay : 0;
  return [speed, delay];
}

// makeCycleClock(song) -> resolve(shiftedFrame) -> { cycleIndex, posFrac,
// framesPerCycle }. Supports tempo as a pattern (rasterklang-dsl's
// docs/dsl-grammar-spec.md, "Tempo": `tempo "<120 96>" beats 4`), where
// framesPerCycle is re-derived from tempoPattern at each cycle boundary.
//
// Constant tempo (no song.tempoPattern, the common case) uses a single
// division per frame; only a tempo pattern pays for the per-cycle
// bookkeeping below.
function makeCycleClock(song) {
  const beatsPerCycle = song.beatsPerCycle;
  // ADR 0002: frames per minute follows the song's drive rate (3000 for the
  // PAL 50fps default).
  const { framesPerMinute } = driveRateOf(song);

  function framesPerCycleForBpm(bpm) {
    return Math.round((framesPerMinute / bpm) * beatsPerCycle);
  }

  if (!song.tempoPattern) {
    const framesPerCycle = framesPerCycleForBpm(song.tempoBPM);
    return function resolve(shiftedFrame) {
      const cycleIndex = Math.floor(shiftedFrame / framesPerCycle);
      const posFrac = (((shiftedFrame % framesPerCycle) + framesPerCycle) % framesPerCycle) / framesPerCycle;
      return { cycleIndex, posFrac, framesPerCycle };
    };
  }

  // Variable tempo. tempoPattern is sampled once per cycle, at posFrac 0: a
  // cycle's tempo is fixed for the whole cycle and only varies from cycle to
  // cycle (like GoatTracker's funktempo). A running (cycleIndex, cycleStart)
  // anchor means non-decreasing frame requests walk one cycle boundary at a
  // time instead of summing cycle lengths from scratch. The backward walk
  // only happens for a nonzero startOffsetFrames lead-in (see song.js),
  // where the first frames land before shifted cycle 0.
  function bpmForCycle(cycleIndex) {
    const bpm = song.tempoPattern.queryAt(cycleIndex, 0);
    return typeof bpm === 'number' && bpm > 0 ? bpm : (song.tempoBPM ?? 120);
  }

  let cycleIndex = 0;
  let cycleStart = 0;
  let framesPerCycle = framesPerCycleForBpm(bpmForCycle(0));

  return function resolve(shiftedFrame) {
    while (shiftedFrame < cycleStart) {
      cycleIndex -= 1;
      framesPerCycle = framesPerCycleForBpm(bpmForCycle(cycleIndex));
      cycleStart -= framesPerCycle;
    }
    while (shiftedFrame >= cycleStart + framesPerCycle) {
      cycleStart += framesPerCycle;
      cycleIndex += 1;
      framesPerCycle = framesPerCycleForBpm(bpmForCycle(cycleIndex));
    }
    const posFrac = (shiftedFrame - cycleStart) / framesPerCycle;
    return { cycleIndex, posFrac, framesPerCycle };
  };
}

// framesForCycles(song, cycleCount) -> the number of frames frameSource()
// needs to be called with (0..result-1) to play exactly `cycleCount`
// complete cycles (0..cycleCount-1), so a WAV/SID export never cuts a
// pattern off mid-cycle. Walks the same cycle clock frameSource uses, one
// cycle at a time, so a variable-tempo song gets an exact answer rather than
// an average-BPM estimate.
export function framesForCycles(song, cycleCount) {
  const startOffsetFrames = song.startOffsetFrames ?? 0;
  const resolve = makeCycleClock(song);
  const count = Math.max(0, Math.floor(cycleCount) || 0);
  let shiftedFrame = 0;
  for (let i = 0; i < count; i += 1) {
    const { framesPerCycle } = resolve(shiftedFrame);
    shiftedFrame += framesPerCycle;
  }
  return startOffsetFrames + shiftedFrame;
}

// barsForFullPeriod(song) -> how many whole bars this arrangement takes to
// come back to where it started, or null when that is unknown (a song not
// built by the DSL, or one with no voices).
//
// ADR 0001 D5 makes polymetre legal and asks tooling to report the
// arrangement's true period. rasterklang-dsl's semantic pass computes the
// period in beats (`dslPeriodBeats` on the builder); this converts it to
// bars, extended to the next point where it also lines up with the bar grid
// (a 3-beat pattern in a 4-beat bar realigns only after 3 bars).
export function barsForFullPeriod(song) {
  const barBeats = song?.beatsPerCycle;
  const periodBeats = song?.dslPeriodBeats;
  if (!(barBeats > 0) || !(periodBeats > 0)) return null;
  // Both numbers may be decimals (a declared length may be `7.5`), so the
  // LCM runs over integers scaled by a fixed 1/1000-beat denominator -
  // exact for every length the DSL can spell, and no float GCD. Same
  // technique, and the same reason, as rasterklang-dsl's analyze.js.
  const SCALE = 1000;
  const a = Math.round(periodBeats * SCALE);
  const b = Math.round(barBeats * SCALE);
  let x = a;
  let y = b;
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  const lcm = (a * b) / x;
  return Math.max(1, Math.round(lcm / b));
}

export function compile(song) {
  const resolveCycleClock = makeCycleClock(song);
  // ADR 0002: `vib`'s rate is in Hz, so it (unlike everything else here,
  // which counts frames) needs to know how many frames a second holds.
  // Defaults to 50 for a song with no declared drive rate.
  const { framesPerSecond } = driveRateOf(song);
  const arpeggioFrameRate = song.arpeggioFrameRate ?? 3;
  const masterVolume = song.masterVolume ?? DEFAULT_MASTER_VOLUME;
  // See song.js's comment on startOffsetFrames.
  const startOffsetFrames = song.startOffsetFrames ?? 0;

  const resolvedVoices = resolveVoiceAssignments(song.voices);
  const filterChain = song.filterChain;

  // -1 is not a valid byte value (0..255), so every register the song
  // touches is guaranteed to differ from this sentinel on frame 0 - no
  // separate "frame 0 setup" special case needed.
  let previousRegisters = new Array(32).fill(-1);

  // fx runtime state (the `fx` per-row effect lane, rasterklang-dsl's
  // src/dsl/fx.js): activeFxKey detects a new fx hap the same way activeKey
  // does for notes; fxFreqReg is the running 16-bit frequency register that
  // pitch commands mutate frame by frame (GoatTracker gplay.c's
  // cptr->freq); vibTime is the fx vibrato's triangle-LFO counter (gplay.c's
  // cptr->vibtime); fxAd/fxSr/fxWave/fxPw are sticky
  // register overrides installed by one-shot set commands and dropped at the
  // next note onset.
  const makeVoiceRuntime = () => ({
    activeKey: null,
    framesSinceOnset: 0,
    lastFreqReg: null,
    slideFromFreqReg: null,
    activeInstrument: null,
    // Source range of the `insts` token that picked activeInstrument, for
    // editor highlighting. Re-sampled only on onsets, like activeInstrument;
    // null when the chain's static instrument is in use.
    activeInstrumentSourceStart: null,
    activeInstrumentSourceEnd: null,
    activeFxKey: null,
    fxFreqReg: null,
    vibTime: 0,
    // Instrument-level vibrato (`vibTri`): its own LFO counter, the
    // frequency-register offset integrated so far, and the note that offset
    // belongs to. A pitch change from the arp table restarts the vibrato just
    // like a new note does (gplay.c re-seeds cptr->freq and zeroes vibtime on
    // every wave-table note step).
    instVibTime: 0,
    instVibOffset: 0,
    instVibBase: null,
    fxAd: null,
    fxSr: null,
    fxWave: null,
    fxPw: null,
  });
  const voiceRuntime = [makeVoiceRuntime(), makeVoiceRuntime(), makeVoiceRuntime()];

  // Song-global fx overrides. Filter cutoff and master volume are shared
  // chip state, set from whichever voice's row carries the command (gplay.c
  // keeps them in globals too), so they live here rather than in
  // voiceRuntime.
  let fxFilterCutoff = null;
  let fxMasterVolume = null;

  return function frameSource(frameIndex) {
    // shiftedFrame (and so cycleIndex) is negative during a startOffsetFrames
    // lead-in. cat() wraps negative cycle indices correctly, and the cycle
    // clock normalizes posFrac into [0, 1).
    const shiftedFrame = frameIndex - startOffsetFrames;
    const { cycleIndex, posFrac, framesPerCycle } = resolveCycleClock(shiftedFrame);

    const target = previousRegisters.slice();
    // The shared filter cutoff as written by each voice's instrument
    // `filterTable`, collected in the voice loop and resolved afterwards.
    //
    // A filter table writes the cutoff absolutely, regardless of routing: the
    // SID has one filter with one cutoff register, and routing ($D417's low
    // bits) only selects which voices pass through it. (Before DSL 2.19.0
    // filter tables were per-voice offsets summed over the routed voices, so
    // a sweep on an unrouted voice was silently lost.) When several voices
    // run filter tables at once the most recent note onset wins, ties going
    // to the higher voice index, matching GoatTracker's single global filter
    // table pointer.
    const filterTableWriteByVoice = [null, null, null];
    // addr -> gate-off byte to force-emit before the final (already-in
    // `target`) value, for voices with a genuine new note onset this frame.
    const forcedControl = new Map();

    // "Now playing" side channel (exposed as frameSource.lastFrame): a
    // per-voice summary of this frame's compiler state, built from the same
    // values as the register writes. Voices with no chain stay "silent".
    const nowPlayingVoices = [0, 1, 2].map(() => ({
      active: false,
      noteName: null,
      midiNote: null,
      waveform: [],
      pulseWidth: 2048,
      attack: 0,
      decay: 0,
      sustain: 0,
      release: 0,
      gate: false,
      sync: false,
      ring: false,
      test: false,
    }));

    for (let v = 0; v < 3; v += 1) {
      const chain = resolvedVoices[v];
      if (!chain) continue;
      const base = voiceBase(v);
      const runtime = voiceRuntime[v];

      const activeNotes = activeHapsAt(chain.notePattern, cycleIndex, posFrac);
      const activeKey = activeKeyFor(activeNotes, cycleIndex);

      // --- fx lane sampling -------------------------------------------------
      // Sampled on the fx pattern's own hap boundaries, not at note onsets:
      // a tracker command executes on its row whether or not that row
      // carries a note, and portamento/vibrato commands usually sit on
      // note-less rows. `fx` stays null for chains without an fx lane.
      let fx = null;
      let fxIsNew = false;
      if (chain.effectPattern) {
        const fxHaps = activeHapsAt(chain.effectPattern, cycleIndex, posFrac);
        const fxKey = activeKeyFor(fxHaps, cycleIndex);
        fxIsNew = fxKey !== null && fxKey !== runtime.activeFxKey;
        runtime.activeFxKey = fxKey;
        fx = fxHaps.length > 0 ? fxHaps[0].value : null;
      }

      // Tone portamento is legato: gplay.c guards its new-note init
      // (envelope retrigger, table restarts) with `if (cptr->newcommand !=
      // CMD_TONEPORTA)`, so a tone-portamento row only changes the pitch
      // target. So no onset is registered here:
      // framesSinceOnset keeps counting and no forced gate-off/gate-on pair
      // is emitted.
      const isNewNote = activeKey !== null && activeKey !== runtime.activeKey;
      const toneportaLegato = fx != null && fx.op === 'tp' && isNewNote;
      // ADR 0003 D11's `gate legato` applies the same suppression to every
      // note transition on an instrument that declares it. With `insts`
      // switching, the INCOMING note's instrument decides, so peek at
      // chain.instrumentPattern here without committing it to
      // runtime.activeInstrument (the onset handling below does that).
      let gateModeInst;
      if (!chain.instrumentPattern) {
        gateModeInst = chain.instrument;
      } else if (isNewNote) {
        const incomingInstHaps = activeHapsAt(chain.instrumentPattern, cycleIndex, posFrac);
        gateModeInst = incomingInstHaps.length > 0 ? incomingInstHaps[0].value : (chain.instrument ?? null);
      } else {
        gateModeInst = runtime.activeInstrument;
      }
      const gateLegato = gateModeInst != null && gateModeInst.gateMode === 'legato' && isNewNote;
      // ADR 0003 D12's `slideTo:NOTE`: a per-note Hap tag (see
      // miniNotation.js), so `tone` stays a plain number. It makes the
      // transition legato like `gate legato`, which lets the instrument's
      // `slide TIME` glide (slideCfg below) carry across the boundary.
      const slideToActive = activeNotes.length === 1 && activeNotes[0].slideTo === true && isNewNote;
      const suppressOnset = toneportaLegato || gateLegato || slideToActive;
      const isOnset = isNewNote && !suppressOnset;
      // A rest keeps the table clock running: the last note's instrument
      // releases through its own tables, as in a tracker (see `inst` below).
      if (suppressOnset || activeKey === null) runtime.framesSinceOnset += 1;
      else runtime.framesSinceOnset = activeKey === runtime.activeKey ? runtime.framesSinceOnset + 1 : 0;
      runtime.activeKey = activeKey;

      // One-shot "set a register" commands fire on the frame the fx hap
      // becomes active and stay in effect until the next note onset restores
      // the instrument's own values (in gplay.c, SETAD/SETSR poke the
      // registers at tick 0 and the next note's init writes the
      // instrument's AD/SR back).
      if (isOnset) {
        runtime.fxAd = null;
        runtime.fxSr = null;
        runtime.fxWave = null;
        runtime.fxPw = null;
        runtime.vibTime = 0;
      }
      if (fxIsNew && fx) {
        if (fx.op === 'ad') runtime.fxAd = packAD(clampRound(fx.a.value, 0, 15), clampRound(fx.b.value, 0, 15));
        else if (fx.op === 'sr') runtime.fxSr = packSR(clampRound(fx.a.value, 0, 15), clampRound(fx.b.value, 0, 15));
        else if (fx.op === 'wave') runtime.fxWave = clampRound(fx.a.value, 0, 255);
        // 12-bit pulse width, clamped like the instrument `pw` table path.
        // rasterklang-dsl already rejects out-of-range values at parse time.
        else if (fx.op === 'pw') runtime.fxPw = clampRound(fx.a.value, 0, 4095, 2048);
        // GoatTracker's cutoff is an 8-bit value driving the SID's 11-bit
        // cutoff register, hence the *8.
        else if (fx.op === 'fcut') fxFilterCutoff = clampRound(fx.a.value * 8, 0, 2047);
        else if (fx.op === 'vol') fxMasterVolume = clampRound(fx.a.value, 0, 15);
        else if (fx.op === 'vib') runtime.vibTime = 0;
      }

      // Chord reinterpretation: >1 simultaneously-active Hap round-robins
      // through the tones at arpeggioFrameRate, so only one frequency is
      // ever written per frame for this voice.
      let tone;
      let toneHap;
      let arpeggioIndex = 0;
      if (activeNotes.length === 1) {
        tone = activeNotes[0].value;
        toneHap = activeNotes[0];
      } else if (activeNotes.length > 1) {
        arpeggioIndex = Math.floor(runtime.framesSinceOnset / arpeggioFrameRate) % activeNotes.length;
        tone = activeNotes[arpeggioIndex].value;
        toneHap = activeNotes[arpeggioIndex];
      }

      // The attached instrument (see VoiceChain.inst()), or null. Its tables
      // are sampled by runtime.framesSinceOnset (the tracker clock), never
      // by cycleIndex/posFrac.
      //
      // `insts` (VoiceChain.instPattern()) switches instruments per note,
      // like a tracker's per-row instrument column. It is sampled by cycle
      // position like the note pattern, but only on a new onset; the result
      // is held in runtime.activeInstrument for the rest of the note, so an
      // `insts` pattern finer than the notes cannot change the instrument
      // mid-note. With no `insts` value at an onset, the chain's static
      // instrument applies.
      let inst;
      let instSourceStart = null;
      let instSourceEnd = null;
      if (chain.instrumentPattern) {
        if (isOnset) {
          // activeHapsAt (not activeValuesAt) to keep the Hap's
          // sourceStart/sourceEnd: rasterklang-dsl only replaces `.value`
          // with the resolved instrument, so the range still points at the
          // `insts` token.
          const instHaps = activeHapsAt(chain.instrumentPattern, cycleIndex, posFrac);
          if (instHaps.length > 0) {
            runtime.activeInstrument = instHaps[0].value;
            runtime.activeInstrumentSourceStart = typeof instHaps[0].sourceStart === 'number' ? instHaps[0].sourceStart : null;
            runtime.activeInstrumentSourceEnd = typeof instHaps[0].sourceEnd === 'number' ? instHaps[0].sourceEnd : null;
          } else {
            runtime.activeInstrument = chain.instrument ?? null;
            runtime.activeInstrumentSourceStart = null;
            runtime.activeInstrumentSourceEnd = null;
          }
        }
        // In a rest the last instrument stays (its tables run on while the
        // envelope releases, as in a tracker). Dropping it fell back to the
        // chain's waveform, triangle by default, at the last frequency: a
        // noise drum at a high fixed pitch rang on as a beep.
        inst = runtime.activeInstrument ?? null;
        if (activeKey !== null) {
          instSourceStart = runtime.activeInstrumentSourceStart;
          instSourceEnd = runtime.activeInstrumentSourceEnd;
        }
      } else {
        inst = chain.instrument;
      }

      // arp: a per-frame relative semitone offset added to the sounding tone
      // (the table-driven alternative to a "[c4,ef4,g4]" chord).
      //
      // An `=60` cell (`{ absNote }`) instead pins the frame to an absolute
      // MIDI note, like GoatTracker's absolute wave-table notes ($80-$DF in
      // gplay.c's WAVEEXEC), the fixed-pitch drum technique. Both cell kinds
      // mix in one table: `arp 0 =36 0 12` is played note, fixed low C,
      // played note, octave up.
      let boundTone = tone;
      if (inst && inst.arp && tone !== undefined) {
        const arpOffset = sampleTable(inst.arp, runtime.framesSinceOnset, resolveLoopIndex(inst, 'arp'), ...resolveSpeedDelay(inst, 'arp'));
        if (typeof arpOffset === 'number') boundTone = tone + arpOffset;
        else if (arpOffset && typeof arpOffset === 'object' && typeof arpOffset.absNote === 'number') boundTone = arpOffset.absNote;
      }

      // Highlight source range, read from the rest-inclusive parallel
      // pattern (song.js's noteHighlightPattern): a `~` has no Hap in the
      // audio pattern, so activeNotes has nothing to highlight during a
      // rest. The same arpeggioIndex picks the sounding chord tone.
      let highlightHap;
      if (chain.noteHighlightPattern) {
        const highlightNotes = activeHapsAt(chain.noteHighlightPattern, cycleIndex, posFrac);
        if (highlightNotes.length > 0) {
          highlightHap = highlightNotes[Math.min(arpeggioIndex, highlightNotes.length - 1)];
        }
      }

      // Waveform. An instrument wave table, if present, wins on every frame
      // (sampleTable() always returns an entry for a non-empty table); the
      // chain's own .s() pattern is the fallback. The pattern path uses
      // activeHapsAt so the active token(s) can be highlighted; a stack like
      // "[triangle,saw]" is several simultaneous Haps.
      let waveformBits;
      let waveformSourceStart = null;
      let waveformSourceEnd = null;
      if (inst && inst.wave) {
        waveformBits = waveformBitsFromValue(sampleTable(inst.wave, runtime.framesSinceOnset, resolveLoopIndex(inst, 'wave'), ...resolveSpeedDelay(inst, 'wave')));
      } else {
        const activeWaveformHaps = activeHapsAt(chain.waveform, cycleIndex, posFrac);
        waveformBits =
          activeWaveformHaps.length > 0
            ? combineWaveformBits(activeWaveformHaps.map((h) => h.value))
            : combineWaveformBits(activeValuesAt(chain.waveform, cycleIndex, posFrac));
        // Highlight the union of all active waveform tokens' source ranges,
        // since a stack combines them all onto this voice.
        for (const hap of activeWaveformHaps) {
          if (typeof hap.sourceStart !== 'number' || typeof hap.sourceEnd !== 'number') continue;
          waveformSourceStart = waveformSourceStart === null ? hap.sourceStart : Math.min(waveformSourceStart, hap.sourceStart);
          waveformSourceEnd = waveformSourceEnd === null ? hap.sourceEnd : Math.max(waveformSourceEnd, hap.sourceEnd);
        }
      }
      const attack = clampRound(chain.attack.queryAt(cycleIndex, posFrac), 0, 15);
      const decay = clampRound(chain.decay.queryAt(cycleIndex, posFrac), 0, 15);
      const sustain = clampRound(chain.sustain.queryAt(cycleIndex, posFrac), 0, 15);
      const release = clampRound(chain.release.queryAt(cycleIndex, posFrac), 0, 15);
      // Instrument table wins, chain value is the fallback (as for waveform).
      const pulseWidth =
        inst && inst.pw
          ? clampRound(sampleTable(inst.pw, runtime.framesSinceOnset, resolveLoopIndex(inst, 'pw'), ...resolveSpeedDelay(inst, 'pw')), 0, 4095, 2048)
          : clampRound(chain.pulseWidth.queryAt(cycleIndex, posFrac), 0, 4095, 2048);
      const syncOn = !!chain.syncPattern.queryAt(cycleIndex, posFrac);
      const ringOn = !!chain.ringPattern.queryAt(cycleIndex, posFrac);
      // Test bit (control byte bit 3), same precedence.
      const testOn =
        inst && inst.test
          ? !!sampleTable(inst.test, runtime.framesSinceOnset, resolveLoopIndex(inst, 'test'), ...resolveSpeedDelay(inst, 'test'))
          : !!chain.testPattern.queryAt(cycleIndex, posFrac);
      // The shared filter's cutoff as written by this instrument's
      // `filterTable`, resolved after the voice loop - see
      // filterTableWriteByVoice's declaration above.
      if (inst && inst.filterTable) {
        const written = sampleTable(inst.filterTable, runtime.framesSinceOnset, resolveLoopIndex(inst, 'filterTable'), ...resolveSpeedDelay(inst, 'filterTable'));
        if (typeof written === 'number') {
          filterTableWriteByVoice[v] = { cutoff: written, framesSinceOnset: runtime.framesSinceOnset };
        }
      }
      // Gate length. A value in 0..1 is the fraction of the current Hap's
      // duration to hold the gate (VoiceChain.gate(), default 1 = whole
      // slot). A negative value is an absolute frame count: `gate -2` drops
      // the gate for the last 2 frames of the note, whatever its length.
      // That models GoatTracker's per-instrument gate timer (in gplay.c the
      // next note is fetched `gatetimer & 0x3f` ticks early and the gate is
      // keyed off there), which no single fraction can reproduce across
      // different note lengths.
      //
      // rasterklang-dsl folds a voice's single base instrument's `gate` into
      // chain.gatePattern, but a voice switching instruments via `insts` has
      // no single base instrument and keeps the default 1. In that case the
      // sounding instrument's gate applies; an explicit non-default chain
      // gate still wins.
      const chainGate = chain.gatePattern.queryAt(cycleIndex, posFrac);
      const rawGate = chainGate === 1 && inst && inst.gate != null ? inst.gate : chainGate;
      // ADR 0003 D11's `gate retrigger`: default gateReleaseFrames to 1 so
      // every onset, including a repeated pitch, gets a gate low-to-high edge
      // that is visible to anything sampling registers once per frame. The
      // same-frame forced gate-off/gate-on pair (forcedControl below)
      // restarts the envelope but is not visible at frame granularity.
      const gateReleaseFrames = rawGate < 0
        ? Math.max(1, Math.round(-rawGate))
        : (inst && inst.gateMode === 'retrigger' ? 1 : null);
      const gateFraction =
        gateReleaseFrames !== null ? 1 : clampRound(rawGate * 1000, 0, 1000, 1000) / 1000;

      if (boundTone !== undefined && Number.isFinite(boundTone)) {
        // vib/slide: per-note pitch modulation on the same onset-relative
        // frame counter as the instrument tables, so both restart with every
        // new note.
        //
        // vib: a sine of `depth` semitones at `rate` Hz, phase 0 at onset.
        //
        // slide: glides the frequency register value (not the semitone
        // number) from the previous note's last written frequency to this
        // note's target over `time` beats. The start is captured once per
        // onset in runtime.slideFromFreqReg; the glide heads for the
        // per-frame (vib-inclusive) target.
        //
        // With neither configured this is just noteToFreqRegister(tone).
        const vibTriCfg = inst && inst.vibTri;
        const vibCfg = vibTriCfg ? null : inst && inst.vib;
        const slideCfg = inst && inst.slide;
        const vibOffsetSemitones = vibCfg
          ? vibCfg.depth * Math.sin(2 * Math.PI * vibCfg.rate * (runtime.framesSinceOnset / framesPerSecond))
          : 0;
        const targetFreqReg = noteToFreqRegister(boundTone + vibOffsetSemitones);

        // vibTri: reproduces the behaviour of GoatTracker 2's instrument
        // vibrato (gplay.c, the CMD_DONOTHING path) rather than approximating
        // it as a sine. After the instrument's delay, an 8-bit phase counter
        // advances by 2 each frame and is mirrored (XOR 0xff) once it passes
        // the compare value while below 0x80; its low bit picks whether
        // `speed` is subtracted from or added to the frequency register.
        //
        // The counter INTEGRATES: `speed` is added to (or subtracted from)
        // the running frequency register every frame, so the pitch offset is
        // a triangle in register units, not a sine in semitones, and its
        // first quarter period is only half the swing of every later one.
        // `delay` is the instrument's own vibdelay, already expressed as the
        // number of frames the player skips before the first vibrato frame.
        let vibTriOffset = 0;
        if (vibTriCfg) {
          if (isOnset || runtime.instVibBase !== boundTone) {
            runtime.instVibTime = 0;
            runtime.instVibOffset = 0;
            runtime.instVibBase = boundTone;
          }
          if (runtime.framesSinceOnset >= vibTriCfg.delay) {
            const speed = vibTriCfg.speedShift !== undefined
              ? Math.max(1, noteToFreqRegister(boundTone + 1) - noteToFreqRegister(boundTone)) >> vibTriCfg.speedShift
              : vibTriCfg.speed;
            if (runtime.instVibTime < 0x80 && runtime.instVibTime > vibTriCfg.cmp) runtime.instVibTime ^= 0xff;
            runtime.instVibTime = (runtime.instVibTime + 0x02) & 0xff;
            runtime.instVibOffset += runtime.instVibTime & 0x01 ? -speed : speed;
          }
          vibTriOffset = runtime.instVibOffset;
        }

        let freqReg = targetFreqReg + vibTriOffset;
        if (isOnset) {
          runtime.slideFromFreqReg = runtime.lastFreqReg != null ? runtime.lastFreqReg : targetFreqReg;
        }
        if (slideCfg && slideCfg.time > 0) {
          const framesPerBeat = framesPerCycle / (song.beatsPerCycle || 4);
          const slideFrames = Math.max(1, Math.round(slideCfg.time * framesPerBeat));
          const progress = Math.min(1, runtime.framesSinceOnset / slideFrames);
          const fromReg = runtime.slideFromFreqReg != null ? runtime.slideFromFreqReg : targetFreqReg;
          freqReg = Math.round(fromReg + (targetFreqReg - fromReg) * progress) + vibTriOffset;
        }
        // 16-bit wrap, as in gplay.c's arithmetic (see the fx block).
        freqReg = ((Math.round(freqReg) % 65536) + 65536) % 65536;

        // --- fx pitch commands (gplay.c's TICKNEFFECTS block) -------------
        // GoatTracker's pitch commands do not recompute a frequency from the
        // note each frame; they mutate a running 16-bit register
        // (cptr->freq) that a new note re-seeds. runtime.fxFreqReg is that
        // register. Skipped entirely for chains without an fx lane.
        if (chain.effectPattern) {
          const op = fx && fx.op;
          const isPitchOp = op === 'pup' || op === 'pdn' || op === 'tp' || op === 'vib';
          // A new note re-seeds the running register - except under tone
          // portamento, which deliberately keeps the OLD pitch and glides
          // toward the new note instead (that is the whole command).
          if ((isOnset || toneportaLegato) && op !== 'tp') runtime.fxFreqReg = targetFreqReg;
          if (runtime.fxFreqReg == null) runtime.fxFreqReg = targetFreqReg;

          if (isPitchOp) {
            // A speed-table entry with the high bit set means "one
            // semitone's worth of frequency at the current note, shifted
            // right by N". It depends on the note, so it is resolved here
            // (see rasterklang-dsl's fx.js parseParam).
            const semitoneWidth = Math.max(1, noteToFreqRegister(boundTone + 1) - noteToFreqRegister(boundTone));
            const resolveParam = (p) => (p.shift !== undefined ? semitoneWidth >> p.shift : p.value);

            if (op === 'pup') {
              runtime.fxFreqReg += resolveParam(fx.a);
            } else if (op === 'pdn') {
              runtime.fxFreqReg -= resolveParam(fx.a);
            } else if (op === 'tp') {
              // gplay.c's CMD_TONEPORTA: step toward the target and clamp on
              // arrival; a speed of 0 snaps there immediately.
              const speed = resolveParam(fx.a);
              if (speed <= 0) {
                runtime.fxFreqReg = targetFreqReg;
              } else if (runtime.fxFreqReg < targetFreqReg) {
                runtime.fxFreqReg = Math.min(targetFreqReg, runtime.fxFreqReg + speed);
              } else if (runtime.fxFreqReg > targetFreqReg) {
                runtime.fxFreqReg = Math.max(targetFreqReg, runtime.fxFreqReg - speed);
              }
            } else if (op === 'vib') {
              // The same triangle counter as vibTri above, matching the
              // behaviour of GoatTracker 2's CMD_VIBRATO.
              const cmpValue = fx.a.shift !== undefined ? 0 : fx.a.value & 0x7f;
              const speed = resolveParam(fx.b);
              if (runtime.vibTime < 0x80 && runtime.vibTime > cmpValue) runtime.vibTime ^= 0xff;
              runtime.vibTime = (runtime.vibTime + 0x02) & 0xff;
              if (runtime.vibTime & 0x01) runtime.fxFreqReg -= speed;
              else runtime.fxFreqReg += speed;
            }
            // The SID frequency register is 16 bits and GoatTracker's own
            // arithmetic wraps rather than clamps.
            runtime.fxFreqReg = ((Math.round(runtime.fxFreqReg) % 65536) + 65536) % 65536;
            freqReg = runtime.fxFreqReg;
          } else {
            runtime.fxFreqReg = freqReg;
          }
        }

        runtime.lastFreqReg = freqReg;

        const { lo, hi } = splitFreq(freqReg);
        target[base + 0] = lo;
        target[base + 1] = hi;
      }

      // fx `pw.N` overrides the pulse width only when the instrument has no
      // pw table, for the same reason as fx `wave.N` below: a running table
      // would overwrite it anyway. The override lasts until the next onset.
      const effectivePulseWidth = runtime.fxPw != null && !(inst && inst.pw) ? runtime.fxPw : pulseWidth;
      const { lo: pwLo, hi: pwHi } = splitPulseWidth(effectivePulseWidth);
      target[base + 2] = pwLo;
      target[base + 3] = pwHi;

      let gate = tone !== undefined ? 1 : 0;
      if (gate === 1 && inst && inst.gateTable) {
        // Per-frame gate-bit table, sampled like the other instrument tables.
        // Overrides the gate fraction entirely. Unlike a fraction it can turn
        // the gate back on mid-note (the tracker gate-in-wavetable trick for
        // retriggering a percussive envelope without a new note). Such a
        // 0->1 change differs from last frame's byte, so the normal register
        // diff emits it without forcing.
        const gateBit = sampleTable(inst.gateTable, runtime.framesSinceOnset, resolveLoopIndex(inst, 'gate'), ...resolveSpeedDelay(inst, 'gate'));
        gate = gateBit ? 1 : 0;
      } else if (gate === 1 && gateReleaseFrames !== null && toneHap) {
        // Absolute-frames form (`gate -N`): the gate drops for the note's
        // last N frames, so back-to-back notes of any length each get a gate
        // low->high edge that is visible at frame granularity (e.g. in a
        // .sid register dump), unlike the same-frame forced pair below.
        const framesInHap = Math.max(1, Math.round(toneHap.durFrac * framesPerCycle));
        const gateOffFrame = Math.max(1, framesInHap - gateReleaseFrames);
        if (runtime.framesSinceOnset >= gateOffFrame) {
          gate = 0;
        }
      } else if (gate === 1 && gateFraction < 1 && toneHap) {
        // Fractional form: the gate drops gateFraction of the way through
        // the Hap (its durFrac converted to frames).
        const framesInHap = Math.max(1, Math.round(toneHap.durFrac * framesPerCycle));
        const gateOffFrame = Math.max(1, Math.floor(gateFraction * framesInHap));
        if (runtime.framesSinceOnset >= gateOffFrame) {
          gate = 0;
        }
      }
      // fx `wave.N` (CMD_SETWAVE) overrides the waveform bits only when the
      // instrument has no wave table: in gplay.c the wave table runs after
      // the tick-0 command and would overwrite the value anyway.
      const effectiveWaveformBits =
        runtime.fxWave != null && !(inst && inst.wave) ? runtime.fxWave & 0xf0 : waveformBits;
      const control = packControl({ waveform: effectiveWaveformBits, gate, sync: syncOn, ring: ringOn, test: testOn });
      target[base + 4] = control;
      // fx `ad.A.D` / `sr.S.R` (CMD_SETAD/CMD_SETSR) set the packed envelope
      // registers directly.
      target[base + 5] = runtime.fxAd != null ? runtime.fxAd : packAD(attack, decay);
      target[base + 6] = runtime.fxSr != null ? runtime.fxSr : packSR(sustain, release);

      if (isOnset) {
        forcedControl.set(base + 4, control & 0xfe);
      }

      nowPlayingVoices[v] = {
        active: gate === 1,
        noteName: gate === 1 ? midiNoteToName(tone) : null,
        midiNote: gate === 1 ? tone : null,
        waveform: decodeWaveforms(waveformBits),
        // What the pulse-width registers hold this frame (including an fx
        // `pw.N` override), e.g. for drawing the real duty cycle in a scope.
        pulseWidth: effectivePulseWidth,
        // 0..15 envelope nibbles, as packed into the registers above.
        attack,
        decay,
        sustain,
        release,
        gate: gate === 1,
        sync: syncOn,
        ring: ringOn,
        test: testOn,
        // Source range of the active mini-notation token (note or rest,
        // independent of gate state), for editor highlighting. null when the
        // note pattern was not built from mini-notation text or nothing is
        // active.
        sourceStart: highlightHap && typeof highlightHap.sourceStart === 'number' ? highlightHap.sourceStart : null,
        sourceEnd: highlightHap && typeof highlightHap.sourceEnd === 'number' ? highlightHap.sourceEnd : null,
        // The string sourceStart/sourceEnd are relative to (see
        // VoiceChain.noteSourceText), and its absolute document segments
        // when known (VoiceChain.noteSourceSegments).
        noteSourceText: chain.noteSourceText ?? null,
        noteSourceSegments: chain.noteSourceSegments ?? null,
        // The same, for the active waveform token(s); null when .s() was not
        // given a plain string or no waveform Hap is active.
        waveformSourceStart,
        waveformSourceEnd,
        waveformSourceText: chain.waveformSourceText ?? null,
        // The same, for the `insts` token that picked the active instrument.
        instSourceStart,
        instSourceEnd,
        instSourceText: chain.instSourceText ?? null,
        instSourceSegments: chain.instSourceSegments ?? null,
      };
    }

    // Filter track, always processed. The default chain is inert: with no
    // mode bits set the SID filter contributes nothing to the output,
    // whatever the cutoff, resonance and routing.
    let nowPlayingFilter;
    {
      const resonance = clampRound(filterChain.resonancePattern.queryAt(cycleIndex, posFrac), 0, 15);
      const modeObj = resolveModeObject(activeValuesAt(filterChain.modePattern, cycleIndex, posFrac));
      const routing = filterChain.routingPattern.queryAt(cycleIndex, posFrac) || {};

      // Pick the winning filterTable write (see filterTableWriteByVoice):
      // most recent onset, ties to the higher voice index.
      let filterTableWrite = null;
      for (let v = 0; v < 3; v += 1) {
        const write = filterTableWriteByVoice[v];
        if (!write) continue;
        if (filterTableWrite === null || write.framesSinceOnset <= filterTableWrite.framesSinceOnset) {
          filterTableWrite = write;
        }
      }

      // Without a filter table the cutoff is fx `fcut.N` (CMD_SETFILTERCUTOFF)
      // if one has fired, else the filter chain's own. A running filter table
      // outranks both (gplay.c's filter table also overwrites a
      // CMD_SETFILTERCUTOFF value on every player call).
      const cutoffBase = fxFilterCutoff != null ? fxFilterCutoff : filterChain.cutoffPattern.queryAt(cycleIndex, posFrac);
      const cutoffRaw = clampRound(filterTableWrite !== null ? filterTableWrite.cutoff : cutoffBase, 0, 2047);

      const { lo: cutoffLo, hi: cutoffHi } = packCutoff(cutoffRaw);
      target[FILTER_REGISTERS.cutoffLo] = cutoffLo;
      target[FILTER_REGISTERS.cutoffHi] = cutoffHi;
      target[FILTER_REGISTERS.resonanceRouting] = ((resonance & 0x0f) << 4) | (packFilterRouting(routing) & 0x07);
      // fx `vol.N` (CMD_SETMASTERVOL) overrides the song's master volume.
      const effectiveVolume = fxMasterVolume != null ? fxMasterVolume : masterVolume;
      target[FILTER_REGISTERS.modeVolume] = packFilterMode(modeObj) | (effectiveVolume & 0x0f);

      nowPlayingFilter = {
        cutoffRaw,
        resonance,
        mode: MODE_NAMES.filter((name) => modeObj[name]),
        routing: [!!routing.voice0, !!routing.voice1, !!routing.voice2],
      };
    }

    frameSource.lastFrame = {
      cycleIndex,
      posFrac,
      voices: nowPlayingVoices,
      filter: nowPlayingFilter,
    };

    // Raw register escape hatch (the `reg` voice field), applied last so it
    // overrides whatever the compiler computed for that address. A rest
    // (queryAt() returning undefined) leaves the byte alone. Addresses are
    // already chip-relative and may point at any register, including the
    // shared filter block.
    for (let v = 0; v < 3; v += 1) {
      const chain = resolvedVoices[v];
      if (!chain || !chain.rawRegs || chain.rawRegs.length === 0) continue;
      for (const { addr, pattern } of chain.rawRegs) {
        const value = pattern.queryAt(cycleIndex, posFrac);
        if (value === undefined) continue;
        target[addr & 0x1f] = clampRound(value, 0, 255);
      }
    }

    const pokes = [];
    for (let addr = 0; addr < 32; addr += 1) {
      if (forcedControl.has(addr)) {
        // Forced gate-off-then-gate-on on a new onset, bypassing the diff:
        // the envelope only restarts on a gate low->high transition, even
        // when the final byte equals last frame's (repeated identical
        // notes).
        pokes.push({ addr, value: forcedControl.get(addr) });
        pokes.push({ addr, value: target[addr] });
      } else if (target[addr] !== previousRegisters[addr]) {
        pokes.push({ addr, value: target[addr] });
      }
    }

    previousRegisters = target;
    return pokes;
  };
}
