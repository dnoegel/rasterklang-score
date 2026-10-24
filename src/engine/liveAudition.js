// Low-latency live audition: "press a key, hear it now". liveEngine.js's
// pump uses a large lookahead (DEFAULT_SCHEDULE_AHEAD_SECONDS = 0.6s) for
// glitch-free sequenced playback; that lookahead is the latency this module
// removes from a single note's trigger-to-audible path.
//
// --- Reuse, not reimplementation ---------------------------------------
//
// compile.js's frameSource already implements per-frame instrument stepping
// (onset detection, table sampling by frames since onset, the forced
// gate-off/gate-on pair, vib/vibTri/slide, the register diff), entangled
// with per-song state such as the cycle clock and fx lanes. Instead of
// duplicating that, LiveVoice builds a synthetic one-voice Song on noteOn()
// (`note(midiNote).inst(instrument)` on the claimed voice) and runs the real
// compile() on it; every step() is a call into that frameSource. Live and
// sequenced playback of a held note therefore run the same code path (see
// liveAudition.parity.test.js). noteOff() is the one deviation: it masks
// the gate bit directly (see there).
//
// The synthetic song's cycle is far longer than any realistic held note
// (LIVE_HOLD_BEATS), so the note's Hap never ends on its own; ending it is
// noteOff()'s job.
//
// --- Two producers, one register stream --------------------------------
//
// A claimed live voice and a sequenced song may both write the same
// hardware voice's 7 registers on one frame. The rule is "live wins on its
// claimed voice". createVoiceClaimManager() tracks which voices are
// live-owned; arbitrateVoicePokes() applies the rule to one frame's two poke
// lists. Both are standalone and take plain data, so a merged song+live pump
// can use them however it is wired.

import { compile } from '../compiler/compile.js';
import { song, note } from '../compiler/song.js';
import { stack } from '../pattern/combinators.js';
import { pure } from '../pattern/query.js';
import { voiceBase, voiceRegister } from '../compiler/registerMap.js';

export const NUM_VOICES = 3;

// See this module's header: long enough that no live-held note (minutes,
// even hours) ever reaches the synthetic song's own cycle boundary. At the
// default 120bpm/50fps this is ~25,000,000 frames (~5.8 days) per cycle -
// comfortably inside JS's safe-integer range with no overflow risk, and the
// value only needs to be much larger than any real hold time (the cycle
// clock does one division per frame regardless of magnitude).
const LIVE_HOLD_BEATS = 1_000_000;
const LIVE_HOLD_BPM = 120;

// createVoiceClaimManager() -> { claimVoice, releaseVoice, isClaimed,
// claimedVoices }. Tracks which of the 3 hardware voices are currently
// live-owned, independently of LiveVoice instances, so UI code can read and
// change claim state without reaching into playback objects.
export function createVoiceClaimManager() {
  // voiceIndex -> owner tag (opaque; callers can pass whatever identifies
  // the claimant - a UI panel id, 'live', etc. - this module never inspects
  // it beyond presence/absence).
  const claimed = new Map();

  function assertValidVoiceIndex(voiceIndex) {
    if (!Number.isInteger(voiceIndex) || voiceIndex < 0 || voiceIndex >= NUM_VOICES) {
      throw new Error(`claimVoice()/releaseVoice(): voice index must be 0, 1, or 2 (got ${voiceIndex}).`);
    }
  }

  // claimVoice(voiceIndex?, owner?) -> the claimed voice index, or null if
  // unavailable. voiceIndex omitted (or null/undefined) picks the lowest-
  // numbered free voice; an explicit voiceIndex claims exactly that one (or
  // fails - returns null - if it's already claimed, rather than silently
  // picking a different one out from under the caller).
  function claimVoice(voiceIndex = null, owner = 'live') {
    if (voiceIndex === null || voiceIndex === undefined) {
      for (let v = 0; v < NUM_VOICES; v += 1) {
        if (!claimed.has(v)) {
          claimed.set(v, owner);
          return v;
        }
      }
      return null;
    }
    assertValidVoiceIndex(voiceIndex);
    if (claimed.has(voiceIndex)) return null;
    claimed.set(voiceIndex, owner);
    return voiceIndex;
  }

  function releaseVoice(voiceIndex) {
    assertValidVoiceIndex(voiceIndex);
    claimed.delete(voiceIndex);
  }

  function isClaimed(voiceIndex) {
    assertValidVoiceIndex(voiceIndex);
    return claimed.has(voiceIndex);
  }

  function ownerOf(voiceIndex) {
    assertValidVoiceIndex(voiceIndex);
    return claimed.has(voiceIndex) ? claimed.get(voiceIndex) : null;
  }

  function claimedVoices() {
    return [...claimed.keys()].sort((a, b) => a - b);
  }

  return { claimVoice, releaseVoice, isClaimed, ownerOf, claimedVoices };
}

