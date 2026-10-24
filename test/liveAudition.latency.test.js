// Live audition latency: the wall-clock cost of one poke+readChunk cycle
// against a real rasterklang-wasm LiveSession (not a fake session), used to
// derive a trigger-to-audible latency bound from measured numbers.
//
// Why this is possible at all in a headless Node test (no browser, no real
// AudioContext): rasterklang-wasm's dist bundle is a standard Go
// `GOOS=js GOARCH=wasm` build plus the standard wasm_exec.js shim, which is
// itself written to run under plain Node (see wasm_exec.js's own `globalThis
// fs`/`process` polyfill block) - nothing about *running* the WASM module
// needs a DOM. The only browser-only parts of rasterklang-wasm's own loader
// (createRasterklang -> loadWasm) are `fetch(wasmURL)` and `document.
// createElement('script')` for wasm_exec.js - both are bypassed below by
// loading both files directly via fs/dynamic import and pre-populating
// `globalThis.rasterklangWasm` ourselves (loadWasm() checks for that global
// FIRST and skips its own fetch/script-tag path entirely when present).
//
// What IS real-measured here: the wall-clock cost of session.poke()/
// session.readChunk() calls against the real WASM SID engine, running in
// this actual Node process. What is NOT independently measured (no real
// AudioContext exists in this environment): the browser's own
// AudioBufferSourceNode scheduling floor - see
// estimateTriggerToAudibleLatencyMs in liveAudition.js for where that
// assumption comes from.
//
// rasterklang-wasm is expected as a sibling checkout (not an npm dependency)
// and loaded via a relative path to its build output. Without it these tests
// return early.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  LiveVoice,
  measureFrameCycleCostMs,
  estimateTriggerToAudibleLatencyMs,
  DEFAULT_LIVE_FRAMES_PER_BUFFER,
  pumpLiveVoiceFrames,
} from '../src/engine/liveAudition.js';
import { samplesPerFrameFor } from '../src/engine/liveEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_DIST_DIR = path.resolve(__dirname, '../../rasterklang-wasm/dist');

let rasterklangModule = null;
let loadError = null;

beforeAll(async () => {
  try {
    if (!fs.existsSync(path.join(WASM_DIST_DIR, 'rasterklang.wasm'))) {
      throw new Error(`rasterklang-wasm build output not found at ${WASM_DIST_DIR} - is the sibling repo checked out and built?`);
    }
    // wasm_exec.js registers globalThis.Go as a side effect of being loaded.
    await import(path.join(WASM_DIST_DIR, 'wasm_exec.js'));
    if (!globalThis.Go) throw new Error('wasm_exec.js loaded but did not register globalThis.Go.');

    const go = new globalThis.Go();
    const bytes = fs.readFileSync(path.join(WASM_DIST_DIR, 'rasterklang.wasm'));
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    // go.run() resolves once the Go program calls its own `Exit`, which a
    // long-running js/wasm program (like this one, registering callbacks and
    // then blocking forever) never does - so this is deliberately NOT
    // awaited; we just give the Go program's initial synchronous setup (the
    // js.Global().Set("rasterklangWasm", ...) call) a moment to run.
    go.run(instance);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!globalThis.rasterklangWasm) throw new Error('WASM ran but did not register globalThis.rasterklangWasm.');

    rasterklangModule = await import(path.join(WASM_DIST_DIR, 'rasterklang.js'));
  } catch (err) {
    loadError = err;
  }
}, 20000);

