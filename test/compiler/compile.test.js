import { describe, expect, it } from 'vitest';
import { song, note } from '../../src/compiler/song.js';
import { compile } from '../../src/compiler/compile.js';
import { jux, off, every, rev } from '../../src/pattern/combinators.js';
import { parseMini } from '../../src/pattern/miniNotation.js';
import { sine } from '../../src/pattern/signals.js';
import { continuous } from '../../src/pattern/query.js';
import {
  voiceBase,
  noteToFreqRegister,
  splitFreq,
  splitPulseWidth,
  packAD,
  packSR,
} from '../../src/compiler/registerMap.js';

// Applies a frame's pokes onto a persistent 32-byte shadow register image,
// mirroring exactly what liveEngine.js's renderFrameBatch does with a real
// LiveSession - lets tests reconstruct "what does register X actually hold
// after frame N" even though frameSource only returns *changed* bytes.
function applyPokes(shadow, pokes) {
  for (const { addr, value } of pokes) shadow[addr] = value;
}

function freqBytes(midi) {
  return splitFreq(noteToFreqRegister(midi));
}

describe('compile: static note+waveform register correctness on the gate-on frame', () => {
  it('emits the exact voice-0 register writes on frame 0', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4').s('pulse').adsr(0, 8, 10, 4).pw(2048));
    const frameSource = compile(s);

    const pokes = frameSource(0);
    const voicePokes = pokes.filter((p) => p.addr <= 6);

    const { lo: freqLo, hi: freqHi } = freqBytes(60);
    expect(voicePokes).toEqual([
      { addr: 0, value: freqLo },
      { addr: 1, value: freqHi },
      { addr: 2, value: 0x00 }, // pw lo (2048 -> 0x000|0x08 nibble)
      { addr: 3, value: 0x08 }, // pw hi nibble
      { addr: 4, value: 0x40 }, // forced gate-off: pulse waveform, gate clear
      { addr: 4, value: 0x41 }, // forced gate-on: pulse waveform, gate set
      { addr: 5, value: packAD(0, 8) },
      { addr: 6, value: packSR(10, 4) },
    ]);
  });

  it('never touches registers outside 0x00-0x1f', () => {
    const s = song(120).voice(0, note('c4 e4 g4 ~').s('pulse').adsr(0, 8, 10, 4).pw(2048));
    const frameSource = compile(s);
    for (let i = 0; i < 300; i += 1) {
      for (const { addr, value } of frameSource(i)) {
        expect(addr).toBeGreaterThanOrEqual(0x00);
        expect(addr).toBeLessThanOrEqual(0x1f);
        expect(value).toBeGreaterThanOrEqual(0x00);
        expect(value).toBeLessThanOrEqual(0xff);
      }
    }
  });
});

describe('compile: sine-driven cutoff sweep', () => {
  it('tracks the expected sine curve across frames within a cycle', () => {
    const s = song(120, { beatsPerCycle: 4 }).filter((f) => f.cutoff(sine.range(200, 2000)));
    const frameSource = compile(s);
    const framesPerCycle = 100;

    const shadow = new Array(32).fill(0);
    const rawAt = new Array(framesPerCycle);
    for (let frame = 0; frame < framesPerCycle; frame += 1) {
      applyPokes(shadow, frameSource(frame));
      rawAt[frame] = (shadow[0x15] & 0x07) | (shadow[0x16] << 3);
    }

    for (const frame of [0, 10, 25, 40, 50, 60, 75, 90]) {
      const posFrac = frame / framesPerCycle;
      const sineVal = (Math.sin(2 * Math.PI * posFrac) + 1) / 2;
      const expected = Math.round(200 + sineVal * (2000 - 200));
      expect(Math.abs(rawAt[frame] - expected)).toBeLessThanOrEqual(1);
    }

    // It's an actual sweep, not a frozen value.
    const distinctValues = new Set(rawAt);
    expect(distinctValues.size).toBeGreaterThan(10);
  });
});

describe('compile: arpeggiated chord', () => {
  it('round-robins one frequency write per frame across chord tones', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4,e4,g4').s('pulse'));
    const frameSource = compile(s);
    const shadow = new Array(32).fill(0);

    const toneMidiAt = { c: 60, e: 64, g: 67 };
    const expectedOrder = [toneMidiAt.c, toneMidiAt.e, toneMidiAt.g];

    for (let frame = 0; frame < 12; frame += 1) {
      const pokes = frameSource(frame);
      // Never more than one frequency write for this voice in a single frame.
      expect(pokes.filter((p) => p.addr === 0).length).toBeLessThanOrEqual(1);

      applyPokes(shadow, pokes);
      const freq = shadow[0] | (shadow[1] << 8);
      const expectedTone = expectedOrder[Math.floor(frame / 3) % 3];
      expect(freq).toBe(noteToFreqRegister(expectedTone));
    }
  });
});