// arbitrateVoicePokes(sequencedPokes, claimedVoiceIndex, livePokes) -> a
// merged { addr, value } poke list for one frame, applying "live wins on its
// claimed voice": every sequencedPokes entry addressed to
// claimedVoiceIndex's own 7 registers (voiceBase(claimedVoiceIndex)..+6) is
// dropped, and livePokes is appended after whatever's left - so, for a
// caller that applies pokes to hardware in array order (as
// renderFrameBatch/renderOfflineFrames both already do), live's writes are
// always the LAST writes to that voice's registers this frame, i.e. the ones
// that actually stick. Registers outside that 7-byte range (the other two
// voices, the shared filter/volume block 0x15-0x18) are untouched - this
// function only ever arbitrates one voice at a time, deliberately, so a
// caller juggling several simultaneously-claimed voices just calls it once
// per claimed voice.
export function arbitrateVoicePokes(sequencedPokes, claimedVoiceIndex, livePokes) {
  const base = voiceBase(claimedVoiceIndex);
  const filtered = (sequencedPokes || []).filter((p) => p.addr < base || p.addr >= base + 7);
  return [...filtered, ...(livePokes || [])];
}

// buildNoteSong(voiceIndex, midiNote, instrument, filter) -> a song.js
// builder with exactly one voice (voiceIndex) holding a single,
// effectively-unbounded note at midiNote, with `instrument` attached exactly
// the same way rasterklang-dsl's interpret.js wires `.inst()` and, when the
// instrument declares one, `.adsr()`. compile.js reads ADSR from the chain's
// own patterns, never from inst.adsr, so whoever builds the chain has to
// unpack it.
// midiNote may be a single note or an ARRAY of simultaneously held notes.
// Several notes become a real mini-notation STACK on the one voice, which is
// what makes a live chord sound exactly like the pattern it will be written
// into: compile.js's own chord reinterpretation ("> 1 simultaneously-active
// Hap round-robins through the tones at arpeggioFrameRate, so only one
// frequency is ever written per frame for this voice") then produces the
// arpeggio, so audition and playback cannot drift apart.
//
// filter is optional. Omitted, the song keeps FilterChain's defaults (mode
// 'none', so the filter is bypassed). Otherwise it is a
// { cutoff, resonance, mode, route } spec applied through FilterChain's own
// setters; `route` is an array of voice indices as FilterChain.route()
// takes them (`route: [0, 2]` === `.route(0, 2)`). Fields left
// undefined/null keep FilterChain's defaults (cutoff 0, resonance 0, mode
// 'none', no routing).
function buildNoteSong(voiceIndex, midiNote, instrument, filter = null) {
  const s = song(LIVE_HOLD_BPM, { beatsPerCycle: LIVE_HOLD_BEATS });
  const notes = Array.isArray(midiNote) ? midiNote : [midiNote];
  const chain = note(notes.length === 1 ? notes[0] : stack(...notes.map((m) => pure(m))));
  if (instrument) {
    chain.inst(instrument);
    if (Array.isArray(instrument.adsr)) chain.adsr(...instrument.adsr);
  }
  s.voice(voiceIndex, chain);
  if (filter) {
    s.filter((f) => {
      if (filter.cutoff !== undefined && filter.cutoff !== null) f.cutoff(filter.cutoff);
      if (filter.resonance !== undefined && filter.resonance !== null) f.resonance(filter.resonance);
      if (filter.mode !== undefined && filter.mode !== null) f.mode(filter.mode);
      if (filter.route !== undefined && filter.route !== null) f.route(...filter.route);
    });
  }
  return s;
}

