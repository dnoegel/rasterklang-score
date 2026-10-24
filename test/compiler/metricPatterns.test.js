// ADR 0001's compile-level verification: metric patterns, polymetric
// phasing, the hold token, the frame-native clock, and the weighted-rest
// gate question from the ADR's "known defects" list.
//
// Everything here is proven at the REGISTER level, frame by frame, not by
// inspecting Haps or aggregate scores - ADR 0001 section 8 is explicit
// about why ("this project has repeatedly been misled by aggregate
// metrics"). So each helper below compiles a real song and reads the SID
// registers a once-per-frame observer would actually see.
import { describe, expect, it } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { barsForFullPeriod, compile } from '../../src/compiler/compile.js';

// `speed 12 beats 8` is exactly 12 frames per beat and exactly 96 frames
// per bar, which is the same clock ADR 0001's own measurements use ("one
// 96-frame bar of 8 beats"). Using `speed` rather than a BPM keeps every
// number in these tests exact instead of rounded, which is the point of
// D4 in the first place.
const FRAMES_PER_BEAT = 12;

// registersOverTime(source, frames) -> the register file as it stands at
// the end of each frame, i.e. what a .sid dump or a real player loop sees.
function registersOverTime(source, frames) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  const out = [];
  for (let i = 0; i < frames; i += 1) {
    for (const { addr, value } of frameSource(i)) regs[addr] = value;
    out.push([...regs]);
  }
  return out;
}

// pitchChanges(source, frames, voice) -> [{ frame, freq }] at every frame
// where this voice's 16-bit frequency register pair changed - the note
// onsets of a legato line, which gate edges cannot show.
function pitchChanges(source, frames, voice = 0) {
  const base = voice * 7;
  const out = [];
  let previous = null;
  registersOverTime(source, frames).forEach((regs, frame) => {
    const freq = regs[base] | (regs[base + 1] << 8);
    if (freq !== previous) out.push({ frame, freq });
    previous = freq;
  });
  return out;
}

// gateBits(source, frames, voice) -> the gate bit at each frame, as a
// string of 0/1 so an assertion can read like the tracker column it is.
function gateBits(source, frames, voice = 0) {
  const base = voice * 7 + 4;
  return registersOverTime(source, frames)
    .map((regs) => (regs[base] & 0x01 ? '1' : '0'))
    .join('');
}

function gateOnFrames(source, frames, voice = 0) {
  return [...gateBits(source, frames, voice)].filter((c) => c === '1').length;
}

// A 32-token, 32-beat melody: eight ascending notes repeated four times.
// Written by generator rather than by hand so the declared length and the
// token count cannot drift apart in the test itself.
const OCTAVE = ['c4', 'd4', 'e4', 'f4', 'g4', 'a4', 'b4', 'c5'];
const THIRTY_TWO_BEATS = Array.from({ length: 32 }, (_, i) => OCTAVE[i % 8]).join(' ');

describe('metric patterns: declared length is the beat grid (ADR 0001 D1)', () => {
  // (a) in ADR section 4.2's test list. The whole complaint in section 1.1
  // was that four tokens got stretched to 1.93 beats each at `beats 8`.
  // With a declared length they are one beat each, whatever `beats` says.
  it('puts a 4-beat pattern\'s notes exactly one beat apart, whatever the bar length', () => {
    for (const barBeats of [4, 8, 16]) {
      const source = `speed ${FRAMES_PER_BEAT} beats ${barBeats}\npattern lead 4 = "c4 d4 e4 f4"\nvoice 0 $lead\n`;
      const changes = pitchChanges(source, FRAMES_PER_BEAT * 8);
      expect(changes.map((c) => c.frame)).toEqual([0, 12, 24, 36, 48, 60, 72, 84]);
    }
  });

  // ADR 0001 decision 3: a pattern shorter than a bar loops at its OWN
  // length, exactly like a GoatTracker orderlist entry shorter than the
  // arrangement. Proven by the pitch sequence repeating twice inside one
  // 8-beat bar rather than once.
  it('loops a 4-beat pattern twice inside an 8-beat bar', () => {
    const source = `speed ${FRAMES_PER_BEAT} beats 8\npattern lead 4 = "c4 d4 e4 f4"\nvoice 0 $lead\n`;
    const freqs = pitchChanges(source, FRAMES_PER_BEAT * 8).map((c) => c.freq);
    expect(freqs.slice(0, 4)).toEqual(freqs.slice(4, 8));
  });

  // The pre-3.0.0 reading, restated: no declared length means the string
  // still fills exactly one bar, so `beats` still decides how long each
  // token is. This is the compatibility promise in ADR section 5, and it
  // is the behaviour the declared-length case above must NOT have taken
  // away.
  it('leaves an undeclared (proportional) pattern filling exactly one bar', () => {
    const source = `speed ${FRAMES_PER_BEAT} beats 8\npattern lead = "c4 d4 e4 f4"\nvoice 0 $lead\n`;
    const changes = pitchChanges(source, FRAMES_PER_BEAT * 8);
    // Four tokens over an 8-beat bar: two beats (24 frames) each.
    expect(changes.map((c) => c.frame)).toEqual([0, 24, 48, 72]);
  });

  // `beats` losing its effect on pattern length is the one real semantic
  // break in 3.0.0 (ADR section 5), so pin it: changing the time signature
  // must not move a metric pattern's notes at all.
  it('makes `beats` a pure time signature for a metric pattern', () => {
    const at = (barBeats) => pitchChanges(
      `speed ${FRAMES_PER_BEAT} beats ${barBeats}\npattern lead 8 = "${OCTAVE.join(' ')}"\nvoice 0 $lead\n`,
      FRAMES_PER_BEAT * 8,
    );
    expect(at(4)).toEqual(at(8));
    expect(at(4)).toEqual(at(16));
  });
});

