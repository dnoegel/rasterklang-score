import { describe, expect, it } from 'vitest';
import {
  decodeWaveforms,
  decodeFilterModes,
  decodeVoice,
  decodeFilter,
  decodeRegisters,
} from '../../src/compiler/registerSnapshot.js';

// Builds a 32-byte chip-relative register array like session.registers()
// returns, with everything defaulting to 0 unless overridden by index.
function registersWith(overrides) {
  const bytes = new Array(32).fill(0);
  for (const [index, value] of Object.entries(overrides)) {
    bytes[Number(index)] = value;
  }
  return bytes;
}

describe('decodeWaveforms', () => {
  it('decodes a single waveform bit', () => {
    expect(decodeWaveforms(0x40)).toEqual(['pulse']);
  });

  it('decodes a combined waveform stack, e.g. [pulse,triangle]', () => {
    expect(decodeWaveforms(0x50)).toEqual(['triangle', 'pulse']);
  });

  it('decodes no waveform bits as an empty list', () => {
    expect(decodeWaveforms(0x01)).toEqual([]); // gate bit only, no waveform
  });
});

describe('decodeFilterModes', () => {
  it('decodes lowpass', () => {
    expect(decodeFilterModes(0x10)).toEqual(['lowpass']);
  });

  it('decodes a combined lowpass+bandpass mode', () => {
    expect(decodeFilterModes(0x30)).toEqual(['lowpass', 'bandpass']);
  });
});

describe('decodeVoice', () => {
  it('decodes voice 0 frequency, pulse width, waveform, gate and ADSR from known register bytes', () => {
    // Voice 0 base = 0: freqLo=0x0a, freqHi=0x0d -> 0x0d0a; pwLo=0xff,
    // pwHi=0x08 (low nibble 0x8, high nibble ignored) -> 0x8ff; control =
    // pulse (0x40) + gate (0x01) = 0x41; AD = attack 3, decay 5 -> 0x35;
    // SR = sustain 15, release 2 -> 0xf2.
    const bytes = registersWith({
      0: 0x0a,
      1: 0x0d,
      2: 0xff,
      3: 0x08,
      4: 0x41,
      5: 0x35,
      6: 0xf2,
    });

    const voice = decodeVoice(bytes, 0);
    expect(voice.frequency).toBe(0x0d0a);
    expect(voice.pulseWidth).toBe(0x8ff);
    expect(voice.waveforms).toEqual(['pulse']);
    expect(voice.gate).toBe(true);
    expect(voice.sync).toBe(false);
    expect(voice.ring).toBe(false);
    expect(voice.test).toBe(false);
    expect(voice.attack).toBe(3);
    expect(voice.decay).toBe(5);
    expect(voice.sustain).toBe(15);
    expect(voice.release).toBe(2);
  });

  it('decodes voice 1 (base offset 7) sync/ring/test bits independently of voice 0', () => {
    const bytes = registersWith({ 11: 0x0e }); // voice1 control = sync|ring|test, no gate/waveform
    const voice = decodeVoice(bytes, 1);
    expect(voice.gate).toBe(false);
    expect(voice.sync).toBe(true);
    expect(voice.ring).toBe(true);
    expect(voice.test).toBe(true);
    expect(voice.waveforms).toEqual([]);
  });
});

describe('decodeFilter', () => {
  it('decodes cutoff/resonance/routing/mode/volume from known register bytes', () => {
    // $15 low 3 bits = 0x05, $16 full byte = 0x3c -> cutoffRaw = 0x05 | (0x3c<<3) = 0x1e5.
    // $17 = resonance nibble 0x0a (10) in high nibble, routing bits voice0+voice2 (0x05).
    // $18 = lowpass (0x10) + volume 0x0f (15).
    const bytes = registersWith({
      0x15: 0x05,
      0x16: 0x3c,
      0x17: 0xa5,
      0x18: 0x1f,
    });

    const filter = decodeFilter(bytes);
    expect(filter.cutoffRaw).toBe((0x05 & 0x07) | (0x3c << 3));
    expect(filter.resonance).toBe(10);
    expect(filter.routing).toEqual({ voice0: true, voice1: false, voice2: true });
    expect(filter.modes).toEqual(['lowpass']);
    expect(filter.voice3Off).toBe(false);
    expect(filter.volume).toBe(15);
  });
});

describe('decodeRegisters', () => {
  it('decodes all three voices plus the shared filter from a full 32-byte snapshot', () => {
    const bytes = registersWith({
      4: 0x41, // voice 0 control: pulse + gate
      11: 0x11, // voice 1 control: triangle + gate
      18: 0x21, // voice 2 control: saw + gate
      0x18: 0x1f, // lowpass, volume 15
    });

    const snapshot = decodeRegisters(bytes);
    expect(snapshot.voices).toHaveLength(3);
    expect(snapshot.voices[0].waveforms).toEqual(['pulse']);
    expect(snapshot.voices[0].gate).toBe(true);
    expect(snapshot.voices[1].waveforms).toEqual(['triangle']);
    expect(snapshot.voices[2].waveforms).toEqual(['saw']);
    expect(snapshot.filter.modes).toEqual(['lowpass']);
    expect(snapshot.filter.volume).toBe(15);
  });

  it('defaults missing/short register arrays to all-zero state instead of throwing', () => {
    const snapshot = decodeRegisters([]);
    expect(snapshot.voices[0]).toEqual({
      frequency: 0,
      pulseWidth: 0,
      waveforms: [],
      gate: false,
      sync: false,
      ring: false,
      test: false,
      attack: 0,
      decay: 0,
      sustain: 0,
      release: 0,
    });
    expect(snapshot.filter.cutoffRaw).toBe(0);
    expect(snapshot.filter.modes).toEqual([]);
  });
});