// LiveVoice: one hardware voice's live-trigger state machine. Does not know
// or care about voice claiming (createVoiceClaimManager owns that) - a
// caller is expected to have already claimed voiceIndex before calling
// noteOn(), and to release it (via the claim manager) once stop() has been
// called here and any release tail has finished.
// Contract note (applies to noteOn()/step()/noteOff() below): every one of
// these returns a { addr, value } poke list for the caller to apply - none
// of them touch a session/WASM engine itself, matching liveEngine.js's own
// renderFrameBatch/renderOfflineFrames split (session-free and unit-testable
// against a fake session). noteOn()'s return value is frame 0's pokes and is
// not applied anywhere automatically: a caller should poke() it into the
// session immediately, separately from pumping step() each frame (e.g. via
// pumpLiveVoiceFrames). Applying it out of band is what makes noteOn()
// faster than waiting for the next pump tick.
export class LiveVoice {
  constructor(voiceIndex) {
    if (!Number.isInteger(voiceIndex) || voiceIndex < 0 || voiceIndex >= NUM_VOICES) {
      throw new Error(`LiveVoice: voice index must be 0, 1, or 2 (got ${voiceIndex}).`);
    }
    this.voiceIndex = voiceIndex;
    this._frameSource = null;
    this._frameIndex = 0;
    this._released = false;
    this._lastControlByte = null;
  }

  // true once noteOn() has run and stop() hasn't been called since - true
  // through the release tail (noteOff() called but sound may still be
  // decaying), false only when genuinely idle.
  get isSounding() {
    return this._frameSource !== null;
  }

  get isReleased() {
    return this._released;
  }

  // noteOn(midiNote, instrument) -> this frame's pokes (chip-relative, this
  // voice's own registers only). Builds a fresh synthetic one-note song (see
  // buildNoteSong above) and immediately steps frame 0 - compile.js's own
  // onset forcing produces the gate-off-then-gate-on pair, exactly as on a
  // sequenced song's first frame of a note.
  // midiNote: one note, or an ARRAY of held notes that should sound as one
  // arpeggiating voice (see buildNoteSong).
  //
  // preserveFrameIndex: keep the frame counter running instead of restarting
  // at 0. Adding a finger to an already-sounding chord must NOT re-strike the
  // envelope or rewind the instrument's tables - the arpeggio simply gains a
  // tone, exactly as it would mid-note in a sequenced pattern. A genuinely
  // new note (nothing held yet) always restarts, which is what produces the
  // real gate-off/gate-on onset pair.
  //
  // filter: optional, forwarded to buildNoteSong (see there for the shape).
  noteOn(midiNote, instrument = null, { preserveFrameIndex = false, filter = null } = {}) {
    const wasSounding = preserveFrameIndex && this._frameSource != null && !this._released;
    this._frameSource = compile(buildNoteSong(this.voiceIndex, midiNote, instrument, filter));
    if (!wasSounding) {
      this._frameIndex = 0;
      this._lastControlByte = null;
    }
    this._released = false;
    return this._stepInternal();
  }

  // step() -> this frame's pokes. Call once per live pump tick (see
  // pumpLiveVoiceFrames below) for as long as isSounding is true, INCLUDING
  // through the release tail after noteOff() - a SID's ADSR release stage
  // keeps the oscillator generating audio (only the envelope is decaying
  // toward 0), and the instrument's tables (a wave table sweep, say) keep
  // stepping too, exactly as they would for a sequenced note whose Hap is
  // still active but whose gate has been dropped early (song.js's
  // .gate(fraction) mechanism).
  step() {
    if (!this._frameSource) return [];
    return this._stepInternal();
  }

