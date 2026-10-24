import { describe, expect, it } from 'vitest';
import { song, note } from '../../src/compiler/song.js';
import { compile, framesForCycles } from '../../src/compiler/compile.js';

describe('framesForCycles', () => {
  it('computes exact frames for a constant tempo (120 BPM, 4 beats/cycle -> 100 frames/cycle)', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4'));
    expect(framesForCycles(s, 1)).toBe(100);
    expect(framesForCycles(s, 4)).toBe(400);
  });

  it('scales linearly with beatsPerCycle and tempo', () => {
    const s = song(60, { beatsPerCycle: 8 }).voice(0, note('c4'));
    // FRAMES_PER_MINUTE_BASE (3000) / 60 * 8 = 400 frames/cycle
    expect(framesForCycles(s, 2)).toBe(800);
  });

  it('returns 0 for 0 cycles', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4'));
    expect(framesForCycles(s, 0)).toBe(0);
  });

  it('accounts for a nonzero startOffsetFrames lead-in', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4'));
    s.startOffsetFrames = 10;
    expect(framesForCycles(s, 1)).toBe(110);
  });

  it('re-derives framesPerCycle per cycle for a tempo pattern, not an average BPM guess', () => {
    // "<120 96>": cycle 0 at 120 BPM (100 frames/cycle), cycle 1 at 96 BPM (125 frames/cycle).
    const s = song('<120 96>', { beatsPerCycle: 4 }).voice(0, note('c4'));
    expect(framesForCycles(s, 1)).toBe(100);
    expect(framesForCycles(s, 2)).toBe(225);
  });

  it('matches the exact frame at which compile()\'s own frameSource reports cycleIndex reaching N', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 e4 g4 b4'));
    const frames = framesForCycles(s, 3);
    // compile.js's frameSource exposes cycleIndex via lastFrame - the frame
    // right before `frames` should still be in cycle 2, and `frames` itself
    // should already be cycle 3, confirming framesForCycles lines up exactly
    // with the compiler's own cycle boundaries (see compile.js header).
    const frameSource = compile(s);
    frameSource(frames - 1);
    expect(frameSource.lastFrame.cycleIndex).toBe(2);
    frameSource(frames);
    expect(frameSource.lastFrame.cycleIndex).toBe(3);
  });
});
