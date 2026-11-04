// Backport (0.1.4) of rasterklang-dsl's test/dsl/gateTableHardRestart.test.js,
// DSL 4.6.0 and 4.7.0: a gate table plus `hardRestart N` (or `gate -N`). The table runs
// as before; in the note's last N frames before a following note the gate
// closes and the hard-restart clauses are written, exactly as `hardRestart N`
// does on an instrument without a table. Assertions are on the register state
// per frame, as in playerIdioms2.test.js.
import { describe, expect, it } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from '../../src/compiler/compile.js';
import { VOICE_REGISTER_OFFSETS } from '../../src/compiler/registerMap.js';

function registerFrames(src, frameCount) {
  const frameSource = compile(compileDslV2Source(src));
  const regs = new Array(32).fill(0);
  const out = [];
  for (let f = 0; f < frameCount; f += 1) {
    for (const { addr, value } of frameSource(f)) regs[addr] = value;
    out.push(regs.slice());
  }
  return out;
}

const gate = (f) => f[VOICE_REGISTER_OFFSETS.control] & 1;
const test = (f) => (f[VOICE_REGISTER_OFFSETS.control] >> 3) & 1;
const ad = (f) => f[VOICE_REGISTER_OFFSETS.attackDecay];
const sr = (f) => f[VOICE_REGISTER_OFFSETS.sustainRelease];
// 4 frames per step, 4 steps per bar
const CLOCK = 'speed 4 beats 4';
const song = (fields, notes) => `${CLOCK}
instrument a
  wave pulse
  adsr 1 2 3 4
${fields.map((f) => `  ${f}`).join('\n')}
end
voice 0 a "${notes}"
`;

describe('gate table plus hardRestart', () => {
  it('a gate table alone still runs unchanged', () => {
    const frames = registerFrames(song(['gate 1 0 1 1'], 'c4 e4 g4 c5'), 8);
    expect(frames.map(gate)).toEqual([1, 0, 1, 1, 1, 0, 1, 1]);
  });

  it('closes the gate in the last N frames before the next note and writes the clauses', () => {
    const frames = registerFrames(song(['gate 1 0 1 1', 'hardRestart 1 ad 0 0 sr 0 0 test'], 'c4 e4 g4 c5'), 8);
    expect(frames.map(gate)).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
    // the table's own frames keep the instrument's envelope; the window writes the clauses
    expect([ad(frames[2]), sr(frames[2]), test(frames[2])]).toEqual([0x12, 0x34, 0]);
    expect([ad(frames[3]), sr(frames[3]), test(frames[3])]).toEqual([0x00, 0x00, 1]);
    expect([ad(frames[4]), sr(frames[4]), test(frames[4])]).toEqual([0x12, 0x34, 0]);
  });

  it('a two-frame window covers both frames', () => {
    const frames = registerFrames(song(['gate 1!4', 'hardRestart 2 ad 0 0 sr 0 0'], 'c4 e4 g4 c5'), 8);
    expect(frames.map(gate)).toEqual([1, 1, 0, 0, 1, 1, 0, 0]);
    expect(frames.map(sr)).toEqual([0x34, 0x34, 0x00, 0x00, 0x34, 0x34, 0x00, 0x00]);
  });

  it('a tie holds the note: no restart until the note after it', () => {
    const frames = registerFrames(song(['gate 1!4', 'hardRestart 1 sr 0 0'], 'c4 _ e4 g4'), 12);
    expect(frames.map(gate)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0]);
  });

  it('no restart into a legato transition', () => {
    const frames = registerFrames(song(['gate 1!4', 'hardRestart 1 sr 0 0'], 'c4 slideTo:e4 g4 c5'), 8);
    expect(gate(frames[3])).toBe(1);
    expect(sr(frames[3])).toBe(0x34);
  });

  it('before a rest the gate closes but the clauses are not written', () => {
    const frames = registerFrames(song(['gate 1!4', 'hardRestart 1 sr 0 0'], 'c4 ~ e4 g4'), 4);
    expect(gate(frames[3])).toBe(0);
    expect(sr(frames[3])).toBe(0x34);
  });

  it('with beforeNotes the table runs on into a rest', () => {
    const frames = registerFrames(song(['gate 1!4', 'hardRestart 1 sr 0 0 beforeNotes'], 'c4 ~ e4 g4'), 4);
    expect(frames.map(gate)).toEqual([1, 1, 1, 1]);
  });

  it('the last note of the pattern restarts into the first one of the next bar', () => {
    const frames = registerFrames(song(['gate 1!4', 'hardRestart 1 sr 0 0'], 'c4 e4 g4 c5'), 17);
    expect(gate(frames[15])).toBe(0);
    expect(sr(frames[15])).toBe(0x00);
    expect(gate(frames[16])).toBe(1);
  });

  it('the order of the two fields does not matter, and gate -N is the same spelling', () => {
    const a = registerFrames(song(['gate 1 0 1 1', 'hardRestart 1 ad 0 0'], 'c4 e4 g4'), 16);
    const b = registerFrames(song(['hardRestart 1 ad 0 0', 'gate 1 0 1 1'], 'c4 e4 g4'), 16);
    const c = registerFrames(song(['gate 1 0 1 1', 'gate -1'], 'c4 e4 g4'), 16);
    const d = registerFrames(song(['gate 1 0 1 1', 'hardRestart 1'], 'c4 e4 g4'), 16);
    expect(b).toEqual(a);
    expect(c).toEqual(d);
  });

  it('other gate pairs are still errors', () => {
    expect(() => compileDslV2Source(song(['gate 1 0 1 1', 'gate 0.5'], 'c4'))).toThrow(/only a gate table plus 'hardRestart N' combine/);
    expect(() => compileDslV2Source(song(['gate 1 0', 'gate 1 1 0'], 'c4'))).toThrow(/already has a 'gate'/);
    expect(() => compileDslV2Source(song(['gate legato', 'hardRestart 2'], 'c4'))).toThrow(/already has a 'gate'/);
    expect(() => compileDslV2Source(song(['gate 1 0', 'hardRestart 1', 'hardRestart 2'], 'c4'))).toThrow(/already has a 'gate'/);
  });
});