describe('audition latency: real wasm poke+readChunk cost -> trigger-to-audible bound', () => {
  it('loads the real rasterklang-wasm engine in this headless Node test environment', () => {
    if (loadError) {
      throw new Error(
        `Could not load rasterklang-wasm for real timing measurement: ${loadError.message}\n` +
          'This is a genuine environment blocker, not a fake/assumed result - see this file\'s header comment.',
      );
    }
    expect(rasterklangModule).not.toBeNull();
  });

  it('measures real poke+readChunk cost and derives a trigger-to-audible latency bound under 40ms', async () => {
    if (loadError) {
      // Already reported as a failure by the test above; don't fail twice
      // with a less informative message.
      return;
    }

    const rk = await rasterklangModule.createRasterklang({});
    const sampleRate = 44100;
    const session = rk.startLive({ sampleRate, model: '6581' });
    const samplesPerFrame = samplesPerFrameFor(sampleRate, 50);

    try {
      const { medianMs, p95Ms, minMs } = measureFrameCycleCostMs({ session, samplesPerFrame, iterations: 200, warmupIterations: 200 });

      const frameBudgetMs = 1000 / 50; // one PAL frame's real-time budget at 50fps = 20ms
      const latencyMs = estimateTriggerToAudibleLatencyMs({ frameCycleCostMs: medianMs, schedulingFloorMs: 10 });

      // Measured numbers (see this file's header), logged so the figures are
      // visible, not just pass/fail:
      //   eslint-disable-next-line no-console
      console.log(
        `[audition latency] measured poke+readChunk(${samplesPerFrame} samples @ ${sampleRate}Hz) cost: ` +
          `median=${medianMs.toFixed(3)}ms p95=${p95Ms.toFixed(3)}ms min=${minMs.toFixed(3)}ms ` +
          `(real-time budget per frame at 50fps = ${frameBudgetMs.toFixed(1)}ms) -> ` +
          `estimated trigger-to-audible latency (measured compute + liveEngine.js's existing ` +
          `10ms AudioBufferSourceNode scheduling-floor ASSUMPTION) = ${latencyMs.toFixed(3)}ms`,
      );

      // Single-frame compute cost must fit comfortably inside one 50fps
      // frame's real-time budget (with headroom for other work), which is
      // what justifies DEFAULT_LIVE_FRAMES_PER_BUFFER = 1.
      expect(medianMs).toBeLessThan(frameBudgetMs);
      // Target: about 40ms (2 PAL frames).
      expect(latencyMs).toBeLessThan(40);
    } finally {
      session.stop();
    }
  });

  it('pumpLiveVoiceFrames renders real audio for a live-triggered voice at the default (1-frame) buffer size', async () => {
    if (loadError) return;

    const rk = await rasterklangModule.createRasterklang({});
    const sampleRate = 44100;
    const session = rk.startLive({ sampleRate, model: '6581' });
    const samplesPerFrame = samplesPerFrameFor(sampleRate, 50);

    try {
      const liveVoice = new LiveVoice(0);
      // noteOn() returns frame 0's pokes (the gate-on write) without
      // applying them; a low-latency caller applies them synchronously, as
      // here, so the trigger does not wait for the next pump tick.
      // pumpLiveVoiceFrames (below) drives step() from frame 1 onward.
      const onsetPokes = liveVoice.noteOn(57, { wave: ['triangle'], adsr: [0, 0, 15, 0] });
      for (const { addr, value } of onsetPokes) session.poke(addr & 0x1f, value & 0xff);

      expect(DEFAULT_LIVE_FRAMES_PER_BUFFER).toBe(1);
      const data = pumpLiveVoiceFrames({ liveVoice, session, samplesPerFrame });
      expect(data.length).toBe(samplesPerFrame);
      // A held triangle note at non-zero sustain should produce genuinely
      // non-silent output once the envelope has had a couple of frames to
      // reach sustain - pump a few more frames and check the buffer isn't
      // all zeros (a real, if coarse, "did the WASM engine actually render
      // audio" check).
      let sawNonZero = false;
      for (let i = 0; i < 5 && !sawNonZero; i += 1) {
        const chunk = pumpLiveVoiceFrames({ liveVoice, session, samplesPerFrame });
        sawNonZero = chunk.some((v) => v !== 0);
      }
      expect(sawNonZero).toBe(true);
    } finally {
      session.stop();
    }
  });
});
