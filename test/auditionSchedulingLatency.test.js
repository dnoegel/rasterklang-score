// Regression coverage for the audition scheduling profile. With
// createLiveEngine()'s DEFAULT_* constants (DEFAULT_SCHEDULE_AHEAD_SECONDS =
// 0.6s, DEFAULT_FRAMES_PER_BUFFER = 6), which suit glitch-free sequenced
// playback, a live-triggered poke only becomes audible after the scheduled
// queue drains: roughly 0.5-0.7s of input delay. The AUDITION_* constants in
// liveEngine.js fix that for "press a key, hear it now" audition engines;
// these tests pin that.
//
// Uses the real-time (not fake-timers) FakeAudioContext harness from
// test/helpers/schedulingLatencyHarness.js, the same one
// scripts/measureAuditionLatency.mjs uses: the pump loop schedules against
// audioContext.currentTime and setTimeout, so real time has to pass.
//
// One engine per test: creating many WASM LiveSessions in quick succession
// in one Node process perturbs timing (GC/memory pressure).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  createLiveEngine,
  AUDITION_FRAMES_PER_BUFFER,
  AUDITION_SCHEDULE_AHEAD_SECONDS,
  AUDITION_SCHEDULE_INTERVAL_MS,
} from '../src/engine/liveEngine.js';
import {
  createEngineForMeasurement,
  makeTriggerableFrameSource,
  measureMultipleTriggerLatenciesMs,
  median,
  detectUnderruns,
} from './helpers/schedulingLatencyHarness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_DIST_DIR = path.resolve(__dirname, '../../rasterklang-wasm/dist');
const WASM_JS_PATH = path.join(WASM_DIST_DIR, 'rasterklang.js');

let loadError = null;

beforeAll(async () => {
  try {
    if (!fs.existsSync(path.join(WASM_DIST_DIR, 'rasterklang.wasm'))) {
      throw new Error(`rasterklang-wasm build output not found at ${WASM_DIST_DIR} - is the sibling repo checked out and built?`);
    }
    await import(path.join(WASM_DIST_DIR, 'wasm_exec.js'));
    if (!globalThis.Go) throw new Error('wasm_exec.js loaded but did not register globalThis.Go.');
    const go = new globalThis.Go();
    const bytes = fs.readFileSync(path.join(WASM_DIST_DIR, 'rasterklang.wasm'));
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    go.run(instance);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!globalThis.rasterklangWasm) throw new Error('WASM ran but did not register globalThis.rasterklangWasm.');
  } catch (err) {
    loadError = err;
  }
}, 20000);

describe('audition engine scheduling latency (the low-latency AUDITION_* profile)', () => {
  it('loads the real rasterklang-wasm engine in this headless Node test environment', () => {
    if (loadError) {
      throw new Error(`Could not load rasterklang-wasm: ${loadError.message}`);
    }
  });

  it('the exported AUDITION_* constants are a genuinely small low-latency profile', () => {
    // The sequenced-playback defaults (DEFAULT_FRAMES_PER_BUFFER = 6,
    // DEFAULT_SCHEDULE_AHEAD_SECONDS = 0.6, intentionally not exported;
    // sequenced playback gets them by omitting these options) are separate;
    // this just pins the audition profile as small.
    expect(AUDITION_FRAMES_PER_BUFFER).toBeLessThanOrEqual(2);
    expect(AUDITION_SCHEDULE_AHEAD_SECONDS).toBeLessThan(0.1);
    expect(AUDITION_SCHEDULE_INTERVAL_MS).toBeLessThan(AUDITION_SCHEDULE_AHEAD_SECONDS * 1000);
  });

  // Both timing tests below take the MEDIAN of several real trigger
  // measurements against one engine, and `retry` a couple of times, rather
  // than trusting a single real-time trial: on a loaded machine one
  // wall-clock measurement can be skewed by an unrelated spike. A genuine
  // regression (e.g. AUDITION_SCHEDULE_AHEAD_SECONDS back at 0.6s) fails
  // every trial and every retry by an order of magnitude.
  it('measures a real trigger-to-audible latency well under 100ms (target ~40-60ms)', async () => {
    if (loadError) return;

    const { engine } = await createEngineForMeasurement(createLiveEngine, WASM_JS_PATH, {
      sampleRate: 44100,
      model: '6581',
      framesPerBuffer: AUDITION_FRAMES_PER_BUFFER,
      scheduleAheadSeconds: AUDITION_SCHEDULE_AHEAD_SECONDS,
      scheduleIntervalMs: AUDITION_SCHEDULE_INTERVAL_MS,
    });
    const frameSource = makeTriggerableFrameSource(0);

    try {
      const samples = await measureMultipleTriggerLatenciesMs({ engine, frameSource, settleMs: 300, count: 5 });
      const med = median(samples);
      // eslint-disable-next-line no-console
      console.log(`[audition latency, AFTER fix] samples(ms)=[${samples.map((s) => s.toFixed(1)).join(', ')}] median=${med.toFixed(1)}ms`);
      // Requirement: well under 100ms.
      expect(med).toBeLessThan(100);
    } finally {
      engine.stop();
    }
  }, { timeout: 15000, retry: 2 });

  it('the OLD (pre-fix) defaults really did produce ~0.5s+ latency - confirms the root-cause diagnosis, not just the fix', async () => {
    if (loadError) return;

    const { engine } = await createEngineForMeasurement(createLiveEngine, WASM_JS_PATH, {
      sampleRate: 44100,
      model: '6581',
      // createLiveEngine()'s own defaults (the sequenced-playback profile).
      framesPerBuffer: 6,
      scheduleAheadSeconds: 0.6,
      scheduleIntervalMs: 75,
    });
    const frameSource = makeTriggerableFrameSource(0);

    try {
      const samples = await measureMultipleTriggerLatenciesMs({ engine, frameSource, settleMs: 300, count: 3 });
      const med = median(samples);
      // eslint-disable-next-line no-console
      console.log(`[audition latency, BEFORE fix / old defaults] samples(ms)=[${samples.map((s) => s.toFixed(1)).join(', ')}] median=${med.toFixed(1)}ms`);
      expect(med).toBeGreaterThan(400);
    } finally {
      engine.stop();
    }
  }, { timeout: 15000, retry: 2 });

  it('rapid repeated note triggers (~simulated fast noteOn/noteOff) produce no scheduling underruns (no audible dropout)', async () => {
    if (loadError) return;

    const { engine, audioContext } = await createEngineForMeasurement(createLiveEngine, WASM_JS_PATH, {
      sampleRate: 44100,
      model: '6581',
      framesPerBuffer: AUDITION_FRAMES_PER_BUFFER,
      scheduleAheadSeconds: AUDITION_SCHEDULE_AHEAD_SECONDS,
      scheduleIntervalMs: AUDITION_SCHEDULE_INTERVAL_MS,
    });
    const frameSource = makeTriggerableFrameSource(0);

    try {
      await engine.start(frameSource);
      // Rapid alternating "noteOn"/"noteOff" (every 40ms, ~human-fast key
      // repeat) for 1.5s of real wall-clock time.
      let value = 0;
      const timer = setInterval(() => {
        value = value === 0 ? 1 : 0;
        frameSource.trigger(value);
      }, 40);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      clearInterval(timer);

      const underruns = detectUnderruns(audioContext);
      // eslint-disable-next-line no-console
      console.log(`[audition glitch check] ${audioContext.startCalls.length} buffers scheduled, ${underruns.length} underruns (gaps).`);
      expect(underruns).toEqual([]);
    } finally {
      engine.stop();
    }
  }, { timeout: 10000, retry: 2 });
});
