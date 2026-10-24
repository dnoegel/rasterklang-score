// Audition filter spec: without one, an audition note's instrument
// filterTable moves the shared cutoff register while the filter stays in
// FilterChain's inert default (mode 'none', resonance 0, no routing), so the
// sweep is inaudible. An optional `filter` spec is threaded through
// buildNoteSong -> LiveVoice.noteOn -> createLiveAudition().noteOn (options).
// These tests check both halves against real compiled output: a filter spec
// produces resonance/mode/routing writes with the audition voice routed, and
// omitting it leaves the poke stream unchanged.

import { describe, expect, it } from 'vitest';
import { compile } from '../src/compiler/compile.js';
import { song, note } from '../src/compiler/song.js';
import { LiveVoice, createLiveAudition } from '../src/engine/liveAudition.js';
import { FILTER_REGISTERS } from '../src/compiler/registerMap.js';

// Same shape as liveAudition.parity.test.js's TEST_INSTRUMENT: a real
// filterTable is what makes the inaudible-sweep case reachable, so every
// test here carries one.
const FILTER_INSTRUMENT = {
  wave: ['pulse'],
  loop: 0,
  adsr: [0, 0, 15, 0],
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

const MIDI_NOTE = 60;

function findPoke(pokes, addr) {
  return pokes.find((p) => p.addr === addr);
}

describe('audition note with a filter spec produces real resonance/mode/routing writes', () => {
  it('LiveVoice.noteOn(..., { filter }) pokes $D417/$D418 with a non-none mode and the audition voice routed', () => {
    const voiceIndex = 2;
    const v = new LiveVoice(voiceIndex);
    const pokes = v.noteOn(MIDI_NOTE, FILTER_INSTRUMENT, {
      filter: { resonance: 8, mode: 'lowpass', route: [voiceIndex] },
    });

    const resonanceRoutingPoke = findPoke(pokes, FILTER_REGISTERS.resonanceRouting); // $D417
    const modeVolumePoke = findPoke(pokes, FILTER_REGISTERS.modeVolume); // $D418
    expect(resonanceRoutingPoke).toBeDefined();
    expect(modeVolumePoke).toBeDefined();

    // Resonance nibble (bits 4-7 of $D417) is 8, and the audition voice's
    // own routing bit (bit `voiceIndex` of $D417's low 3 bits) is set.
    expect((resonanceRoutingPoke.value >> 4) & 0x0f).toBe(8);
    expect((resonanceRoutingPoke.value & 0x07) & (1 << voiceIndex)).not.toBe(0);

    // Mode bits (bits 4-6 of $D418) carry the lowpass bit (0x10) - a
    // non-none mode, which is what makes the filter contribute to the mix
    // (with no mode bits set, the SID filter outputs nothing).
    expect(modeVolumePoke.value & 0x70).toBe(0x10);
  });

  it('createLiveAudition().noteOn(..., voiceIndex, { filter }) carries the same spec through the claim-manager surface', () => {
    const live = createLiveAudition();
    const voiceIndex = 1;
    const result = live.noteOn(MIDI_NOTE, FILTER_INSTRUMENT, voiceIndex, {
      filter: { resonance: 12, mode: 'bandpass', route: [voiceIndex] },
    });
    expect(result.voiceIndex).toBe(voiceIndex);

    const resonanceRoutingPoke = findPoke(result.pokes, FILTER_REGISTERS.resonanceRouting);
    const modeVolumePoke = findPoke(result.pokes, FILTER_REGISTERS.modeVolume);
    expect((resonanceRoutingPoke.value >> 4) & 0x0f).toBe(12);
    expect((resonanceRoutingPoke.value & 0x07) & (1 << voiceIndex)).not.toBe(0);
    expect(modeVolumePoke.value & 0x70).toBe(0x20); // bandpass bit
  });
});

describe('filter audition is additive: no filter spec reproduces the exact old (bypassed-filter) behaviour', () => {
  it('LiveVoice.noteOn with no options is byte-identical to noteOn with an explicit filter:null', () => {
    const withoutOptions = new LiveVoice(0).noteOn(MIDI_NOTE, FILTER_INSTRUMENT);
    const withNullFilter = new LiveVoice(0).noteOn(MIDI_NOTE, FILTER_INSTRUMENT, { filter: null });
    expect(withoutOptions).toEqual(withNullFilter);
  });

  it('LiveVoice.noteOn with no filter matches a plain song()/compile() with no .filter() call - same as liveAudition.parity.test.js, unchanged by this fix', () => {
    const liveVoice = new LiveVoice(0);
    const livePokes = [liveVoice.noteOn(MIDI_NOTE, FILTER_INSTRUMENT)];
    for (let i = 1; i < 20; i += 1) livePokes.push(liveVoice.step());

    const seqSong = song(120, { beatsPerCycle: 1000 });
    seqSong.voice(0, note(MIDI_NOTE).inst(FILTER_INSTRUMENT).adsr(...FILTER_INSTRUMENT.adsr));
    const seqFrameSource = compile(seqSong);
    const seqPokes = [];
    for (let i = 0; i < 20; i += 1) seqPokes.push(seqFrameSource(i));

    expect(livePokes).toEqual(seqPokes);

    // Sanity: without a spec the filter stays inert (mode 'none'), i.e. the
    // default behaviour is unchanged.
    const modeVolumePoke = findPoke(livePokes[0], FILTER_REGISTERS.modeVolume);
    expect(modeVolumePoke.value & 0x70).toBe(0); // no mode bit set: 'none'
  });

  it('createLiveAudition().noteOn with no 4th argument is unaffected by the new options parameter', () => {
    const live = createLiveAudition();
    const result = live.noteOn(MIDI_NOTE, FILTER_INSTRUMENT, 0);
    const modeVolumePoke = findPoke(result.pokes, FILTER_REGISTERS.modeVolume);
    expect(modeVolumePoke.value & 0x70).toBe(0);
  });
});
