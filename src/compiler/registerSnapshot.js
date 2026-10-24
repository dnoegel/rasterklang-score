// registerSnapshot.js - decode a 32-byte chip-relative register snapshot
// (e.g. a live session's registers()) into a readable per-voice / filter
// shape, for live register views.
//
// Only register-backed state is recoverable: per voice frequency, pulse
// width, waveform bits, gate/sync/ring/test and ADSR nibbles; for the shared
// filter cutoff, resonance, mode, routing and volume. Chip-internal state
// such as oscillator phase or envelope level is not in the register file.
//
// Pure data/math, same spirit as registerMap.js (this module is registerMap's
// inverse): no Pattern, no DOM, no engine - just bytes in, plain object out,
// so it's trivially unit-testable against known register values.

import { VOICE_REGISTER_OFFSETS, FILTER_REGISTERS, WAVEFORM_BITS } from './registerMap.js';

const FILTER_MODE_BITS = { lowpass: 0x10, bandpass: 0x20, highpass: 0x40 };

function byteAt(bytes, index) {
  return bytes[index] ?? 0;
}

// decodeWaveforms(control) -> array of active waveform names (bits 4-7),
// e.g. a combined "[pulse,triangle]" mini-notation stack decodes to
// ['triangle', 'pulse'].
export function decodeWaveforms(control) {
  return Object.keys(WAVEFORM_BITS).filter((name) => (control & WAVEFORM_BITS[name]) !== 0);
}

// decodeFilterModes(modeByte) -> array of active filter mode names (bits
// 4-6); modeByte may be the full $18 byte or already masked to 0x70.
export function decodeFilterModes(modeByte) {
  return Object.keys(FILTER_MODE_BITS).filter((name) => (modeByte & FILTER_MODE_BITS[name]) !== 0);
}

// decodeVoice(bytes, voiceIndex) -> one voice's register-derived state.
export function decodeVoice(bytes, voiceIndex) {
  const base = voiceIndex * 7;
  const freqLo = byteAt(bytes, base + VOICE_REGISTER_OFFSETS.freqLo);
  const freqHi = byteAt(bytes, base + VOICE_REGISTER_OFFSETS.freqHi);
  const pwLo = byteAt(bytes, base + VOICE_REGISTER_OFFSETS.pwLo);
  const pwHi = byteAt(bytes, base + VOICE_REGISTER_OFFSETS.pwHi);
  const control = byteAt(bytes, base + VOICE_REGISTER_OFFSETS.control);
  const ad = byteAt(bytes, base + VOICE_REGISTER_OFFSETS.attackDecay);
  const sr = byteAt(bytes, base + VOICE_REGISTER_OFFSETS.sustainRelease);

  return {
    frequency: freqLo | (freqHi << 8),
    pulseWidth: pwLo | ((pwHi & 0x0f) << 8),
    waveforms: decodeWaveforms(control),
    gate: (control & 0x01) !== 0,
    sync: (control & 0x02) !== 0,
    ring: (control & 0x04) !== 0,
    test: (control & 0x08) !== 0,
    attack: (ad >> 4) & 0x0f,
    decay: ad & 0x0f,
    sustain: (sr >> 4) & 0x0f,
    release: sr & 0x0f,
  };
}

// decodeFilter(bytes) -> the shared filter/volume block's register-derived
// state ($15-$18).
export function decodeFilter(bytes) {
  const cutoffLo = byteAt(bytes, FILTER_REGISTERS.cutoffLo);
  const cutoffHi = byteAt(bytes, FILTER_REGISTERS.cutoffHi);
  const resonanceRouting = byteAt(bytes, FILTER_REGISTERS.resonanceRouting);
  const modeVolume = byteAt(bytes, FILTER_REGISTERS.modeVolume);

  return {
    cutoffRaw: (cutoffLo & 0x07) | (cutoffHi << 3),
    resonance: (resonanceRouting >> 4) & 0x0f,
    routing: {
      voice0: (resonanceRouting & 0x01) !== 0,
      voice1: (resonanceRouting & 0x02) !== 0,
      voice2: (resonanceRouting & 0x04) !== 0,
    },
    modes: decodeFilterModes(modeVolume & 0x70),
    voice3Off: (modeVolume & 0x80) !== 0,
    volume: modeVolume & 0x0f,
  };
}

// decodeRegisters(bytes) -> { voices: [voice0, voice1, voice2], filter } -
// the full-chip register snapshot decode.
export function decodeRegisters(bytes) {
  return {
    voices: [0, 1, 2].map((i) => decodeVoice(bytes, i)),
    filter: decodeFilter(bytes),
  };
}
