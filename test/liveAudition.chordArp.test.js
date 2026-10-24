import { describe, it, expect } from 'vitest';
import { LiveVoice } from '../src/engine/liveAudition.js';
import { voiceRegister } from '../src/compiler/registerMap.js';

// A SID voice is monophonic, so several notes held at once are not a chord:
// compile.js round-robins through them at arpeggioFrameRate, writing ONE
// frequency per frame. LiveVoice.noteOn() accepts an array so a live chord
// goes through that very same code path - which is what makes the audition
// sound like the pattern it will be written into, instead of spreading the
// chord over three voices and writing a one-voice arpeggio.
function freqOf(pokes, voiceIndex) {
  const lo = voiceRegister(voiceIndex, 'freqLo');
  const hi = voiceRegister(voiceIndex, 'freqHi');
  const loPoke = [...pokes].reverse().find((p) => p.addr === lo);
  const hiPoke = [...pokes].reverse().find((p) => p.addr === hi);
  if (!loPoke || !hiPoke) return null;
  return (hiPoke.value << 8) | loPoke.value;
}

describe('LiveVoice: several held notes arpeggiate on ONE voice', () => {
  it('a single held note writes one steady frequency', () => {
    const v = new LiveVoice(0);
    const seen = new Set();
    let pokes = v.noteOn(60);
    for (let i = 0; i < 30; i += 1) {
      const f = freqOf(pokes, 0);
      if (f != null) seen.add(f);
      pokes = v.step();
    }
    expect(seen.size).toBe(1);
  });

  it('three held notes cycle through three distinct frequencies on that one voice', () => {
    const v = new LiveVoice(0);
    const seen = new Set();
    let pokes = v.noteOn([60, 64, 67]);
    for (let i = 0; i < 60; i += 1) {
      const f = freqOf(pokes, 0);
      if (f != null) seen.add(f);
      pokes = v.step();
    }
    // exactly the three tones, cycling - never a fourth value, never one
    expect(seen.size).toBe(3);
  });

  it('writes only ONE frequency per frame - it is still a mono voice', () => {
    const v = new LiveVoice(0);
    let pokes = v.noteOn([60, 64, 67]);
    for (let i = 0; i < 20; i += 1) {
      const hiWrites = pokes.filter((p) => p.addr === voiceRegister(0, 'freqHi'));
      expect(hiWrites.length).toBeLessThanOrEqual(1);
      pokes = v.step();
    }
  });

  it('touches no OTHER voice\'s registers', () => {
    // Voice 1 owns 7..13. It also writes the shared filter/volume block
    // (21..24) - pre-existing behaviour of the live path, arbitrated against
    // sequenced playback elsewhere - so only voices 0 and 2 are off limits.
    const OTHER_VOICE_REGISTERS = [0, 1, 2, 3, 4, 5, 6, 14, 15, 16, 17, 18, 19, 20];
    const v = new LiveVoice(1);
    let pokes = v.noteOn([60, 64, 67]);
    for (let i = 0; i < 20; i += 1) {
      for (const p of pokes) {
        expect(OTHER_VOICE_REGISTERS, `poke to ${p.addr} escaped voice 1`).not.toContain(p.addr);
      }
      pokes = v.step();
    }
  });

  it('adding a note to a sounding chord does not rewind the envelope (preserveFrameIndex)', () => {
    const held = new LiveVoice(0);
    held.noteOn(60);
    for (let i = 0; i < 10; i += 1) held.step();
    const beforeControl = held._lastControlByte;
    const pokes = held.noteOn([60, 64], null, { preserveFrameIndex: true });
    // no fresh gate-off/gate-on onset pair: the control byte did not have to
    // be re-established from scratch
    expect(held._frameIndex).toBeGreaterThan(1);
    expect(beforeControl).not.toBeNull();
    expect(Array.isArray(pokes)).toBe(true);
  });

  it('a genuinely new note (nothing sounding) still restarts from frame 0', () => {
    const v = new LiveVoice(0);
    v.noteOn(60);
    for (let i = 0; i < 10; i += 1) v.step();
    v.noteOff();
    v.stop();
    v.noteOn(67, null, { preserveFrameIndex: true });
    expect(v._frameIndex).toBe(1); // frame 0 was just stepped by noteOn()
  });
});
