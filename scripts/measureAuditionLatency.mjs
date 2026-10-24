// Manual measurement script (not part of `npm test`; vitest.config.js only
// picks up test/**/*.test.js). Prints the wall-clock trigger-to-audible
// latency of createLiveEngine() for a given {framesPerBuffer,
// scheduleAheadSeconds, scheduleIntervalMs} config, using the same real-time
// FakeAudioContext harness as test/auditionSchedulingLatency.test.js. Run
// with:
//
//   node scripts/measureAuditionLatency.mjs
//
// Requires the sibling rasterklang-wasm repo to be checked out and built
// (../rasterklang-wasm/dist/{rasterklang.js,rasterklang.wasm,wasm_exec.js}),
// same requirement as test/liveAudition.latency.test.js.
//
// This is the tool used to pick the AUDITION_FRAMES_PER_BUFFER /
// AUDITION_SCHEDULE_AHEAD_SECONDS / AUDITION_SCHEDULE_INTERVAL_MS constants
// in src/engine/liveEngine.js. It compares them against the default
// sequenced-playback settings (~0.6-0.7s latency), and checks for scheduling
// underruns (gaps between consecutively scheduled buffers, i.e. audible
// dropouts) under simulated main-thread contention. Host jitter can dominate
// the numbers on a busy machine, which is why the shipped constants keep
// some margin above the minimum this script finds and why the regression
// test takes the median of several trials.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLiveEngine,
  AUDITION_FRAMES_PER_BUFFER,
  AUDITION_SCHEDULE_AHEAD_SECONDS,
  AUDITION_SCHEDULE_INTERVAL_MS,
} from '../src/engine/liveEngine.js';
import {
  createEngineForMeasurement,
  makeTriggerableFrameSource,
  measureTriggerToAudibleLatencyMs,
  detectUnderruns,
} from '../test/helpers/schedulingLatencyHarness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_DIST_DIR = path.resolve(__dirname, '../../rasterklang-wasm/dist');

async function loadRealWasm() {
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
}

async function measureOnce(label, engineOptions, { repeats = 5 } = {}) {
  const results = [];
  let underrunCount = 0;
  for (let i = 0; i < repeats; i += 1) {
    const { engine, audioContext } = await createEngineForMeasurement(
      createLiveEngine,
      path.join(WASM_DIST_DIR, 'rasterklang.js'),
      engineOptions,
    );
    const frameSource = makeTriggerableFrameSource(0);
    try {
      const ms = await measureTriggerToAudibleLatencyMs({ engine, frameSource, settleMs: 300, timeoutMs: 3000 });
      results.push(ms);
      underrunCount += detectUnderruns(audioContext).length;
    } finally {
      engine.stop();
    }
  }
  results.sort((a, b) => a - b);
  const median = results[Math.floor(results.length / 2)];
  const min = results[0];
  const max = results[results.length - 1];
  console.log(
    `[${label}] framesPerBuffer=${engineOptions.framesPerBuffer} scheduleAheadSeconds=${engineOptions.scheduleAheadSeconds} ` +
      `scheduleIntervalMs=${engineOptions.scheduleIntervalMs} -> trigger-to-audible latency (ms): ` +
      `min=${min.toFixed(1)} median=${median.toFixed(1)} max=${max.toFixed(1)} ` +
      `(${repeats} runs: [${results.map((r) => r.toFixed(1)).join(', ')}]), underruns=${underrunCount}`,
  );
  return { min, median, max, results, underrunCount };
}

// stressTest(engineOptions, {durationMs, jankEveryMs, jankMs}) -> runs the
// engine for durationMs of real wall-clock time, alternately triggering the
// frameSource every ~40ms (simulating rapid repeated noteOn/noteOff) WHILE
// also periodically blocking the event loop synchronously (jankMs every
// jankEveryMs) to simulate React renders/GC pauses competing for main-thread
// time with the pump loop's setTimeout-driven scheduling - the realistic
// failure mode for a tight scheduleIntervalMs. Reports underrun count (see
// detectUnderruns) across the whole stress run.
async function stressTest(label, engineOptions, { durationMs = 2000, jankEveryMs = 50, jankMs = 8, triggerEveryMs = 40 } = {}) {
  const { engine, audioContext } = await createEngineForMeasurement(
    createLiveEngine,
    path.join(WASM_DIST_DIR, 'rasterklang.js'),
    engineOptions,
  );
  const frameSource = makeTriggerableFrameSource(0);
  await engine.start(frameSource);

  let value = 0;
  const triggerTimer = setInterval(() => {
    value = value === 0 ? 1 : 0;
    frameSource.trigger(value);
  }, triggerEveryMs);
  const jankTimer = setInterval(() => {
    const until = performance.now() + jankMs;
    // eslint-disable-next-line no-empty
    while (performance.now() < until) {}
  }, jankEveryMs);

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  clearInterval(triggerTimer);
  clearInterval(jankTimer);
  engine.stop();

  const underruns = detectUnderruns(audioContext);
  console.log(
    `[${label}] STRESS framesPerBuffer=${engineOptions.framesPerBuffer} scheduleAheadSeconds=${engineOptions.scheduleAheadSeconds} ` +
      `scheduleIntervalMs=${engineOptions.scheduleIntervalMs} over ${durationMs}ms with ${jankMs}ms jank every ${jankEveryMs}ms: ` +
      `${audioContext.startCalls.length} buffers scheduled, ${underruns.length} underruns` +
      (underruns.length ? ` (worst gap: ${Math.max(...underruns.map((u) => u.gapSeconds)).toFixed(4)}s)` : ''),
  );
  return underruns.length;
}

async function main() {
  await loadRealWasm();

  console.log('--- BEFORE (old defaults ensureAuditionEngine() used to inherit unmodified) ---');
  await measureOnce('BEFORE:old-defaults', {
    sampleRate: 44100,
    model: '6581',
    framesPerBuffer: 6,
    scheduleAheadSeconds: 0.6,
    scheduleIntervalMs: 75,
  });

  console.log('\n--- AFTER (shipped AUDITION_* constants, src/engine/liveEngine.js) ---');
  const shipped = {
    framesPerBuffer: AUDITION_FRAMES_PER_BUFFER,
    scheduleAheadSeconds: AUDITION_SCHEDULE_AHEAD_SECONDS,
    scheduleIntervalMs: AUDITION_SCHEDULE_INTERVAL_MS,
  };
  await measureOnce('AFTER:shipped', { sampleRate: 44100, model: '6581', ...shipped }, { repeats: 8 });

  console.log('\n--- Glitch check: rapid triggers + simulated main-thread jank on the shipped config ---');
  await stressTest('shipped', { sampleRate: 44100, model: '6581', ...shipped });
  await stressTest('shipped-heavier-jank', { sampleRate: 44100, model: '6581', ...shipped }, { jankMs: 15, jankEveryMs: 30 });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