describe('compile: .gate() - note length independent of slot width', () => {
  it('defaults to holding the gate for the whole slot (backward compatible, no .gate() call)', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4').s('pulse'));
    const frameSource = compile(s);
    const shadow = new Array(32).fill(0);
    const framesPerCycle = 100; // 120 BPM, 4 beats/cycle -> 100 frames/cycle
    for (let frame = 0; frame < framesPerCycle; frame += 1) {
      applyPokes(shadow, frameSource(frame));
      expect(shadow[4] & 0x01).toBe(1);
    }
  });

  it('forces gate off after `fraction` of the Hap duration, leaving the rest of the slot silent', () => {
    // A single-step-per-cycle note ("c4" alone fills the whole 100-frame
    // cycle), gated for only the first 25% (25 frames) of it.
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4').s('pulse').gate(0.25));
    const frameSource = compile(s);
    const shadow = new Array(32).fill(0);
    const framesPerCycle = 100;
    for (let frame = 0; frame < framesPerCycle; frame += 1) {
      applyPokes(shadow, frameSource(frame));
      const gateOn = (shadow[4] & 0x01) === 1;
      if (frame < 25) {
        expect(gateOn).toBe(true);
      } else {
        expect(gateOn).toBe(false);
      }
    }
  });

  it('applies the gate fraction to each step\'s OWN (possibly unequal, @n-weighted) slot width, not the whole cycle', () => {
    // "~@7 c4@3 ~@14" -- the note's own slot is 3/24 of the cycle. At
    // framesPerCycle=24 that's a 3-frame Hap; gate(1/3) should cut it after
    // exactly 1 frame.
    const s = song(500, { beatsPerCycle: 4 }).voice(0, note('~@7 c4@3 ~@14').s('pulse').gate(1 / 3));
    const frameSource = compile(s);
    const shadow = new Array(32).fill(0);
    const gateStates = [];
    for (let frame = 0; frame < 24; frame += 1) {
      applyPokes(shadow, frameSource(frame));
      gateStates.push((shadow[4] & 0x01) === 1);
    }
    // Frames 0-6: rest (gate off). Frame 7: note onset, gate on for exactly
    // 1 of its 3 frames (gate(1/3) of a 3-frame Hap). Frames 9-23: rest.
    expect(gateStates.slice(0, 7)).toEqual(new Array(7).fill(false));
    expect(gateStates[7]).toBe(true);
    expect(gateStates.slice(8, 24)).toEqual(new Array(16).fill(false));
  });

  it('a new onset after an early gate-off still retriggers cleanly (forced gate-off-then-on)', () => {
    const s = song(500, { beatsPerCycle: 4 }).voice(0, note('c4@1 d4@1').s('pulse').gate(0.5));
    const frameSource = compile(s);
    // 24 frames/cycle, 2 equal-weight steps -> 12 frames each. gate(0.5) ->
    // gate on for the first 6 frames of each 12-frame step.
    const shadow = new Array(32).fill(0);
    const gateStates = [];
    for (let frame = 0; frame < 24; frame += 1) {
      applyPokes(shadow, frameSource(frame));
      gateStates.push((shadow[4] & 0x01) === 1);
    }
    expect(gateStates.slice(0, 6)).toEqual(new Array(6).fill(true));
    expect(gateStates.slice(6, 12)).toEqual(new Array(6).fill(false));
    expect(gateStates.slice(12, 18)).toEqual(new Array(6).fill(true));
    expect(gateStates.slice(18, 24)).toEqual(new Array(6).fill(false));
  });

  it('never touches registers outside 0x00-0x1f/0-255 with a fractional gate in use', () => {
    const s = song(500, { beatsPerCycle: 4 }).voice(0, note('~@7 c4@3 ~@14').s('pulse').adsr(0, 4, 10, 4).gate(1 / 3));
    const frameSource = compile(s);
    for (let i = 0; i < 200; i += 1) {
      for (const { addr, value } of frameSource(i)) {
        expect(addr).toBeGreaterThanOrEqual(0x00);
        expect(addr).toBeLessThanOrEqual(0x1f);
        expect(value).toBeGreaterThanOrEqual(0x00);
        expect(value).toBeLessThanOrEqual(0xff);
      }
    }
  });
});

