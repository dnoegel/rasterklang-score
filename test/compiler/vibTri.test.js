// DSL v2 2.18.0's `vibTri` - GoatTracker's own instrument vibrato - verified
// where it matters: against a direct transcription of gplay.c's own loop,
// frame by frame, rather than against "some wobble appeared".
//
// The feature exists because converted GoatTracker songs emitted NO vibrato
// at all for every instrument carrying one (a speed-table pointer plus a
// delay byte), and `vib DEPTH RATE` could not stand in for it: that is a
// sine in semitones, this is an integrating triangle in raw frequency-
// register units. Each test below pins one property that difference turns on.
import { describe, it, expect } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from '../../src/compiler/compile.js';

function runFrames(source, n) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  const states = [];
  for (let i = 0; i < n; i += 1) {
    for (const { addr, value } of frameSource(i)) regs[addr] = value;
    states.push(regs.slice());
  }
  return states;
}

const voiceFreq = (state, v) => state[v * 7] | (state[v * 7 + 1] << 8);

// gplayVibratoOffsets(cmp, speed, frames) -> the frequency-register OFFSET
// GoatTracker 2's vibrato (gplay.c, CMD_VIBRATO) has accumulated after each
// frame: an 8-bit phase counter steps by 2, is mirrored (XOR 0xff) once it
// passes `cmp` while below 0x80, and its low bit chooses -speed or +speed.
// Written as a standalone loop so the test doesn't share code with compile.js.
function gplayVibratoOffsets(cmp, speed, frames) {
  let vibtime = 0;
  let freq = 0;
  const out = [];
  for (let i = 0; i < frames; i += 1) {
    if (vibtime < 0x80 && vibtime > cmp) vibtime ^= 0xff;
    vibtime = (vibtime + 0x02) & 0xff;
    if (vibtime & 0x01) freq -= speed;
    else freq += speed;
    out.push(freq);
  }
  return out;
}

describe('vibTri: GoatTracker instrument vibrato', () => {
  const song = (field) => `tempo 30 beats 1\ninstrument lead\n  wave pulse\n  ${field}\nend\nvoice 0 lead "c4"\n`;

  it('reproduces gplay.c frame for frame', () => {
    const cmp = 5;
    const speed = 40;
    const plain = runFrames(song('adsr 0 9 15 0'), 40);
    const vib = runFrames(song(`vibTri ${cmp} ${speed} 0`), 40);

    const base = voiceFreq(plain[0], 0);
    const want = gplayVibratoOffsets(cmp, speed, 40);
    for (let i = 0; i < 40; i += 1) {
      expect(voiceFreq(vib[i], 0) - base).toBe(want[i]);
    }
  });

  it('is a triangle, not a sine: every step is exactly +/-SPEED', () => {
    const vib = runFrames(song('vibTri 5 40 0'), 40);
    const steps = [];
    for (let i = 1; i < 40; i += 1) steps.push(voiceFreq(vib[i], 0) - voiceFreq(vib[i - 1], 0));
    for (const s of steps) expect(Math.abs(s)).toBe(40);
    // ...and it does change direction, i.e. it is a triangle rather than a
    // one-way portamento.
    expect(new Set(steps).size).toBe(2);
  });

  it('holds the plain note pitch for DELAY frames before it starts', () => {
    const delay = 8;
    const plain = runFrames(song('adsr 0 9 15 0'), 20);
    const vib = runFrames(song(`vibTri 5 40 ${delay}`), 20);
    for (let i = 0; i < delay; i += 1) {
      expect(voiceFreq(vib[i], 0)).toBe(voiceFreq(plain[i], 0));
    }
    expect(voiceFreq(vib[delay], 0)).not.toBe(voiceFreq(plain[delay], 0));
  });

  it('CMP sets the period: one half period is CMP+2 frames', () => {
    for (const cmp of [3, 5, 16]) {
      const vib = runFrames(song(`vibTri ${cmp} 40 0`), 120);
      const dirs = [];
      for (let i = 1; i < 120; i += 1) dirs.push(Math.sign(voiceFreq(vib[i], 0) - voiceFreq(vib[i - 1], 0)));
      // Length of the second run of same-signed steps - the first one is
      // gplay.c's half-amplitude start-up quarter period.
      let i = 0;
      while (dirs[i] === dirs[0]) i += 1;
      let run = 0;
      while (dirs[i + run] === dirs[i]) run += 1;
      expect(run).toBe(cmp + 2);
    }
  });

  it("the shift-derived speed `sN` is one semitone at the sounding note, not a constant", () => {
    // The whole reason `sN` survives to compile time: the same instrument
    // must swing wider at a higher note, because a semitone IS wider there.
    const two = (note) => `tempo 30 beats 1\ninstrument lead\n  wave pulse\n  vibTri 5 s2 0\nend\nvoice 0 lead "${note}"\n`;
    const low = runFrames(two('c2'), 8);
    const high = runFrames(two('c5'), 8);
    const swing = (states) => Math.abs(voiceFreq(states[1], 0) - voiceFreq(states[0], 0));
    expect(swing(high)).toBeGreaterThan(swing(low) * 4);
  });

  it('wins over `vib` when an instrument sets both', () => {
    const both = runFrames(
      'tempo 30 beats 1\ninstrument lead\n  wave pulse\n  vib 0.15 5\n  vibTri 5 40 0\nend\nvoice 0 lead "c4"\n',
      12,
    );
    const only = runFrames(song('vibTri 5 40 0'), 12);
    for (let i = 0; i < 12; i += 1) expect(voiceFreq(both[i], 0)).toBe(voiceFreq(only[i], 0));
  });
});
