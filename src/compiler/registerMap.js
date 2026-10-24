// Chip-relative (0x00-0x1f) SID register layout + byte-packing helpers.
//
// The layout and bit assignments follow the 6581/8580 hardware, as modelled
// by the reference Go emulator the WASM engine is built from. Every register
// address this module produces is chip-relative (addr - 0xD400), matching
// liveEngine.js's frameSource contract and LiveSession.Poke, never a full
// $D400+ CPU address.
//
// This module is pure data/math: no Pattern, no notion of "per-frame sampling"
// - that's compile.js's job. registerMap.js only knows how to turn already-
// resolved scalar values (a MIDI note number, a waveform name, an ADSR nibble,
// ...) into register addresses and packed byte values.

import { PAL_CLOCK_HZ } from '../engine/liveEngine.js';

export { PAL_CLOCK_HZ };

// Per-voice register offsets, relative to that voice's base (voice * 7).
export const VOICE_REGISTER_OFFSETS = {
  freqLo: 0,
  freqHi: 1,
  pwLo: 2,
  pwHi: 3,
  control: 4,
  attackDecay: 5,
  sustainRelease: 6,
};

// Shared filter/volume block, chip-relative.
export const FILTER_REGISTERS = {
  cutoffLo: 0x15,
  cutoffHi: 0x16,
  resonanceRouting: 0x17,
  modeVolume: 0x18,
};

// voiceBase(voice) -> chip-relative base offset for voice 0/1/2 (0, 7, 14).
export function voiceBase(voice) {
  return voice * 7;
}

// voiceRegister(voice, offsetName) -> chip-relative address for one of this
// voice's 7 registers, e.g. voiceRegister(1, 'control') -> 0x0b.
export function voiceRegister(voice, offsetName) {
  const offset = VOICE_REGISTER_OFFSETS[offsetName];
  if (offset === undefined) {
    throw new Error(`Unknown voice register offset name: ${offsetName}`);
  }
  return voiceBase(voice) + offset;
}

// envelopeRatePeriods: the SID envelope generator's 16 hardware "rate
// period" values (index = the 4-bit A/D/S/R nibble 0-15), each the number
// of PAL_CLOCK_HZ CPU cycles between one increment/decrement of the
// envelope's internal 8-bit counter. These are fixed hardware values,
// identical on 6581 and 8580. Exported so UI code that shows envelope times
// in milliseconds (e.g. an ADSR editor) uses the same table as the engine.
export const envelopeRatePeriods = [
  9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251,
];

// noteToFreqRegister(midiNoteNumber) -> uint16 SID frequency register value.
//
// Fn = round(freqHz * 16777216 / 985248), freqHz = 440 * 2^((midi-69)/12).
// Example: midi 55 (G3, 195.998 Hz) -> 3338.
export function noteToFreqRegister(midiNoteNumber) {
  const freqHz = 440 * 2 ** ((midiNoteNumber - 69) / 12);
  const fn = Math.round((freqHz * 16777216) / PAL_CLOCK_HZ);
  return fn & 0xffff;
}

// splitFreq(fn) -> { lo, hi } - 16-bit frequency, both full bytes.
export function splitFreq(fn) {
  const v = fn & 0xffff;
  return { lo: v & 0xff, hi: (v >> 8) & 0xff };
}

// splitPulseWidth(pw) -> { lo, hi } - 12-bit pulse width: lo is the full low
// byte, hi is the low nibble of the high byte (upper nibble of hi unused).
export function splitPulseWidth(pw) {
  const v = pw & 0x0fff;
  return { lo: v & 0xff, hi: (v >> 8) & 0x0f };
}

// packAD(attack, decay) -> voice AD register byte (each nibble 0..15).
export function packAD(attack, decay) {
  return ((attack & 0x0f) << 4) | (decay & 0x0f);
}

// packSR(sustain, release) -> voice SR register byte (each nibble 0..15).
export function packSR(sustain, release) {
  return ((sustain & 0x0f) << 4) | (release & 0x0f);
}

// Waveform control-byte bits (bits 4-7).
export const WAVEFORM_BITS = {
  triangle: 0x10,
  saw: 0x20,
  pulse: 0x40,
  noise: 0x80,
};

