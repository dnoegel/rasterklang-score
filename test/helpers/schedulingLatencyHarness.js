// Shared harness for measuring createLiveEngine()'s ACTUAL trigger-to-audible
// scheduling latency, as opposed to liveAudition.latency.test.js, which only
// covers the raw poke()+readChunk() compute cost and not the lookahead delay
// createLiveEngine's pump loop adds on top (DEFAULT_SCHEDULE_AHEAD_SECONDS =
// 0.6s / DEFAULT_FRAMES_PER_BUFFER = 6 with the default profile).
//
// Approach: createLiveEngine() only ever talks to `audioContext.currentTime`
// and a handful of node-creation calls (createBuffer/createBufferSource/
// createGain) to decide WHEN a rendered frame's audio is scheduled to start -
// none of that requires a real browser AudioContext to observe. FakeAudioContext
// below is a minimal stand-in whose `currentTime` tracks REAL wall-clock time
// (via performance.now()), so the pump loop's own internal setTimeout(pump,
// scheduleIntervalMs) polling runs for real, at real speed, exactly as it
// would in a browser tab - this is deliberately a real-time simulation, not a
// fake-timers one, so the measured numbers are genuine elapsed wall-clock
// milliseconds, not an artifact of mocked timer arithmetic.
//
// The signal being timed is carried through the SAME nowPlayingTimeline/
// getNowPlaying() plumbing production code already uses (see liveEngine.js),
// via a frameSource whose `.lastFrame` reports whatever `trigger(value)` was
// last called with - changing the frameSource's own output the moment a
// caller "pokes" it models a live trigger: the pump loop may already have
// rendered and scheduled audio for frames beyond "now" using the
// pre-trigger output, so the trigger cannot become audible before that
// queue drains.

export class FakeAudioContext {
  constructor({ sampleRate = 44100 } = {}) {
    this.sampleRate = sampleRate;
    this.destination = {};
    this._t0 = performance.now();
    this.startCalls = []; // { startAt, currentTimeAtCall } - underrun detection.
  }

  get currentTime() {
    return (performance.now() - this._t0) / 1000;
  }

  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }

  createBuffer(_channels, length, sampleRate) {
    const data = new Float32Array(length);
    return {
      length,
      sampleRate,
      duration: length / sampleRate,
      copyToChannel: (src) => data.set(src),
      getChannelData: () => data,
    };
  }

  createBufferSource() {
    const ctx = this;
    const node = {
      buffer: null,
      onended: null,
      connect() {},
      start(startAt) {
        ctx.startCalls.push({
          startAt,
          currentTimeAtCall: ctx.currentTime,
          duration: node.buffer ? node.buffer.duration : 0,
        });
      },
      stop() {},
    };
    return node;
  }

  async resume() {}
}

// makeTriggerableFrameSource() -> a frameSource whose reported `.lastFrame`
// (see liveEngine.js's renderFrameBatch/nowPlayingTimeline) reflects whatever
// value `trigger()` was most recently called with - the "signal" a caller
// watches for via getNowPlaying() to know when a change became audible.
export function makeTriggerableFrameSource(initialValue = 0) {
  let current = initialValue;
  const frameSource = () => {
    frameSource.lastFrame = { value: current };
    return [];
  };
  frameSource.trigger = (value) => {
    current = value;
  };
  return frameSource;
}

// withPatchedGlobals(overrides, fn) -> runs fn() with the given globalThis
// properties temporarily replaced (AudioContext, fetch, ...), restoring the
// originals (including "was absent before") afterwards no matter how fn()
// exits.
export async function withPatchedGlobals(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = { had: key in globalThis, value: globalThis[key] };
    if (overrides[key] === undefined) {
      delete globalThis[key];
    } else {
      globalThis[key] = overrides[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key].had) {
        globalThis[key] = saved[key].value;
      } else {
        delete globalThis[key];
      }
    }
  }
}

// createEngineForMeasurement(createLiveEngine, wasmJsPath, engineOptions) ->
// a createLiveEngine() instance wired to the real (already-loaded, see each
// test file's own beforeAll) rasterklang-wasm module, driven by a
// FakeAudioContext instead of a real browser one. `fetch` is deliberately
// undefined for the duration of the loadRasterklangModule() call so it falls
// back to a bare `import(wasmJsPath)` of the real sibling-repo build output
// (see liveEngine.js's loadRasterklangModule) - loadWasm() itself
// short-circuits on the pre-populated `globalThis.rasterklangWasm` (see
// rasterklang-wasm/dist/rasterklang.js's own loadWasm()), so no second WASM
// instantiation happens.
export async function createEngineForMeasurement(createLiveEngine, wasmJsPath, engineOptions) {
  let audioContext;
  const engine = await withPatchedGlobals(
    { AudioContext: FakeAudioContext, fetch: undefined },
    () => createLiveEngine({ ...engineOptions, wasmJsURL: wasmJsPath }),
  );
  audioContext = engine.audioContext;
  return { engine, audioContext };
}

