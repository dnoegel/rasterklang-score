// ADR 0002's compile-level verification: a song's `target { ... }` block
// changes the DRIVE rate (CPU cycles per play call) and nothing else.
//
// Two separable claims, tested separately because they fail in different
// ways:
//   1. The declared rate reaches the compiled song and the renderers, in
//      cycles and in Hz. This is what makes an NTSC/multispeed/CIA-tempo
//      tune play at the right SPEED, since render-pokes' samples-per-frame
//      and liveEngine's pump cadence are both derived from it.
//   2. The FRAME grid itself is untouched by it: `speed N` is frames per
//      beat and stays exactly N frames per beat at any drive rate, so a
//      decompiled tune's note positions do not move when the rate changes.
//      (`tempo N` is BPM, i.e. wall-clock, so that one DOES rescale - which
//      is the correct behaviour and is asserted below too.)
import { describe, expect, it } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile, driveRateOf, framesForCycles } from '../../src/compiler/compile.js';
import { samplesPerFrameFor } from '../../src/engine/liveEngine.js';

const VOICE0_CONTROL = 0x04;

// gateOnsetFrames(source, frames) -> the frame indices at which voice 0's
// gate bit goes 0 -> 1, i.e. where notes actually start. Register-level, per
// ADR 0001 section 8's rule about aggregate metrics.
function gateOnsetFrames(source, frames) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  const onsets = [];
  let prevGate = 0;
  for (let f = 0; f < frames; f += 1) {
    for (const { addr, value } of frameSource(f)) regs[addr] = value;
    const gate = regs[VOICE0_CONTROL] & 0x01;
    if (gate === 1 && prevGate === 0) onsets.push(f);
    prevGate = gate;
  }
  return onsets;
}

const SONG = (targetLine, clock = 'speed 12 beats 8') =>
  `${targetLine}\n${clock}\npattern riff 8 = "c4 ~ ~ ~ e4 ~ ~ ~"\nvoice 0 $riff wave:pulse\n`;

describe('ADR 0002: declared drive rate', () => {
  it('defaults to PAL 19705 cycles = 50.00 fps when no target block is present', () => {
    const song = compileDslV2Source(SONG('; no target block'));
    expect(song.driveCycles).toBe(19705);
    expect(song.cpuClockHz).toBe(985248);
    // 985248/50 is 19704.96, so the integer cycle count is 19705 and the
    // rate it implies is 49.99990 fps rather than a mathematically exact
    // 50 - a 2e-5 relative difference that cannot move a rounded frame
    // count on any real tempo, and the renderer cadence below is still the
    // identical integer it was before ADR 0002.
    expect(driveRateOf(song).framesPerSecond).toBeCloseTo(50, 3);
    // The pre-ADR-0002 renderer constant, reproduced exactly.
    expect(samplesPerFrameFor(44100, driveRateOf(song).framesPerSecond)).toBe(882);
  });

  it('`target { video PAL }` is identical to declaring nothing', () => {
    const declared = compileDslV2Source(SONG('target { video PAL }'));
    const implied = compileDslV2Source(SONG('; no target block'));
    expect(driveRateOf(declared)).toEqual(driveRateOf(implied));
  });

  it('`target { video NTSC }` gives 17045 cycles at the NTSC clock, ~60 fps', () => {
    const song = compileDslV2Source(SONG('target { video NTSC }'));
    expect(song.driveCycles).toBe(17045);
    expect(song.cpuClockHz).toBe(1022727);
    expect(driveRateOf(song).framesPerSecond).toBeCloseTo(60.0016, 3);
    // 44100/60.0016 = 735.0, against PAL's 882: without this an NTSC tune
    // plays at 0.833x speed.
    expect(samplesPerFrameFor(44100, driveRateOf(song).framesPerSecond)).toBe(735);
  });

  it('`multispeed N` divides the video frame into N play calls', () => {
    for (const [n, cycles] of [[2, 9853], [3, 6568], [4, 4926]]) {
      const song = compileDslV2Source(SONG(`target { video PAL multispeed ${n} }`));
      expect(song.driveCycles).toBe(cycles);
      expect(driveRateOf(song).framesPerSecond).toBeCloseTo(50 * n, 0);
    }
  });

  it('`driveCycles N` takes an exact CIA-driven rate with no video relationship', () => {
    // An arbitrary CIA-timer play rate (about 77 calls per second).
    const song = compileDslV2Source(SONG('target { driveCycles 12801 }'));
    expect(song.driveCycles).toBe(12801);
    expect(driveRateOf(song).framesPerSecond).toBeCloseTo(76.97, 2);
  });

  it('leaves the FRAME grid alone: `speed 12 beats 8` is 12 frames per beat at any drive rate', () => {
    // The note grid is what a decompiled tune's `reg`/note data is indexed
    // by, so if this moved, changing the drive rate would desynchronise the
    // very files ADR 0002 exists to fix.
    const cases = ['; none', 'target { video NTSC }', 'target { driveCycles 12801 }', 'target { video PAL multispeed 3 }'];
    for (const targetLine of cases) {
      const source = SONG(targetLine);
      expect(gateOnsetFrames(source, 200), targetLine).toEqual([0, 48, 96, 144, 192]);
      expect(framesForCycles(compileDslV2Source(source), 2), targetLine).toBe(192);
    }
  });

  it('rescales the frame grid for `tempo N`, because BPM is wall-clock', () => {
    // 120 BPM, 8 beats per bar = 4 seconds per bar however fast the player
    // is called; the bar is that many FRAMES.
    const bar = (targetLine) => framesForCycles(compileDslV2Source(
      `${targetLine}\ntempo 120 beats 8\nvoice 0 "c4 e4"\n`,
    ), 1);
    expect(bar('; none')).toBe(200); // 4s at 50.00 fps
    expect(bar('target { video NTSC }')).toBe(240); // 4s at 59.9987 fps
    expect(bar('target { video PAL multispeed 3 }')).toBe(600); // 4s at 150 fps
  });

  it('rejects driveCycles and multispeed together', () => {
    expect(() => compileDslV2Source(SONG('target { driveCycles 6568 multispeed 3 }')))
      .toThrow(/two spellings of the same thing/);
  });

  it('rejects a second target block', () => {
    expect(() => compileDslV2Source(`target { video PAL }\ntarget { video NTSC }\ntempo 120 beats 4\nvoice 0 "c4"\n`))
      .toThrow(/at most one target block/);
  });
});
