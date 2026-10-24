// Hardcoded test frameSource: an ascending scale on voice 0, poking
// chip-relative SID registers (0x00-0x1f) directly without the pattern
// compiler. Useful as a smoke test that the live engine produces audible,
// glitch-free output.

import { PAL_CLOCK_HZ } from './liveEngine.js';

const A4_MIDI = 69;
const A4_FREQ_HZ = 440;

// C major scale, C4..C5.
const SCALE_MIDI_NOTES = [60, 62, 64, 65, 67, 69, 71, 72];
const FRAMES_PER_NOTE = 25; // 0.5s at 50fps

const WAVEFORM_PULSE = 0x40;
const GATE_BIT = 0x01;
const FILTER_VOLUME_REG = 0x18;

function midiToFreqHz(midiNote) {
  return A4_FREQ_HZ * 2 ** ((midiNote - A4_MIDI) / 12);
}

// Fn = round(freqHz * 16777216 / 985248), 16-bit.
export function freqHzToRegister(freqHz) {
  return Math.round((freqHz * 16777216) / PAL_CLOCK_HZ) & 0xffff;
}

// voiceRegisters(0) -> { freqLo: 0x00, freqHi: 0x01, pwLo: 0x02, pwHi: 0x03,
//                        control: 0x04, attackDecay: 0x05, sustainRelease: 0x06 }
export function voiceRegisters(voice) {
  const base = voice * 7;
  return {
    freqLo: base + 0,
    freqHi: base + 1,
    pwLo: base + 2,
    pwHi: base + 3,
    control: base + 4,
    attackDecay: base + 5,
    sustainRelease: base + 6,
  };
}

// Returns a frameSource(frameIndex) suitable for engine.start()/setFrameSource().
export function createAscendingScaleFrameSource({
  voice = 0,
  notes = SCALE_MIDI_NOTES,
  framesPerNote = FRAMES_PER_NOTE,
} = {}) {
  const reg = voiceRegisters(voice);

  return function frameSource(frameIndex) {
    const pokes = [];

    if (frameIndex === 0) {
      // One-time setup: pulse waveform, ~50% duty cycle, fast-ish envelope,
      // master volume up (no filter routing/modes needed).
      pokes.push({ addr: reg.pwLo, value: 0x00 });
      pokes.push({ addr: reg.pwHi, value: 0x08 });
      pokes.push({ addr: reg.attackDecay, value: 0x09 }); // attack 0, decay 9
      pokes.push({ addr: reg.sustainRelease, value: 0xf0 }); // sustain 15, release 0
      pokes.push({ addr: FILTER_VOLUME_REG, value: 0x0f }); // master volume 15
    }

    const step = Math.floor(frameIndex / framesPerNote);
    const posInStep = frameIndex % framesPerNote;
    const note = notes[step % notes.length];

    if (posInStep === 0) {
      // Load the new frequency and drop the gate so the next frame's gate-on
      // is a clean attack retrigger rather than a no-op.
      const freqReg = freqHzToRegister(midiToFreqHz(note));
      pokes.push({ addr: reg.freqLo, value: freqReg & 0xff });
      pokes.push({ addr: reg.freqHi, value: (freqReg >> 8) & 0xff });
      pokes.push({ addr: reg.control, value: WAVEFORM_PULSE });
    } else if (posInStep === 1) {
      pokes.push({ addr: reg.control, value: WAVEFORM_PULSE | GATE_BIT });
    }

    return pokes;
  };
}
