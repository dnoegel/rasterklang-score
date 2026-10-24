// DSL v2 2.15.0's two new expressiveness features, verified at the level
// that actually matters: the REGISTER WRITES compile() emits, not merely
// that the new syntax parses (the conformance suite already covers parsing,
// in both languages).
//
// Both features exist because the GoatTracker importer was measurably
// losing musical content to them - one-shot per-row commands had no DSL
// spelling at all, and `arp` could only ever say "N semitones from the
// played note", never "this fixed pitch". So each test here pins the exact
// behavior that loss was about: the same song WITH and WITHOUT the new
// construct must produce genuinely different bytes, in the specific
// direction gplay.c (GoatTracker 2's own player) defines.
import { describe, it, expect } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from '../../src/compiler/compile.js';

// runFrames(source, n) -> a per-frame shadow copy of all 32 registers,
// built by applying each frame's pokes in order (exactly how a real player
// consumes frameSource), plus the raw poke list per frame for the cases
// that care about writes rather than resulting state.
function runFrames(source, n) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  const states = [];
  const pokes = [];
  for (let i = 0; i < n; i += 1) {
    const p = frameSource(i);
    pokes.push(p);
    for (const { addr, value } of p) regs[addr] = value;
    states.push(regs.slice());
  }
  return { states, pokes };
}

const voiceFreq = (state, v) => state[v * 7] | (state[v * 7 + 1] << 8);

