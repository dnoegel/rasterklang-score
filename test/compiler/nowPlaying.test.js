import { describe, expect, it } from 'vitest';
import { song, note } from '../../src/compiler/song.js';
import { compile } from '../../src/compiler/compile.js';
import { midiNoteToName } from '../../src/compiler/registerMap.js';
import { pure } from '../../src/pattern/query.js';

// frameSource.lastFrame is a non-invasive side-channel (see compile.js) that
// mirrors the compiler's own authoritative per-frame state, consumed by
// liveEngine.js's getNowPlaying() and editor note highlighting. These tests
// check it directly, independent of the register-write
// assertions in compile.test.js.

describe('compile: frameSource.lastFrame now-playing side-channel', () => {
  it('reports the active note name/waveform/gate for a sounding voice', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 ~ e4 ~').s('pulse').adsr(0, 8, 10, 4));
    const frameSource = compile(s);

    frameSource(0);
    expect(frameSource.lastFrame.voices[0]).toMatchObject({
      active: true,
      gate: true,
      noteName: midiNoteToName(60),
      midiNote: 60,
      waveform: ['pulse'],
    });
  });

  it('reports silence (active: false, noteName: null) during a rest', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 ~ e4 ~').s('pulse').adsr(0, 8, 10, 4));
    const frameSource = compile(s);

    // framesPerCycle = round(50*60/120 * 4) = 100; step 2 of 4 ("~") starts at
    // frame 25 (posFrac 0.25..0.5).
    frameSource(30);
    expect(frameSource.lastFrame.voices[0]).toMatchObject({
      active: false,
      gate: false,
      noteName: null,
      midiNote: null,
    });
  });

  it('reports an unassigned voice as silent', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4').s('pulse').adsr(0, 8, 10, 4));
    const frameSource = compile(s);
    frameSource(0);
    expect(frameSource.lastFrame.voices[1]).toMatchObject({ active: false, noteName: null });
    expect(frameSource.lastFrame.voices[2]).toMatchObject({ active: false, noteName: null });
  });

  it('reports filter cutoff/resonance/mode/routing state', () => {
    const s = song(120, { beatsPerCycle: 4 })
      .voice(0, note('c4').s('pulse').adsr(0, 8, 10, 4))
      .filter((f) => f.cutoff(1000).resonance(8).mode('lowpass').route(0));
    const frameSource = compile(s);
    frameSource(0);
    expect(frameSource.lastFrame.filter).toMatchObject({
      cutoffRaw: 1000,
      resonance: 8,
      mode: ['lowpass'],
      routing: [true, false, false],
    });
  });

  it('round-robins the reported note across an arpeggiated chord', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(
      0,
      note('[c4,e4,g4]').s('pulse').adsr(0, 8, 10, 4),
    );
    const frameSource = compile(s);

    const seen = new Set();
    for (let i = 0; i < 30; i += 1) {
      frameSource(i);
      const { noteName } = frameSource.lastFrame.voices[0];
      if (noteName) seen.add(noteName);
    }
    // All three chord tones should show up in the reported note over enough frames.
    expect(seen).toEqual(new Set([midiNoteToName(60), midiNoteToName(64), midiNoteToName(67)]));
  });
});

describe('compile: frameSource.lastFrame highlights rests (~) too, not just sounding notes', () => {
  it('reports a source range during a rest, with active/gate false', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 ~ e4 ~').s('pulse').adsr(0, 8, 10, 4));
    const frameSource = compile(s);

    // framesPerCycle = 100 for 120bpm/4 beats; step 2 ("~") is frames 25-49.
    frameSource(30);
    const v0 = frameSource.lastFrame.voices[0];
    expect(v0.active).toBe(false);
    expect(v0.gate).toBe(false);
    expect(v0.noteName).toBeNull();
    expect(v0.noteSourceText.slice(v0.sourceStart, v0.sourceEnd)).toBe('~');
  });

  it('reports a source range for a real note with active/gate true, distinct from a rest', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 ~ e4 ~').s('pulse').adsr(0, 8, 10, 4));
    const frameSource = compile(s);

    frameSource(0); // step 1 ("c4")
    const v0 = frameSource.lastFrame.voices[0];
    expect(v0.active).toBe(true);
    expect(v0.gate).toBe(true);
    expect(v0.noteSourceText.slice(v0.sourceStart, v0.sourceEnd)).toBe('c4');
  });

  it('does not let a rest accidentally gate a note on (audio unaffected by the highlight-only rest Hap)', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 ~ e4 ~').s('pulse').adsr(0, 8, 10, 4));
    const frameSource = compile(s);
    frameSource(30);
    const pokes = frameSource(31);
    // No forced/changed gate-on register write while resting.
    const controlPokes = pokes.filter((p) => p.addr === 4);
    for (const p of controlPokes) expect(p.value & 0x01).toBe(0);
  });
});

describe('compile: frameSource.lastFrame source-position fields (editor highlighting)', () => {
  it('reports sourceStart/sourceEnd/noteSourceText for the active note, relative to the raw pattern string', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note('c4 e4').s('pulse').adsr(0, 8, 10, 4));
    const frameSource = compile(s);
    frameSource(0);
    const v0 = frameSource.lastFrame.voices[0];
    expect(v0.noteSourceText).toBe('c4 e4');
    expect(v0.noteSourceText.slice(v0.sourceStart, v0.sourceEnd)).toBe('c4');

    frameSource(50); // second step ("e4") of a 100-frame cycle
    const v0b = frameSource.lastFrame.voices[0];
    expect(v0b.noteSourceText.slice(v0b.sourceStart, v0b.sourceEnd)).toBe('e4');
  });

  it('leaves sourceStart/sourceEnd/noteSourceText null when the voice was not built from a plain string', () => {
    const s = song(120, { beatsPerCycle: 4 }).voice(0, note(pure(60)).s('pulse').adsr(0, 8, 10, 4));
    const frameSource = compile(s);
    frameSource(0);
    const v0 = frameSource.lastFrame.voices[0];
    expect(v0.noteSourceText).toBeNull();
    expect(v0.sourceStart).toBeNull();
    expect(v0.sourceEnd).toBeNull();
  });
});

describe('midiNoteToName', () => {
  it('round-trips known values', () => {
    expect(midiNoteToName(60)).toBe('c4');
    expect(midiNoteToName(69)).toBe('a4');
    expect(midiNoteToName(61)).toBe('cs4');
  });
});