describe('metric patterns: polymetre phases and realigns at the LCM (ADR 0001 D5)', () => {
  // (b) in ADR section 4.2's test list, and the ADR's own worked example:
  // "bass 4 beats, lead 32 beats, hats 3 beats -> full period 96 beats
  // (12 bars)" at `beats 8`.
  const POLYMETRE = [
    `speed ${FRAMES_PER_BEAT} beats 8`,
    'pattern bass 4 = "c2 d2 e2 f2"',
    `pattern lead 32 = "${THIRTY_TWO_BEATS}"`,
    'pattern hats 3 = "c6 d6 e6"',
    'voice 0 $bass',
    'voice 1 $lead',
    'voice 2 $hats',
    '',
  ].join('\n');

  it('gives each voice its own declared period', () => {
    const frames = FRAMES_PER_BEAT * 96;
    const bass = pitchChanges(POLYMETRE, frames, 0).map((c) => c.frame);
    const lead = pitchChanges(POLYMETRE, frames, 1).map((c) => c.frame);
    const hats = pitchChanges(POLYMETRE, frames, 2).map((c) => c.frame);
    // A period is "how long until the sequence of pitches repeats", read
    // straight off the onset frames: 4, 32 and 3 beats respectively.
    expect(bass[4] - bass[0]).toBe(4 * FRAMES_PER_BEAT);
    expect(lead[32] - lead[0]).toBe(32 * FRAMES_PER_BEAT);
    expect(hats[3] - hats[0]).toBe(3 * FRAMES_PER_BEAT);
  });

  it('realigns all three voices at beat 96 and not before', () => {
    const frames = FRAMES_PER_BEAT * 97;
    const onsetBeats = (voice) => new Set(pitchChanges(POLYMETRE, frames, voice).map((c) => c.frame / FRAMES_PER_BEAT));
    const bass = onsetBeats(0);
    const lead = onsetBeats(1);
    const hats = onsetBeats(2);
    // lcm(4, 32, 3) = 96 beats = 12 bars of 8. Every voice starts a fresh
    // pass there, and 96 is the FIRST beat after 0 where all three do.
    const together = [...Array(97).keys()].filter((b) => bass.has(b) && lead.has(b) && hats.has(b) && b % 4 === 0 && b % 32 === 0 && b % 3 === 0);
    expect(together).toEqual([0, 96]);
  });

  it('reports the arrangement period the composer actually wants', () => {
    const song = compileDslV2Source(POLYMETRE);
    expect(song.dslPeriodBeats).toBe(96);
    const report = song.dslDiagnostics.find((d) => d.message.startsWith('Arrangement:'));
    expect(report.severity).toBe('info');
    expect(report.message).toContain('Full period: 96 beats (12 bars)');
  });
});