  _stepInternal() {
    const raw = this._frameSource(this._frameIndex);
    this._frameIndex += 1;
    const controlAddr = voiceRegister(this.voiceIndex, 'control');
    const pokes = raw.map((p) => ({ addr: p.addr, value: p.value }));
    for (const p of pokes) {
      if (p.addr === controlAddr) this._lastControlByte = p.value;
    }
    if (this._released) {
      // See noteOff()'s comment: force the gate bit low on every control
      // write from here on, since the synthetic song's own Hap never ends
      // (see LIVE_HOLD_BEATS), so its frameSource keeps computing gate=1
      // after the key is released.
      let sawControl = false;
      for (const p of pokes) {
        if (p.addr === controlAddr) {
          p.value &= 0xfe;
          this._lastControlByte = p.value;
          sawControl = true;
        }
      }
      if (!sawControl && this._lastControlByte !== null) {
        pokes.push({ addr: controlAddr, value: this._lastControlByte & 0xfe });
      }
    }
    return pokes;
  }

  // noteOff() -> the poke(s) to apply RIGHT NOW to begin the release phase:
  // a real, immediate gate high->low edge on the control register, same bit
  // song.js's own .gate(fraction)/`gate -N` mechanisms flip for a sequenced
  // note's early release - see compile.js's gateFraction/gateReleaseFrames
  // block. This is the one place LiveVoice does NOT just call the real
  // frameSource: those sequenced mechanisms all need the note's total
  // duration decided in ADVANCE (a gate fraction is relative to the Hap's
  // own durFrac; gate -N counts back from the Hap's end) so compile.js can
  // compute which frame to drop the gate on. In live play the key-up is the
  // schedule. Reshaping the synthetic song would mean recompiling and losing
  // the running table state, so this masks the gate bit of the last
  // computed control byte instead, leaving waveform/sync/ring/test as
  // compile.js computed them. Everything else after this (frequency, pulse
  // width, advancing tables) is still driven by the real frameSource via
  // step().
  noteOff() {
    if (!this._frameSource || this._released) return [];
    this._released = true;
    if (this._lastControlByte === null) return [];
    const controlAddr = voiceRegister(this.voiceIndex, 'control');
    const value = this._lastControlByte & 0xfe;
    this._lastControlByte = value;
    return [{ addr: controlAddr, value }];
  }

  // stop() -> forget this note entirely; the voice is free for a new
  // noteOn(). Emits no pokes itself - a caller that wants the release tail
  // actually heard should noteOff() and pump a few more frames first.
  stop() {
    this._frameSource = null;
    this._frameIndex = 0;
    this._released = false;
    this._lastControlByte = null;
  }
}

// createLiveAudition() -> a claim-manager-backed bundle of all 3 LiveVoices,
// the convenience surface for UI code:
// noteOn() claims a free (or specific) voice and triggers it in one call;
// noteOff()/release() take a voiceIndex the caller already knows about
// (typically the one noteOn() returned).
export function createLiveAudition() {
  const claimManager = createVoiceClaimManager();
  const voices = [new LiveVoice(0), new LiveVoice(1), new LiveVoice(2)];

  // midiNote may be a single note or an array of held notes sounding as one
  // arpeggiating voice; options are forwarded to LiveVoice.noteOn as-is (see
  // preserveFrameIndex and filter there).
  function noteOn(midiNote, instrument = null, voiceIndex = null, options = undefined) {
    const claimed = claimManager.claimVoice(voiceIndex, 'live');
    if (claimed === null) return null;
    const pokes = voices[claimed].noteOn(midiNote, instrument, options);
    return { voiceIndex: claimed, pokes };
  }

  function step(voiceIndex) {
    return voices[voiceIndex].step();
  }

  // stepAll() -> every currently-claimed live voice's pokes for this frame,
  // in claimed-voice order - the shape a merged song+live pump would want
  // (see arbitrateVoicePokes above), one entry per claimed voice.
  function stepAll() {
    return claimManager.claimedVoices().map((voiceIndex) => ({ voiceIndex, pokes: voices[voiceIndex].step() }));
  }

  function noteOff(voiceIndex) {
    return voices[voiceIndex].noteOff();
  }

  function release(voiceIndex) {
    voices[voiceIndex].stop();
    claimManager.releaseVoice(voiceIndex);
  }

  return { claimManager, voices, noteOn, step, stepAll, noteOff, release };
}