describe('fx: per-row effect commands produce real register writes', () => {
  const NOTES = 'tempo 120 beats 4\nvoice 0 "c4 c4 c4 c4"';

  it('pup/pdn walk the frequency register per frame, which a plain note never does', () => {
    const plain = runFrames(`${NOTES}\n`, 40).states;
    const up = runFrames(`${NOTES} fx:"pup.200 ~ ~ ~"\n`, 40).states;
    const down = runFrames(`${NOTES} fx:"pdn.200 ~ ~ ~"\n`, 40).states;

    // A plain held note's frequency is constant; that is the baseline the
    // whole feature is defined against.
    expect(voiceFreq(plain[5], 0)).toBe(voiceFreq(plain[15], 0));

    // Portamento up adds a fixed delta EVERY frame (gplay.c's
    // `cptr->freq += speed` in TICKNEFFECTS), so consecutive frames differ
    // by exactly the commanded amount and the direction is strictly one-way.
    expect(voiceFreq(up[6], 0) - voiceFreq(up[5], 0)).toBe(200);
    expect(voiceFreq(up[15], 0)).toBeGreaterThan(voiceFreq(up[5], 0));
    expect(voiceFreq(down[6], 0) - voiceFreq(down[5], 0)).toBe(-200);
    expect(voiceFreq(down[15], 0)).toBeLessThan(voiceFreq(down[5], 0));
  });

  it('tp glides toward the new note AND suppresses its gate retrigger (legato)', () => {
    const src = 'tempo 120 beats 4\nvoice 0 "c4 g4"';
    const plain = runFrames(`${src}\n`, 60);
    const tp = runFrames(`${src} fx:"~ tp.50"\n`, 60);

    // framesPerCycle is 100 here, so the second note's onset is frame 50.
    const controlWritesAt = (run, frame) => run.pokes[frame].filter((p) => p.addr === 4);

    // Without the command, a new note forces the gate-off/gate-on pair the
    // SID envelope needs to restart. Under tone portamento gplay.c skips
    // the whole new-note init block, so there must be NO control write at
    // all - the note is legato, one continuous sound.
    expect(controlWritesAt(plain, 50).length).toBeGreaterThan(0);
    expect(controlWritesAt(tp, 50)).toHaveLength(0);

    // And the pitch ramps toward the target instead of jumping to it.
    const target = voiceFreq(plain.states[55], 0);
    expect(voiceFreq(plain.states[51], 0)).toBe(target);
    expect(voiceFreq(tp.states[51], 0)).toBeLessThan(target);
    expect(voiceFreq(tp.states[51], 0)).toBeGreaterThan(voiceFreq(tp.states[50], 0));
    // Steps by exactly the commanded rate, and clamps on arrival rather
    // than overshooting past the target.
    expect(voiceFreq(tp.states[52], 0) - voiceFreq(tp.states[51], 0)).toBe(50);
    expect(voiceFreq(tp.states[59], 0)).toBeLessThanOrEqual(target);
  });

  it('vib wobbles the frequency both ways around the note, unlike a one-way portamento', () => {
    const { states } = runFrames(`${NOTES} fx:"vib.16.100 ~ ~ ~"\n`, 40);
    const base = voiceFreq(runFrames(`${NOTES}\n`, 40).states[10], 0);
    const seen = states.slice(2, 22).map((s) => voiceFreq(s, 0));
    // gplay.c's vibrato is a triangle: it must go both above and below the
    // un-modulated pitch, which is what distinguishes it from pup/pdn.
    expect(Math.max(...seen)).toBeGreaterThan(base);
    expect(Math.min(...seen)).toBeLessThan(base);
  });

  it('ad/sr overwrite the envelope registers, and a new note takes them back', () => {
    const plain = runFrames(`${NOTES}\n`, 80).states;
    const withFx = runFrames(`${NOTES} fx:"~ ad.0.10 ~ ~"\n`, 80).states;
    // Frame 30 is inside the second step, where `ad.0.10` is in effect.
    expect(withFx[30][5]).toBe((0 << 4) | 10);
    expect(withFx[30][5]).not.toBe(plain[30][5]);
    // ...and the third step's note onset restores the instrument's own AD,
    // exactly as gplay.c's new-note init rewrites sidreg from iptr->ad.
    expect(withFx[55][5]).toBe(plain[55][5]);
  });

  it('vol/fcut reach the shared filter registers', () => {
    const plain = runFrames(`${NOTES}\n`, 20).states;
    const withFx = runFrames(`${NOTES} fx:"vol.3 ~ ~ ~"\n`, 20).states;
    expect(withFx[10][0x18] & 0x0f).toBe(3);
    expect(plain[10][0x18] & 0x0f).not.toBe(3);
  });

  it('leaves a song with no fx pattern byte-for-byte unchanged', () => {
    // The whole fx runtime is gated on chain.effectPattern, so this is the
    // guarantee that every pre-2.15.0 song is untouched.
    const a = runFrames(`${NOTES}\n`, 60).pokes;
    const b = runFrames(`${NOTES}\n`, 60).pokes;
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe('arp: absolute-pitch table cells pin a frame to a fixed note', () => {
  const song = (arp) => `tempo 120 beats 4

instrument drum
  wave noise
  arp ${arp}
end

voice 0 drum "c4 ~ e4 ~"
`;

  it('=MIDI ignores the played note, while a relative cell follows it', () => {
    // Two notes a major third apart. A relative arp row transposes with
    // them; an absolute one must produce the SAME frequency for both.
    const rel = runFrames(song('0!8'), 60).states;
    const abs = runFrames(song('=36!8'), 60).states;

    const firstNote = 3;
    const secondNote = 53; // framesPerCycle 100, third step starts at 50

    expect(voiceFreq(rel[secondNote], 0)).not.toBe(voiceFreq(rel[firstNote], 0));
    expect(voiceFreq(abs[secondNote], 0)).toBe(voiceFreq(abs[firstNote], 0));
    // And it is genuinely a different pitch from the played note, not a
    // no-op that happened to compare equal.
    expect(voiceFreq(abs[firstNote], 0)).not.toBe(voiceFreq(rel[firstNote], 0));
  });

  it('mixes relative and absolute cells in one table, frame by frame', () => {
    // `0 =36 12 =36` - played note, fixed low C, an octave up, fixed low C.
    // Frames 0..3 of the note walk those four cells in order.
    const { states } = runFrames(song('0 =36 12 =36'), 20);
    const f = (i) => voiceFreq(states[i], 0);
    expect(f(1)).toBe(f(3)); // both absolute cells -> identical pitch
    expect(f(0)).not.toBe(f(1)); // played note vs the pinned one
    expect(f(2)).toBeGreaterThan(f(0)); // +12 semitones is a higher pitch
  });
});