// waveformBitsFromValue(value) -> resolve one waveform value (a bitmask
// number already in 0xf0 range, or a name string from WAVEFORM_BITS) to its
// control-byte bits.
//
// A name may be a '+'-joined combination (`noise+pulse`), the spelling for
// simultaneously-active waveforms inside a per-frame `wave` TABLE, where
// there is no mini-notation and so no "[pulse,triangle]" stack available:
// a table slot is one value, so the combination has to live inside that one
// value. (The separate mini-notation route - a cycle-sampled `wave:"[pulse,
// triangle]"` pattern - still combines via compile.js OR-ing simultaneous
// Haps, which is why that path never needed this.) Both spellings resolve to
// the same OR-ed bits, so a real GoatTracker row like 0xE0 can round-trip as
// the readable `noise+pulse+saw` instead of a bare 224.
export function waveformBitsFromValue(value) {
  if (typeof value === 'number') return value & 0xf0;
  if (typeof value === 'string') {
    if (value.includes('+')) {
      return value.split('+').reduce((bits, name) => bits | (WAVEFORM_BITS[name.trim()] || 0), 0);
    }
    return WAVEFORM_BITS[value] || 0;
  }
  return 0;
}

// waveformBitsToName(bits) -> the readable name spelling for a control-byte
// waveform nibble - the inverse of waveformBitsFromValue() above, kept next
// to it so the two can't drift. Single bit -> a plain name ('pulse'); several
// -> the '+'-joined combination ('noise+pulse+saw'); no waveform bits set at
// all -> null, since there is no name for "silent" and callers need to spell
// that as a bare 0. Used by the GoatTracker importer to emit readable wave
// tables instead of raw bitmasks.
export function waveformBitsToName(bits) {
  const masked = bits & 0xf0;
  if (masked === 0) return null;
  const names = Object.entries(WAVEFORM_BITS)
    .filter(([, bit]) => (masked & bit) !== 0)
    .map(([name]) => name);
  return names.length > 0 ? names.join('+') : null;
}

// packControl({ waveform, gate, sync, ring, test }) -> voice control byte.
// waveform may be a pre-combined bitmask (number) or a single name (string);
// gate/sync/ring/test are booleans. Bit layout: bit0 gate, bit1 sync,
// bit2 ring, bit3 test, bits4-7 waveform.
export function packControl({ waveform = 0, gate = false, sync = false, ring = false, test = false } = {}) {
  const waveformBits = waveformBitsFromValue(waveform) & 0xf0;
  return waveformBits | (test ? 0x08 : 0) | (ring ? 0x04 : 0) | (sync ? 0x02 : 0) | (gate ? 0x01 : 0);
}

// packFilterRouting({ voice0, voice1, voice2 }) -> low 3 bits of $17.
// Bit i routes 0-indexed voice i (hardware voices 1/2/3 in the usual 1-based
// numbering) through the filter.
export function packFilterRouting({ voice0 = false, voice1 = false, voice2 = false } = {}) {
  return (voice0 ? 0x01 : 0) | (voice1 ? 0x02 : 0) | (voice2 ? 0x04 : 0);
}

// packFilterMode({ lowpass, bandpass, highpass }) -> bits 4-6 of $18.
export function packFilterMode({ lowpass = false, bandpass = false, highpass = false } = {}) {
  return (lowpass ? 0x10 : 0) | (bandpass ? 0x20 : 0) | (highpass ? 0x40 : 0);
}

// packCutoff(raw11bit) -> { lo, hi } for $15 (low 3 bits) / $16 (full byte).
export function packCutoff(raw11bit) {
  const v = raw11bit & 0x7ff;
  return { lo: v & 0x07, hi: (v >> 3) & 0xff };
}

// Semitone-index -> letter+accidental, the inverse of miniNotation.js's
// NOTE_LETTER_SEMITONE table. Accidentals render with the 's' (sharp) suffix
// - one of the two spellings miniNotation.js accepts for a sharp ('s' or
// '#'; flats use 'f'). This is one canonical, round-trippable form for
// display, not a guess at the spelling originally typed.
const NOTE_NAMES_SHARP = ['c', 'cs', 'd', 'ds', 'e', 'f', 'fs', 'g', 'gs', 'a', 'as', 'b'];

// midiNoteToName(midiNumber) -> human-readable note name matching
// miniNotation.js's note-name convention in reverse, e.g. 60 -> 'c4',
// 61 -> 'cs4' (miniNotation.js: midi = (octave + 1) * 12 + semitone).
// For any integer midiNumber, parseAtomValue(midiNoteToName(midiNumber))
// === midiNumber (round-trips, given parseAtomValue accepts the 's' spelling).
export function midiNoteToName(midiNumber) {
  const n = Math.round(midiNumber);
  const octave = Math.floor(n / 12) - 1;
  const semitone = ((n % 12) + 12) % 12;
  return `${NOTE_NAMES_SHARP[semitone]}${octave}`;
}