// --- Low-latency pump ----------------------------------------------------
//
// renderFrameBatch (liveEngine.js) already IS a frame pump - poke()s +
// readChunk()s framesPerBuffer frames against a session - just tuned for
// sequenced playback's lookahead scheduling (DEFAULT_FRAMES_PER_BUFFER = 6,
// ~120ms/buffer). pumpLiveVoiceFrames below adapts that same per-frame
// poke+readChunk shape to a single already-triggered LiveVoice instead of a
// whole-song frameSource, at a much smaller buffer size (one frame by
// default; see AUDITION_FRAMES_PER_BUFFER in liveEngine.js for the
// reasoning).
export const DEFAULT_LIVE_FRAMES_PER_BUFFER = 1;

export function pumpLiveVoiceFrames({ liveVoice, session, samplesPerFrame, framesPerBuffer = DEFAULT_LIVE_FRAMES_PER_BUFFER }) {
  const data = new Float32Array(framesPerBuffer * samplesPerFrame);
  for (let f = 0; f < framesPerBuffer; f += 1) {
    const pokes = liveVoice.step();
    for (const { addr, value } of pokes) {
      session.poke(addr & 0x1f, value & 0xff);
    }
    const samples = session.readChunk(samplesPerFrame);
    const base = f * samplesPerFrame;
    for (let i = 0; i < samples.length; i += 1) {
      data[base + i] = Math.max(-1, samples[i] / 32768);
    }
  }
  return data;
}

// measureFrameCycleCostMs({session, samplesPerFrame, iterations}) -> the
// REAL, measured wall-clock cost (median, milliseconds) of one poke+
// readChunk cycle against `session` - a handful of representative register
// pokes (freq lo/hi, control, AD, SR - the same registers a real noteOn/step
// touches) followed by one readChunk(samplesPerFrame). Used by
// liveAudition.latency.test.js to derive a trigger-to-audible bound from
// measured rather than assumed numbers.
export function measureFrameCycleCostMs({ session, samplesPerFrame, iterations = 200, warmupIterations = 200 }) {
  const runOne = (i) => {
    session.poke(0, i & 0xff);
    session.poke(1, (i >> 8) & 0xff);
    session.poke(4, 0x41);
    session.poke(5, 0x0a);
    session.poke(6, 0xf0);
    session.readChunk(samplesPerFrame);
  };
  for (let i = 0; i < warmupIterations; i += 1) runOne(i);

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    runOne(i);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.floor(samples.length * 0.95)],
    minMs: samples[0],
  };
}

// estimateTriggerToAudibleLatencyMs({frameCycleCostMs, schedulingFloorMs}) ->
// noteOn-call to first-audible-sample bound, built from:
//   - frameCycleCostMs: REAL measured wasm poke+readChunk cost for the one
//     frame of audio a noteOn() call must produce before anything can be
//     scheduled at all (see measureFrameCycleCostMs above).
//   - schedulingFloorMs: an assumption, not a measurement (there is no real
//     AudioContext in a headless run). The default 10ms is liveEngine.js's
//     own scheduling floor (`Math.max(scheduledTime,
//     audioContext.currentTime + 0.01)` in pump()); a real browser may add
//     a few ms of jitter on top.
export function estimateTriggerToAudibleLatencyMs({ frameCycleCostMs, schedulingFloorMs = 10 }) {
  return frameCycleCostMs + schedulingFloorMs;
}
