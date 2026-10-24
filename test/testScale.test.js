import { describe, expect, it } from 'vitest';
import { createAscendingScaleFrameSource, freqHzToRegister, voiceRegisters } from '../src/engine/testScale.js';

describe('voiceRegisters', () => {
  it('maps voice 0 to chip-relative offsets 0x00-0x06', () => {
    expect(voiceRegisters(0)).toEqual({
      freqLo: 0x00,
      freqHi: 0x01,
      pwLo: 0x02,
      pwHi: 0x03,
      control: 0x04,
      attackDecay: 0x05,
      sustainRelease: 0x06,
    });
  });

  it('maps voice 1 and voice 2 to base offsets 7 and 14', () => {
    expect(voiceRegisters(1).freqLo).toBe(7);
    expect(voiceRegisters(2).freqLo).toBe(14);
  });
});

describe('freqHzToRegister', () => {
  it('matches the documented G3 195.998Hz -> 3338 reference value', () => {
    // G3 (MIDI 55, 195.998 Hz) is SID frequency register value 3338 at the
    // PAL clock: round(195.998 * 16777216 / 985248).
    expect(freqHzToRegister(195.998)).toBe(3338);
  });
});

describe('createAscendingScaleFrameSource', () => {
  it('emits every register write in the 0x00-0x1f chip-relative range', () => {
    const frameSource = createAscendingScaleFrameSource({ voice: 0 });
    for (let frameIndex = 0; frameIndex < 200; frameIndex += 1) {
      const pokes = frameSource(frameIndex);
      for (const { addr, value } of pokes) {
        expect(addr).toBeGreaterThanOrEqual(0x00);
        expect(addr).toBeLessThanOrEqual(0x1f);
        expect(value).toBeGreaterThanOrEqual(0x00);
        expect(value).toBeLessThanOrEqual(0xff);
      }
    }
  });

  it('does one-time setup (pulse width, ADSR, volume) only on frame 0', () => {
    const frameSource = createAscendingScaleFrameSource({ voice: 0 });
    const frame0Addrs = frameSource(0).map((p) => p.addr);
    expect(frame0Addrs).toEqual(expect.arrayContaining([0x02, 0x03, 0x05, 0x06, 0x18]));

    const frame2Addrs = frameSource(2).map((p) => p.addr);
    expect(frame2Addrs).not.toContain(0x18);
  });

  it('retriggers the gate on each note boundary: gate-off then gate-on', () => {
    const frameSource = createAscendingScaleFrameSource({ voice: 0, framesPerNote: 25 });
    const boundaryPokes = frameSource(25); // start of the second note
    const control = boundaryPokes.find((p) => p.addr === 0x04);
    expect(control.value & 0x01).toBe(0); // gate off, waveform still pulse

    const nextFramePokes = frameSource(26);
    const controlOn = nextFramePokes.find((p) => p.addr === 0x04);
    expect(controlOn.value & 0x01).toBe(1); // gate on
    expect(controlOn.value & 0x40).toBe(0x40); // pulse waveform bit preserved
  });

  it('writes a new frequency at each note boundary', () => {
    const frameSource = createAscendingScaleFrameSource({ voice: 0, framesPerNote: 25 });
    const first = frameSource(0);
    const second = frameSource(25);

    const freqOf = (pokes) => {
      const lo = pokes.find((p) => p.addr === 0x00);
      const hi = pokes.find((p) => p.addr === 0x01);
      return (hi.value << 8) | lo.value;
    };

    expect(freqOf(second)).not.toBe(freqOf(first));
  });
});