describe('the hold token rings, a rest releases (ADR 0001 D6)', () => {
  // (c) in ADR section 4.2's test list. The distinction the token exists
  // for: padding with `~` CUTS the note, which is why the importer had to
  // spell sustain as weights; padding with `_` sustains it.
  const clock = `speed ${FRAMES_PER_BEAT} beats 8\n`;

  it('keeps the gate open across a hold and closes it on a rest', () => {
    const held = `${clock}voice 0 "c4 _ _ _ _ _ _ _"\n`;
    const rested = `${clock}voice 0 "c4 ~ ~ ~ ~ ~ ~ ~"\n`;
    expect(gateOnFrames(held, 96)).toBe(96);
    expect(gateOnFrames(rested, 96)).toBe(12);
  });

  it('releases where the holds stop', () => {
    // "ring four beats, then release for four" - the tracker column the
    // ADR's D6 spells out.
    const source = `${clock}voice 0 "c4 _ _ _ ~ ~ ~ ~"\n`;
    expect(gateBits(source, 96)).toBe('1'.repeat(48) + '0'.repeat(48));
  });

  it('makes a hold-expanded note indistinguishable from the weight it stands for', () => {
    // The hold is folded into a weight before the pattern engine sees it
    // (rasterklang-dsl's miniLength.js), so these two spellings must
    // compile to byte-identical register streams, not merely similar ones.
    const held = registersOverTime(`${clock}voice 0 "c4 _ _ _ ~@4"\n`, 96);
    const weighted = registersOverTime(`${clock}voice 0 "c4@4 ~@4"\n`, 96);
    expect(held).toEqual(weighted);
  });

  it('holds a rest too, so a release can be lengthened without weights', () => {
    expect(registersOverTime(`${clock}voice 0 "c4 _ ~ _"\n`, 96)).toEqual(
      registersOverTime(`${clock}voice 0 "c4@2 ~@2"\n`, 96),
    );
  });
});

describe('a weighted rest closes the gate for its own span (ADR 0001 known defect 1)', () => {
  // The ADR reports `"c4@4 ~@4"` measuring gate-on for 96/96 frames while
  // `"c4 ~!7"` measured 24/96, and concludes weighted rests do not close
  // the gate. Measured again here on an exactly-96-frame bar, they do:
  // the original measurement compared two DIFFERENT windows (24 frames is
  // one token of a 192-frame bar, and `c4@4` fills the first 96 frames of
  // that same 192-frame bar exactly), so the ratio 96/96 was a full gate
  // over half a bar, not a stuck gate.
  //
  // These tests pin the behaviour the ADR asks for either way, so the
  // defect cannot appear for real later without failing here.
  const clock = `speed ${FRAMES_PER_BEAT} beats 8\n`;

  it('closes the gate for a weighted rest, exactly as for plain rests', () => {
    expect(gateBits(`${clock}voice 0 "c4@4 ~@4"\n`, 96)).toBe('1'.repeat(48) + '0'.repeat(48));
    expect(gateBits(`${clock}voice 0 "c4@4 ~ ~ ~ ~"\n`, 96)).toBe('1'.repeat(48) + '0'.repeat(48));
    expect(gateBits(`${clock}voice 0 "c4 ~!7"\n`, 96)).toBe('1'.repeat(12) + '0'.repeat(84));
  });

  it('does not depend on the rest\'s weight, only on its span', () => {
    expect(gateOnFrames(`${clock}voice 0 "c4@7 ~@1"\n`, 96)).toBe(84);
    expect(gateOnFrames(`${clock}voice 0 "c4@1 ~@7"\n`, 96)).toBe(12);
    expect(gateOnFrames(`${clock}voice 0 "c4@2 ~@2 c4@2 ~@2"\n`, 96)).toBe(48);
  });

  it('leaves `gate FRACTION` and `gate -N` working next to a weighted rest', () => {
    // The ADR warns that the gate logic here is non-trivial and must not
    // regress. `gate 0.5` halves the NOTE's own span (24 of its 48
    // frames); `gate -6` drops the last 6 frames of it (42 of 48). The
    // weighted rest that follows contributes nothing either way.
    const withGate = (spec) => `${clock}instrument p\n  wave pulse\n  gate ${spec}\nend\nvoice 0 p "c4@4 ~@4"\n`;
    expect(gateBits(withGate('0.5'), 96)).toBe('1'.repeat(24) + '0'.repeat(72));
    expect(gateBits(withGate('-6'), 96)).toBe('1'.repeat(42) + '0'.repeat(54));
  });
});

