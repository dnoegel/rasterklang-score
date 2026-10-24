// Unit tests for the live-coding hot-swap path in isolation: given a running
// frameIndex counter and two compiled frameSources, swapping produces a sane
// pokes[] sequence with no register left in an inconsistent state.
//
// A hot swap is a call to engine.setFrameSource(newFrameSource) (see
// liveEngine.js's doc comment:
// "Hot-swap: reassigns the closure variable the pump loop reads from ...
// takes effect on the next frame"), which doesn't reset liveEngine's
// frameIndex counter. What *is* meaningfully testable in isolation, without
// spinning up a real engine/AudioContext, is exactly what that means for
// compile.js's frame-diffing output when the frameIndex handed to a
// freshly-compiled frameSource is not 0 but wherever the transport happened
// to be.

import { describe, expect, it } from 'vitest';
import { song, note } from '../../src/compiler/song.js';
import { compile } from '../../src/compiler/compile.js';
import { sine } from '../../src/pattern/signals.js';
import { voiceBase } from '../../src/compiler/registerMap.js';

function assertValidPokes(pokes) {
  for (const { addr, value } of pokes) {
    expect(addr).toBeGreaterThanOrEqual(0x00);
    expect(addr).toBeLessThanOrEqual(0x1f);
    expect(value).toBeGreaterThanOrEqual(0x00);
    expect(value).toBeLessThanOrEqual(0xff);
  }
}

function applyPokes(shadow, pokes) {
  for (const { addr, value } of pokes) shadow[addr] = value;
}

describe('hot-swap: swapping a running frameIndex counter between two compiled songs', () => {
  it('keeps every poke in-range across the swap boundary, on both sides', () => {
    const songA = song(120, { beatsPerCycle: 4 }).voice(0, note('c2 e2 g2 a2').s('pulse').adsr(0, 4, 10, 4));
    const songB = song(90, { beatsPerCycle: 4 })
      .voice(0, note('d3 f3').s('triangle').adsr(2, 6, 12, 6))
      .filter((f) => f.cutoff(sine.range(200, 1800)).mode('lowpass').route(0));

    const frameSourceA = compile(songA);
    const frameSourceB = compile(songB);

    // Simulate the running transport: frameIndex keeps incrementing across
    // the swap exactly as liveEngine.js's pump loop does - it never resets
    // just because setFrameSource() was called.
    let frameIndex = 0;
    for (; frameIndex < 50; frameIndex += 1) {
      assertValidPokes(frameSourceA(frameIndex));
    }
    // "Evaluate" happens here: engine.setFrameSource(frameSourceB) - frameIndex
    // is untouched, so frameSourceB's very first call is at frameIndex 50, not 0.
    for (; frameIndex < 100; frameIndex += 1) {
      assertValidPokes(frameSourceB(frameIndex));
    }
  });

  it('fully resyncs every register the new song touches on its first post-swap call, regardless of the frameIndex value it is first called with', () => {
    const songA = song(120, { beatsPerCycle: 4 }).voice(0, note('c2 e2 g2 a2').s('pulse').adsr(0, 4, 10, 4));
    const songB = song(90, { beatsPerCycle: 4 }).voice(0, note('d3').s('triangle').adsr(2, 6, 12, 6));

    const frameSourceA = compile(songA);
    const frameSourceB = compile(songB);
    const base = voiceBase(0);

    // Run the old song for a while so its last-known register image is
    // clearly different from a fresh -1 sentinel image (e.g. a pulse
    // waveform control byte, not triangle).
    let lastFrame = 0;
    for (let i = 0; i < 60; i += 1) lastFrame = frameSourceA(i);
    void lastFrame;

    // The swap: a brand-new compile() instance starts its own internal
    // register-diff state at an all -1 sentinel (see compile.js), completely
    // independent of songA's state or of the frameIndex it's first called
    // with - so its first call unconditionally re-declares every register
    // it cares about, which is exactly what makes the swap safe (no
    // "half old / half new" frame).
    const firstPostSwapPokes = frameSourceB(60);
    const touchedAddrs = new Set(firstPostSwapPokes.map((p) => p.addr));

    // Every voice-0 register the new song's chain configures must appear.
    for (let offset = 0; offset <= 6; offset += 1) {
      expect(touchedAddrs.has(base + offset)).toBe(true);
    }
    // And the control byte's gate transition is a genuine onset (off-then-on),
    // not a bare diff against songA's last control byte.
    const controlPokes = firstPostSwapPokes.filter((p) => p.addr === base + 4);
    expect(controlPokes.length).toBeGreaterThanOrEqual(2);
    expect(controlPokes[0].value & 0x01).toBe(0);
    expect(controlPokes[controlPokes.length - 1].value & 0x01).toBe(1);

    assertValidPokes(firstPostSwapPokes);
  });

  it('documents the known scope of the swap: a voice the new song does not assign at all is simply not part of its output', () => {
    // songA plays voice 1; songB only assigns voice 0. By design each
    // compiled frameSource only emits pokes for voices its own Song assigns
    // (see compile.js's `if (!chain) continue`). A live-coding session that drops a voice
    // between edits should reassign that voice silence explicitly (e.g.
    // `note("~")`) rather than omitting `.voice()` for it, if it was
    // sounding before.
    const songA = song(120).voice(1, note('c3').s('pulse').adsr(0, 0, 15, 0));
    const songB = song(120).voice(0, note('e3').s('triangle'));

    const frameSourceA = compile(songA);
    const frameSourceB = compile(songB);
    const voice1Base = voiceBase(1);

    for (let i = 0; i < 10; i += 1) frameSourceA(i);
    const postSwapPokes = frameSourceB(10);

    expect(postSwapPokes.some((p) => p.addr >= voice1Base && p.addr <= voice1Base + 6)).toBe(false);
  });
});
