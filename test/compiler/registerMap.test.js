import { describe, expect, it } from 'vitest';
import {
  voiceBase,
  voiceRegister,
  noteToFreqRegister,
  splitFreq,
  splitPulseWidth,
  packAD,
  packSR,
  packControl,
  packFilterRouting,
  packFilterMode,
  packCutoff,
  FILTER_REGISTERS,
  envelopeRatePeriods,
  PAL_CLOCK_HZ,
} from '../../src/compiler/registerMap.js';

describe('noteToFreqRegister', () => {
  it('matches the documented G3 195.998Hz -> 3338 reference value (midi:55)', () => {
    // G3 (MIDI 55, 195.998 Hz) is SID frequency register value 3338 at the
    // PAL clock.
    expect(noteToFreqRegister(55)).toBeCloseTo(3338, 0);
    expect(Math.abs(noteToFreqRegister(55) - 3338)).toBeLessThanOrEqual(1);
  });

  it('produces a 16-bit value for a range of notes', () => {
    for (let midi = 24; midi <= 108; midi += 1) {
      const fn = noteToFreqRegister(midi);
      expect(fn).toBeGreaterThanOrEqual(0);
      expect(fn).toBeLessThanOrEqual(0xffff);
    }
  });
});

describe('voiceBase / voiceRegister', () => {
  it('maps voices 0/1/2 to base offsets 0/7/14', () => {
    expect(voiceBase(0)).toBe(0);
    expect(voiceBase(1)).toBe(7);
    expect(voiceBase(2)).toBe(14);
  });

  it('maps named offsets correctly for voice 1', () => {
    expect(voiceRegister(1, 'freqLo')).toBe(7);
    expect(voiceRegister(1, 'freqHi')).toBe(8);
    expect(voiceRegister(1, 'pwLo')).toBe(9);
    expect(voiceRegister(1, 'pwHi')).toBe(10);
    expect(voiceRegister(1, 'control')).toBe(11);
    expect(voiceRegister(1, 'attackDecay')).toBe(12);
    expect(voiceRegister(1, 'sustainRelease')).toBe(13);
  });
});

describe('splitFreq / splitPulseWidth', () => {
  it('splits a 16-bit frequency into two full bytes', () => {
    expect(splitFreq(0x1234)).toEqual({ lo: 0x34, hi: 0x12 });
  });

  it('splits a 12-bit pulse width into a full low byte and a nibble-only high byte', () => {
    expect(splitPulseWidth(2048)).toEqual({ lo: 0x00, hi: 0x08 });
    expect(splitPulseWidth(0x0fff)).toEqual({ lo: 0xff, hi: 0x0f });
  });
});

describe('packAD / packSR', () => {
  it('packs attack/decay and sustain/release nibbles', () => {
    expect(packAD(0, 8)).toBe(0x08);
    expect(packAD(15, 15)).toBe(0xff);
    expect(packSR(10, 4)).toBe(0xa4);
  });
});

describe('packControl', () => {
  it('packs waveform bits, gate, sync, ring, test', () => {
    expect(packControl({ waveform: 'pulse', gate: true })).toBe(0x41);
    expect(packControl({ waveform: 'triangle', gate: false })).toBe(0x10);
    expect(packControl({ waveform: 0x40 | 0x10, gate: true, sync: true, ring: true, test: true })).toBe(
      0x50 | 0x0f,
    );
  });
});

describe('packFilterRouting / packFilterMode / packCutoff', () => {
  it('packs routing as a 3-bit mask, bit i = voice i', () => {
    expect(packFilterRouting({ voice0: true, voice1: false, voice2: true })).toBe(0x05);
  });

  it('packs mode bits 4-6', () => {
    expect(packFilterMode({ lowpass: true })).toBe(0x10);
    expect(packFilterMode({ lowpass: true, highpass: true })).toBe(0x50);
  });

  it('packs an 11-bit cutoff into $15 (low 3 bits) / $16 (full byte)', () => {
    expect(packCutoff(2047)).toEqual({ lo: 0x07, hi: 0xff });
    expect(packCutoff(0)).toEqual({ lo: 0, hi: 0 });
  });

  it('FILTER_REGISTERS matches the documented $15-$18 block', () => {
    expect(FILTER_REGISTERS).toEqual({
      cutoffLo: 0x15,
      cutoffHi: 0x16,
      resonanceRouting: 0x17,
      modeVolume: 0x18,
    });
  });
});

describe('envelopeRatePeriods', () => {
  it('has exactly 16 entries (one per 4-bit A/D/S/R nibble)', () => {
    expect(envelopeRatePeriods).toHaveLength(16);
  });

  it('is monotonically increasing (higher nibble = slower rate)', () => {
    for (let i = 1; i < envelopeRatePeriods.length; i += 1) {
      expect(envelopeRatePeriods[i]).toBeGreaterThan(envelopeRatePeriods[i - 1]);
    }
  });

  it('index 0 and 15 match the documented hardware rate-period constants', () => {
    expect(envelopeRatePeriods[0]).toBe(9);
    expect(envelopeRatePeriods[15]).toBe(31251);
  });

  it('converts to a real per-step ms period via the PAL clock', () => {
    // Sanity bound only (UI code derives exact attack/decay times from this
    // raw table): index 0's per-step period is well under 1ms, index 15's
    // tens of ms.
    const msPerStep0 = (envelopeRatePeriods[0] / PAL_CLOCK_HZ) * 1000;
    const msPerStep15 = (envelopeRatePeriods[15] / PAL_CLOCK_HZ) * 1000;
    expect(msPerStep0).toBeCloseTo(0.00913, 4);
    expect(msPerStep15).toBeGreaterThan(30);
  });
});