describe('`speed N` is exactly N frames per beat (ADR 0001 D4)', () => {
  // (d) in ADR section 4.2's test list. `tempo` is musical and rounds;
  // `speed` is frame-native and does not, which is what removes a whole
  // class of timing error from the GoatTracker import path.
  it('gives exactly N frames per beat for every N, with no rounding', () => {
    for (const n of [1, 6, 7, 11, 12, 13, 50]) {
      const source = `speed ${n} beats 8\npattern p 4 = "c4 d4 e4 f4"\nvoice 0 $p\n`;
      const changes = pitchChanges(source, n * 8);
      expect(changes.map((c) => c.frame)).toEqual([0, n, n * 2, n * 3, n * 4, n * 5, n * 6, n * 7]);
    }
  });

  it('rounds under `tempo`, which is exactly what `speed` exists to avoid', () => {
    // 3000/132*8 = 181.81... frames per bar, so `tempo 132 beats 8` has to
    // land on a whole 182 and every beat inside it inherits the error.
    const rounded = pitchChanges('tempo 132 beats 8\npattern p 8 = "c4 d4 e4 f4 g4 a4 b4 c5"\nvoice 0 $p\n', 182);
    const beatFrames = rounded.map((c) => c.frame);
    expect(beatFrames[0]).toBe(0);
    // 182/8 = 22.75 frames per beat: the onsets cannot all be evenly
    // spaced, which is the rounding this test exists to name.
    const gaps = new Set(beatFrames.slice(1).map((f, i) => f - beatFrames[i]));
    expect(gaps.size).toBeGreaterThan(1);

    // The same tempo spelled frame-natively divides evenly and has one gap.
    const exact = pitchChanges('speed 23 beats 8\npattern p 8 = "c4 d4 e4 f4 g4 a4 b4 c5"\nvoice 0 $p\n', 23 * 8);
    const exactFrames = exact.map((c) => c.frame);
    expect(new Set(exactFrames.slice(1).map((f, i) => f - exactFrames[i]))).toEqual(new Set([23]));
  });

  it('agrees with `tempo` wherever the BPM happens to be exact', () => {
    // speed 24 = 3000/24 = 125 BPM, a round number, so the two spellings
    // must compile to the identical register stream.
    const bySpeed = registersOverTime('speed 24 beats 8\nvoice 0 "c4 d4 e4 f4"\n', 192);
    const byTempo = registersOverTime('tempo 125 beats 8\nvoice 0 "c4 d4 e4 f4"\n', 192);
    expect(bySpeed).toEqual(byTempo);
  });
});

describe('barsForFullPeriod: how long the piece actually is (ADR 0001 D5)', () => {
  const barsFor = (source) => barsForFullPeriod(compileDslV2Source(source));

  it('answers the ADR\'s own worked example: 12 bars', () => {
    expect(barsFor([
      'speed 12 beats 8',
      'pattern bass 4 = "c2 d2 e2 f2"',
      `pattern lead 32 = "${THIRTY_TWO_BEATS}"`,
      'pattern hats 3 = "c6 d6 e6"',
      'voice 0 $bass',
      'voice 1 $lead',
      'voice 2 $hats',
      '',
    ].join('\n'))).toBe(12);
  });

  it('is one bar for an ordinary proportional song', () => {
    expect(barsFor('speed 12 beats 4\nvoice 0 "c4 d4 e4 f4"\nvoice 1 "c2 ~ g2 ~"\n')).toBe(1);
  });

  it('rounds a sub-bar period up to where it realigns with the bar grid', () => {
    // A 3-beat pattern in a 4-beat bar is back on a bar line after 3 bars,
    // not after 0.75 of one.
    expect(barsFor('speed 12 beats 4\npattern hats 3 = "c6 d6 e6"\nvoice 0 $hats\n')).toBe(3);
  });

  it('returns null for a song that cannot say', () => {
    expect(barsForFullPeriod(null)).toBeNull();
    expect(barsForFullPeriod({ beatsPerCycle: 4 })).toBeNull();
  });
});

describe('transforms count bars, not pattern repetitions (ADR 0001 D3)', () => {
  it('fires `every N` on the global bar clock even for a shorter metric pattern', () => {
    // A 4-beat pattern in an 8-beat bar repeats twice per bar. `every 2
    // rev` must still alternate per BAR (so both repeats inside a bar are
    // reversed together), not per repetition.
    const source = `speed ${FRAMES_PER_BEAT} beats 8\npattern lead 4 = "c4 d4 e4 f4"\nvoice 0 $lead |> every 2 rev\n`;
    // Sampled at each beat's midpoint rather than off change edges: two
    // adjacent bars can start on the same pitch, in which case there is no
    // register write to see and a change-edge list silently loses a beat.
    const regs = registersOverTime(source, 96 * 3);
    const beatPitch = (beat) => {
      const row = regs[beat * FRAMES_PER_BEAT + Math.floor(FRAMES_PER_BEAT / 2)];
      return row[0] | (row[1] << 8);
    };
    const bar = (index) => Array.from({ length: 8 }, (_, i) => beatPitch(index * 8 + i));
    // Both passes inside bar 0 are reversed relative to bar 1's passes,
    // and bar 2 is back in phase with bar 0 - `every 2` on the bar clock.
    expect(bar(0).slice(0, 4)).toEqual(bar(0).slice(4, 8));
    expect(bar(0).slice(0, 4)).toEqual([...bar(1).slice(0, 4)].reverse());
    expect(bar(2)).toEqual(bar(0));
  });
});