// measureTriggerToAudibleLatencyMs({engine, settleMs}) -> real elapsed
// milliseconds from calling frameSource.trigger(1) to the moment
// engine.getNowPlaying() first reports { value: 1 }. `settleMs` is how long to
// let the engine run BEFORE triggering, so the pump loop has reached its
// normal steady-state lookahead queue depth (matching a real note played some
// time after the audition engine was first created, not the atypical "just
// started" transient).
export async function measureTriggerToAudibleLatencyMs({ engine, frameSource, settleMs = 300, timeoutMs = 3000, pollMs = 1 }) {
  await engine.start(frameSource);
  await sleep(settleMs);

  const triggerAt = performance.now();
  frameSource.trigger(1);

  const deadline = triggerAt + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const playing = engine.getNowPlaying();
    if (playing && playing.value === 1) {
      return performance.now() - triggerAt;
    }
    if (performance.now() > deadline) {
      throw new Error(`measureTriggerToAudibleLatencyMs: value=1 never became audible within ${timeoutMs}ms.`);
    }
    await sleep(pollMs);
  }
}

// detectUnderruns(audioContext) -> the subset of consecutive scheduled-buffer
// pairs with an audible GAP between them - i.e. the next buffer's startAt is
// later than the previous buffer's own end time (startAt + duration). This is
// the real glitch signature, not "startAt was in the past": pump()'s own
// `Math.max(scheduledTime, audioContext.currentTime + 0.01)` guard means a
// stale/behind-schedule startAt is always clamped forward to "now" rather
// than ever being handed to Web Audio in the past - so the pump loop falling
// behind never shows up as a past start time, it shows up as exactly this
// kind of gap (silence between one buffer ending and the next one starting).
const GAP_TOLERANCE_SECONDS = 0.001; // sub-millisecond slack for float rounding.
export function detectUnderruns(audioContext) {
  const calls = audioContext.startCalls;
  const gaps = [];
  for (let i = 1; i < calls.length; i += 1) {
    const prevEnd = calls[i - 1].startAt + calls[i - 1].duration;
    const gap = calls[i].startAt - prevEnd;
    if (gap > GAP_TOLERANCE_SECONDS) {
      gaps.push({ ...calls[i], gapSeconds: gap, afterIndex: i - 1 });
    }
  }
  return gaps;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// measureMultipleTriggerLatenciesMs({engine, frameSource, count, gapMs}) ->
// an array of `count` real trigger-to-audible latency measurements against
// the SAME already-started engine/frameSource, alternating the triggered
// value (0/1/0/1/...) so each measurement is a genuine fresh transition.
// Returns every individual sample (sorted ascending) rather than a single
// number - the whole point is letting a caller take a robust statistic
// (median) across several trials instead of trusting one measurement, since
// a single real-time trial can be skewed by a momentary, unrelated spike in
// system load (GC, OS scheduler, a busy CI host) that has nothing to do
// with whether the code under test is correct.
export async function measureMultipleTriggerLatenciesMs({ engine, frameSource, settleMs = 300, count = 5, gapMs = 150, timeoutMs = 3000, pollMs = 1 }) {
  await engine.start(frameSource);
  await sleep(settleMs);

  const samples = [];
  let value = 0;
  for (let i = 0; i < count; i += 1) {
    value = value === 0 ? 1 : 0;
    const triggerAt = performance.now();
    frameSource.trigger(value);

    const deadline = triggerAt + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const playing = engine.getNowPlaying();
      if (playing && playing.value === value) {
        samples.push(performance.now() - triggerAt);
        break;
      }
      if (performance.now() > deadline) {
        throw new Error(`measureMultipleTriggerLatenciesMs: value=${value} never became audible within ${timeoutMs}ms.`);
      }
      await sleep(pollMs);
    }
    await sleep(gapMs);
  }
  return samples.sort((a, b) => a - b);
}

export function median(sortedNumbers) {
  return sortedNumbers[Math.floor(sortedNumbers.length / 2)];
}