// DSL 4.7.0: `afterRests` opens the restart window at the end of a rest
// before a note too; `presetRelease` puts the release rate into the decay
// nibble for the 2 frames before the gate closes (the SID's rate counter
// then wraps while the envelope holds, so the release starts on time).
describe('hardRestart afterRests and presetRelease', () => {
  it('afterRests writes the clauses in the last N frames of a rest before a note', () => {
    const plain = registerFrames(song(['gate 1!4', 'hardRestart 1 ad 0 0 sr 0 0'], 'c4 ~ e4 g4'), 8);
    const after = registerFrames(song(['gate 1!4', 'hardRestart 1 ad 0 0 sr 0 0 afterRests'], 'c4 ~ e4 g4'), 8);
    expect(plain.map(sr)).toEqual([0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34]);
    expect(after.map(sr)).toEqual([0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x00]);
    expect(after.map(ad)).toEqual([0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x12, 0x00]);
    expect(after.map(gate)).toEqual(plain.map(gate));
  });

  it('afterRests also works without a gate table and with a longer window', () => {
    const frames = registerFrames(song(['hardRestart 2 sr 0 0 afterRests'], 'c4 ~ ~ e4'), 13);
    expect(frames.map(sr)).toEqual([0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x34, 0x00, 0x00, 0x34]);
  });

  // decay 9, release 4: a release faster than the decay, where the delay bug bites
  const fastRelease = (fields, notes) => song(fields, notes).replace('adsr 1 2 3 4', 'adsr 1 9 3 4');
  it('presetRelease writes the release rate as decay in the 2 frames before the gate closes', () => {
    const frames = registerFrames(fastRelease(['hardRestart 1 presetRelease'], 'c4 _ e4 ~'), 16);
    // c4 is held 8 frames, its gate closes on frame 7 (hardRestart 1)
    expect(frames.map(ad).slice(0, 8)).toEqual([0x19, 0x19, 0x19, 0x19, 0x19, 0x14, 0x14, 0x19]);
    // e4 runs into a rest: without beforeNotes its gate closes on frame 11
    expect(frames.map(ad).slice(8, 16)).toEqual([0x19, 0x14, 0x14, 0x19, 0x19, 0x19, 0x19, 0x19]);
    expect(frames.map(gate)).toEqual([1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it('presetRelease with beforeNotes: the gate closes when the rest begins', () => {
    const frames = registerFrames(fastRelease(['hardRestart 1 presetRelease beforeNotes'], 'c4 ~ e4 g4'), 4);
    expect(frames.map(ad)).toEqual([0x19, 0x19, 0x14, 0x14]);
  });

  it('presetRelease follows a gate table closing the gate mid-note', () => {
    const frames = registerFrames(fastRelease(['gate 1!3 0', 'hardRestart 1 presetRelease'], 'c4 e4 g4 c5'), 4);
    expect(frames.map(ad)).toEqual([0x19, 0x14, 0x14, 0x19]);
  });

  it('presetRelease leaves a release slower than the decay alone', () => {
    const frames = registerFrames(song(['hardRestart 1 presetRelease'], 'c4 e4 g4 c5'), 8);
    expect(frames.every((f) => ad(f) === 0x12)).toBe(true);
  });

  it('existing songs without the clauses compile as before', () => {
    const a = registerFrames(song(['gate 1 0 1 1', 'hardRestart 1 ad 0 0'], 'c4 ~ g4 c5'), 16);
    const b = registerFrames(song(['hardRestart 1 ad 0 0', 'gate 1 0 1 1'], 'c4 ~ g4 c5'), 16);
    expect(a).toEqual(b);
  });

  it('rejects a repeated or unknown clause', () => {
    expect(() => compileDslV2Source(song(['hardRestart 1 afterRests afterRests'], 'c4'))).toThrow(/'afterRests' twice/);
    expect(() => compileDslV2Source(song(['hardRestart 1 afterNotes'], 'c4'))).toThrow(/'afterRests' and 'presetRelease'/);
  });
});

describe('presetRelease and a pulsing gate table', () => {
  it('leaves a gate that opens again within the note alone', () => {
    // decay 9, release 0; the table pulses the gate open again after it closes
    const src = song(['gate 1 1 0 1 1 0', 'hardRestart 1 presetRelease'], 'c4 e4').replace('adsr 1 2 3 4', 'adsr 0 9 8 0');
    const frames = registerFrames(src, 8);
    expect(frames.map(gate)).toEqual([1, 1, 0, 1, 1, 0, 1, 0]);
    // frames 3-4 close at 5 but the gate opens again at 6; the restart at 7
    // follows a single open frame
    expect(frames.every((f) => ad(f) === 0x09)).toBe(true);
  });

  it('leaves a note alone once its gate table has closed and reopened the gate', () => {
    const src = song(['gate 1 0 1', 'loop gate 2', 'hardRestart 1 presetRelease'], 'c4 e4').replace('adsr 1 2 3 4', 'adsr 0 9 8 0');
    const frames = registerFrames(src, 8);
    expect(frames.map(gate)).toEqual([1, 0, 1, 1, 1, 1, 1, 0]);
    expect(frames.every((f) => ad(f) === 0x09)).toBe(true);
  });
});

describe('4.7.0 restarts land on the frames a note really gets', () => {
  // 6/8 at speed 8: twelve 4-frame steps per bar, where floating-point step
  // boundaries can start a note a frame late; the restart must still come in
  // the frame before every following note.
  it('restarts before every note of a 6/8 bar', () => {
    const src = `speed 8 meter 6/8
instrument hat
  wave noise
  adsr 0 0 7 4
  gate 1!2 0
  hardRestart 1 ad 0 0 sr 0 0 afterRests presetRelease
end
voice 0 hat "c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4 c4"
`;
    const frames = registerFrames(src, 48 * 4 + 1);
    let onsets = 0;
    for (let i = 1; i < frames.length; i += 1) {
      if (!(gate(frames[i]) && !gate(frames[i - 1]))) continue;
      onsets += 1;
      expect([i, sr(frames[i - 1])]).toEqual([i, 0]);
    }
    expect(onsets).toBe(48);
  });
});
