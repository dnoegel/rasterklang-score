// Parity test: the same instrument played (a) live via LiveVoice's
// noteOn()/step()/noteOff() and (b) sequenced via song()/compile() for an
// equivalent note event must produce identical poke streams (addresses,
// values, frame timing from onset). LiveVoice runs the real compiled
// frameSource (see liveAudition.js's header), so this guards LiveVoice's own
// wiring: instrument/ADSR/note attachment, frame counter lockstep, and
// whether noteOff()'s gate-bit mask matches the sequenced .gate(fraction)
// result byte for byte.

import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { song, note } from '../src/compiler/song.js';
import { LiveVoice } from '../src/engine/liveAudition.js';

// A non-trivial instrument: a 3-entry wave table that loops back to index 1
// (exercises resolveLoopIndex/sampleTable's wraparound), a filter-cutoff
// table (exercises the shared-register write path), and a non-default ADSR
// that must flow from instrument.adsr onto the chain exactly as
// rasterklang-dsl's interpret.js does.
const TEST_INSTRUMENT = {
  wave: ['triangle', 'saw', 'pulse'],
  loop: 1,
  adsr: [2, 3, 10, 4],
  filterTable: [200, 400, 800],
  pw: null,
  arp: null,
  test: null,
  gateTable: null,
  vib: null,
  vibTri: null,
  slide: null,
  gate: null,
  gateMode: null,
  speed: null,
};

const MIDI_NOTE = 57; // A3

describe('live vs sequenced note playback produce identical poke streams', () => {
  it('matches frame-for-frame while the note is held (no release)', () => {
    const FRAMES = 40;

    const liveVoice = new LiveVoice(0);
    const livePokes = [liveVoice.noteOn(MIDI_NOTE, TEST_INSTRUMENT)];
    for (let i = 1; i < FRAMES; i += 1) livePokes.push(liveVoice.step());

    // Sequenced: a normal song, one voice, a single long-held note (durFrac
    // 1 over a cycle much longer than FRAMES so the Hap is still active for
    // every frame compared).
    const seqSong = song(120, { beatsPerCycle: 1000 });
    seqSong.voice(0, note(MIDI_NOTE).inst(TEST_INSTRUMENT).adsr(...TEST_INSTRUMENT.adsr));
    const seqFrameSource = compile(seqSong);
    const seqPokes = [];
    for (let i = 0; i < FRAMES; i += 1) seqPokes.push(seqFrameSource(i));

    expect(livePokes).toEqual(seqPokes);
  });

  it('matches frame-for-frame through noteOff()/release, vs a sequenced gate(fraction) drop', () => {
    // Sequenced song: framesPerCycle = round(3000/120*4) = 100; .gate(0.5)
    // drops the gate at floor(0.5*100) = frame 50 (frames-since-onset).
    const seqSong = song(120, { beatsPerCycle: 4 });
    seqSong.voice(
      0,
      note(MIDI_NOTE).inst(TEST_INSTRUMENT).adsr(...TEST_INSTRUMENT.adsr).gate(0.5),
    );
    const seqFrameSource = compile(seqSong);
    const GATE_OFF_FRAME = 50;
    const TOTAL_FRAMES = 70;
    const seqPokes = [];
    for (let i = 0; i < TOTAL_FRAMES; i += 1) seqPokes.push(seqFrameSource(i));

    const liveVoice = new LiveVoice(0);
    const livePokes = [liveVoice.noteOn(MIDI_NOTE, TEST_INSTRUMENT)];
    for (let i = 1; i < GATE_OFF_FRAME; i += 1) livePokes.push(liveVoice.step());
    // The key is released exactly as frame GATE_OFF_FRAME - 1 finishes
    // (i.e. before frame GATE_OFF_FRAME is stepped) - matching the sequenced
    // song's own gate dropping AT frame 50, not after it.
    liveVoice.noteOff();
    for (let i = GATE_OFF_FRAME; i < TOTAL_FRAMES; i += 1) livePokes.push(liveVoice.step());

    // Sanity: the sequenced stream's control-register byte really does drop
    // its gate bit exactly at GATE_OFF_FRAME, so this test is actually
    // exercising the release path, not accidentally comparing two identical
    // held notes.
    const controlAddr = 4; // voice 0's control register
    const seqControlAtRelease = seqPokes[GATE_OFF_FRAME].find((p) => p.addr === controlAddr);
    expect(seqControlAtRelease).toBeDefined();
    expect(seqControlAtRelease.value & 0x01).toBe(0);

    expect(livePokes).toEqual(seqPokes);
  });

  it('the forced gate-off/gate-on onset pair on frame 0 is identical live vs sequenced', () => {
    const liveVoice = new LiveVoice(1);
    const livePokes0 = liveVoice.noteOn(MIDI_NOTE, TEST_INSTRUMENT);

    const seqSong = song(120, { beatsPerCycle: 1000 });
    seqSong.voice(1, note(MIDI_NOTE).inst(TEST_INSTRUMENT).adsr(...TEST_INSTRUMENT.adsr));
    const seqFrameSource = compile(seqSong);
    const seqPokes0 = seqFrameSource(0);

    // A real onset always emits the control register TWICE this frame (a
    // forced gate-off write, then the real gate-on write) - assert that
    // shape survived, not just blind array equality.
    const controlAddr = 11; // voice 1's control register (base 7 + 4)
    const controlWrites = livePokes0.filter((p) => p.addr === controlAddr);
    expect(controlWrites.length).toBe(2);
    expect(controlWrites[0].value & 0x01).toBe(0);
    expect(controlWrites[1].value & 0x01).toBe(1);

    expect(livePokes0).toEqual(seqPokes0);
  });

  it('works with no instrument attached (plain chain default) too', () => {
    const liveVoice = new LiveVoice(2);
    const livePokes = [liveVoice.noteOn(MIDI_NOTE, null)];
    for (let i = 1; i < 10; i += 1) livePokes.push(liveVoice.step());

    const seqSong = song(120, { beatsPerCycle: 1000 });
    seqSong.voice(2, note(MIDI_NOTE));
    const seqFrameSource = compile(seqSong);
    const seqPokes = [];
    for (let i = 0; i < 10; i += 1) seqPokes.push(seqFrameSource(i));

    expect(livePokes).toEqual(seqPokes);
  });
});