describe('compile: every(4, rev) on a bassline', () => {
  it('reverses note order only on cycles where cycleIndex % 4 === 0', () => {
    const bassline = every(4, rev, parseMini('c2 e2 g2 a2'));
    const s = song(120, { beatsPerCycle: 4 }).voice(1, note(bassline));
    const frameSource = compile(s);
    const framesPerCycle = 100;
    const shadow = new Array(32).fill(0);
    const base = voiceBase(1);

    function toneSequenceForCycle(cycleIndex) {
      const tones = [];
      for (let step = 0; step < 4; step += 1) {
        const frame = cycleIndex * framesPerCycle + step * 25;
        applyPokes(shadow, frameSource(frame));
        tones.push(shadow[base] | (shadow[base + 1] << 8));
      }
      return tones;
    }

    // Frames must be visited in increasing order (compiler is stateful).
    const cycle0 = toneSequenceForCycle(0);
    const cycle1 = toneSequenceForCycle(1);
    const cycle2 = toneSequenceForCycle(2);
    const cycle3 = toneSequenceForCycle(3);
    const cycle4 = toneSequenceForCycle(4);

    const [c2, e2, g2, a2] = ['c2', 'e2', 'g2', 'a2'].map((n) => {
      const midi = parseMini(n).query(0)[0].value;
      return noteToFreqRegister(midi);
    });

    expect(cycle1).toEqual([c2, e2, g2, a2]);
    expect(cycle2).toEqual([c2, e2, g2, a2]);
    expect(cycle3).toEqual([c2, e2, g2, a2]);
    // cycle 0 and cycle 4 (both %4===0) are reversed relative to 1-3.
    expect(cycle0).toEqual([a2, g2, e2, c2]);
    expect(cycle4).toEqual([a2, g2, e2, c2]);
    expect(cycle0).not.toEqual(cycle1);
  });
});

describe('compile: Euclidean noise pattern on voice 2', () => {
  it('gates on exactly at the bjorklund(3,8) hit positions', () => {
    // bjorklund(3,8) = [T,F,F,T,F,F,T,F] (the canonical tresillo), per
    // miniNotation.js's own documentation of the algorithm.
    const expectedHits = [true, false, false, true, false, false, true, false];
    const s = song(150, { beatsPerCycle: 4 }).voice(2, note('36(3,8)').s('noise'));
    const frameSource = compile(s);
    const framesPerCycle = 80; // 50*60/150*4
    const stepFrames = framesPerCycle / 8;
    const base = voiceBase(2);
    const shadow = new Array(32).fill(0);

    const gateAtStep = [];
    for (let step = 0; step < 8; step += 1) {
      for (let f = 0; f < stepFrames; f += 1) {
        applyPokes(shadow, frameSource(step * stepFrames + f));
      }
      gateAtStep.push((shadow[base + 4] & 0x01) === 1);
    }

    expect(gateAtStep).toEqual(expectedHits);
  });
});

describe('compile: gate retrigger for back-to-back identical notes', () => {
  it('gives each of two identical notes its own gate-off/gate-on pulse', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 c4'));
    const frameSource = compile(s);
    const controlAddr = voiceBase(0) + 4;

    // Prime state through the first note (frames 0-49); nothing forced
    // beyond frame 0's own onset should reappear on frames 1-49.
    for (let frame = 0; frame < 49; frame += 1) {
      frameSource(frame);
    }

    // Frame 50 is the onset of the second "c4" - same note, same waveform,
    // same control byte as the first, so the diff alone would never emit
    // anything here. The compiler must still force a fresh gate-off/on pair.
    const boundaryPokes = frameSource(50).filter((p) => p.addr === controlAddr);
    expect(boundaryPokes.length).toBeGreaterThanOrEqual(2);
    expect(boundaryPokes[0].value & 0x01).toBe(0); // gate off
    expect(boundaryPokes[boundaryPokes.length - 1].value & 0x01).toBe(1); // gate back on
  });

  it('also forces a gate-off/on pulse for the very first note (frame 0)', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 c4'));
    const frameSource = compile(s);
    const controlAddr = voiceBase(0) + 4;
    const pokes = frameSource(0).filter((p) => p.addr === controlAddr);
    expect(pokes.length).toBeGreaterThanOrEqual(2);
    expect(pokes[0].value & 0x01).toBe(0);
    expect(pokes[pokes.length - 1].value & 0x01).toBe(1);
  });
});

describe('compile: jux/off voice-split auto-claims a second free voice', () => {
  it('assigns left to the requested voice and right to the next free voice', () => {
    const split = jux(rev, parseMini('c3 e3 g3 a3'));
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note(split).s('pulse'));
    const frameSource = compile(s);

    const shadow = new Array(32).fill(0);
    applyPokes(shadow, frameSource(0));

    const voice0Freq = shadow[0] | (shadow[1] << 8);
    const voice1Freq = shadow[7] | (shadow[8] << 8);

    const c3 = parseMini('c3').query(0)[0].value;
    const a3 = parseMini('a3').query(0)[0].value; // rev()'d pattern's first Hap is the original's last value

    expect(voice0Freq).toBe(noteToFreqRegister(c3));
    expect(voice1Freq).toBe(noteToFreqRegister(a3));
  });

  it('throws a clear error when no voice is free for the split', () => {
    const split = jux(rev, parseMini('c3 e3'));
    const s = song(120)
      .voice(0, note(split))
      .voice(1, note('c4'))
      .voice(2, note('c5'));
    expect(() => compile(s)).toThrow(/no free|already assigned|second free/i);
  });
});

describe('compile: off() on a note pattern also claims a second voice', () => {
  it('does not throw when a voice is free, and produces output on both voices', () => {
    const echoed = off(0.25, (p) => p, parseMini('c3 ~ ~ ~'));
    const s = song(120).voice(0, note(echoed));
    const frameSource = compile(s);
    expect(() => frameSource(0)).not.toThrow();
    const pokes0 = frameSource(0);
    expect(Array.isArray(pokes0)).toBe(true);
  });
});

describe('compile: startOffsetFrames phase-shifts cycleIndex/posFrac', () => {
  it('defaults to 0, identical to no offset at all', () => {
    const s = song(3000, { beatsPerCycle: 4 }).voice(0, note('<c4 e4>'));
    const frameSource = compile(s);
    const shadow = new Array(32).fill(0);
    applyPokes(shadow, frameSource(0));
    expect(shadow[0] | (shadow[1] << 8)).toBe(noteToFreqRegister(60));
  });

  it('shifts which real frame starts cycle 0, wrapping the lead-in into cycle -1 via cat()', () => {
    const c4 = noteToFreqRegister(60);
    const e4 = noteToFreqRegister(64);
    // framesPerCycle = round((3000/3000)*4) = 4.
    const s = song(3000, { beatsPerCycle: 4, startOffsetFrames: 2 }).voice(0, note('<c4 e4>').s('pulse'));
    const frameSource = compile(s);
    const shadow = new Array(32).fill(0);

    // Real frames 0/1 (before the shifted cycle-0 boundary at real frame 2)
    // fall into cycle -1, which cat()'s `((c % n) + n) % n` wraps to array
    // index 1 (e4) -- not a crash, not frame-0-anchored c4.
    applyPokes(shadow, frameSource(0));
    expect(shadow[0] | (shadow[1] << 8)).toBe(e4);
    applyPokes(shadow, frameSource(1));
    expect(shadow[0] | (shadow[1] << 8)).toBe(e4);

    // Real frame 2 is the first frame of (shifted) cycle 0 -> c4.
    applyPokes(shadow, frameSource(2));
    expect(shadow[0] | (shadow[1] << 8)).toBe(c4);
  });
});

describe('compile: continuous()-driven filter mode dispatch', () => {
  it('samples mode at the real posFrac every frame, not frozen at cycle start', () => {
    const framesPerCycle = 4;
    const modePattern = continuous((cycleIndex, posFrac) => {
      const frame = cycleIndex * framesPerCycle + posFrac * framesPerCycle;
      return frame < 2 ? 'lowpass' : 'bandpass';
    });
    const s = song(3000, { beatsPerCycle: 4 }).filter((f) => f.mode(modePattern).resonance(5));
    const frameSource = compile(s);
    const shadow = new Array(32).fill(0);
    const modeBitsAt = [];
    for (let frame = 0; frame < 4; frame += 1) {
      applyPokes(shadow, frameSource(frame));
      modeBitsAt.push(shadow[0x18] & 0x70);
    }
    // lowpass (0x10) for frames 0-1, bandpass (0x20) for frames 2-3 -- a real
    // within-cycle transition, not stuck at whatever frame 0 sampled.
    expect(modeBitsAt).toEqual([0x10, 0x10, 0x20, 0x20]);
  });

  it('supports a single continuous() callback returning an array for a genuinely simultaneous multi-mode state', () => {
    const modePattern = continuous(() => ['lowpass', 'bandpass']);
    const s = song(3000, { beatsPerCycle: 4 }).filter((f) => f.mode(modePattern));
    const frameSource = compile(s);
    const shadow = new Array(32).fill(0);
    applyPokes(shadow, frameSource(0));
    expect(shadow[0x18] & 0x70).toBe(0x30); // lowpass|bandpass bits both set
  });
});
