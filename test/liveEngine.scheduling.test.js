import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveEngine } from '../src/engine/liveEngine.js';
import { withPatchedGlobals } from './helpers/schedulingLatencyHarness.js';

// createLiveEngine's pump loop against a fake WASM module (a data: URL
// module whose LiveSession returns silence), an AudioContext whose clock the
// test advances by hand, fake timers and a fake document, so throttled
// timers on a locked screen can be simulated exactly.

const FAKE_WASM_MODULE = `data:text/javascript,${encodeURIComponent(`
export async function createRasterklang() {
  return {
    startLive() {
      return { poke() {}, readChunk(n) { return new Int16Array(n); }, stop() {} };
    },
  };
}
`)}`;

class ManualAudioContext {
  constructor({ sampleRate = 44100 } = {}) {
    this.sampleRate = sampleRate;
    this.destination = {};
    this.currentTime = 0;
    this.starts = []; // { startAt, duration }
  }

  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }

  createBuffer(_channels, length, sampleRate) {
    const data = new Float32Array(length);
    return { length, sampleRate, duration: length / sampleRate, copyToChannel: (src) => data.set(src) };
  }

  createBufferSource() {
    const ctx = this;
    const node = {
      buffer: null,
      onended: null,
      connect() {},
      start(startAt) {
        ctx.starts.push({ startAt, duration: node.buffer.duration });
      },
      stop() {},
    };
    return node;
  }

  async resume() {}
}

function createFakeDocument() {
  const listeners = [];
  return {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.push(fn);
    },
    setHidden(hidden) {
      this.visibilityState = hidden ? 'hidden' : 'visible';
      for (const fn of listeners) fn();
    },
  };
}

async function createEngine(options = {}) {
  return withPatchedGlobals(
    { AudioContext: ManualAudioContext, fetch: undefined },
    () => createLiveEngine({ ...options, wasmJsURL: FAKE_WASM_MODULE }),
  );
}

// queuedAhead(ctx) -> seconds of audio scheduled beyond the audio clock.
function queuedAhead(ctx) {
  const last = ctx.starts[ctx.starts.length - 1];
  return last.startAt + last.duration - ctx.currentTime;
}

// advance(ctx, seconds) -> moves the audio clock and fires the pump timer
// once, like a throttled timer that only fires every `seconds`.
async function advance(ctx, seconds) {
  ctx.currentTime += seconds;
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}

describe('createLiveEngine scheduling', () => {
  let fakeDocument;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeDocument = createFakeDocument();
    globalThis.document = fakeDocument;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.document;
  });

  it('keeps the short lookahead while visible', async () => {
    const engine = await createEngine({ scheduleAheadHiddenSeconds: 8 });
    await engine.start(() => []);
    for (let i = 0; i < 20; i += 1) await advance(engine.audioContext, 0.075);
    expect(queuedAhead(engine.audioContext)).toBeLessThan(0.6 + 0.13);
    engine.stop();
  });

  it('fills the hidden lookahead without gaps when timers are throttled', async () => {
    const engine = await createEngine({ scheduleAheadHiddenSeconds: 8 });
    const ctx = engine.audioContext;
    await engine.start(() => []);
    fakeDocument.setHidden(true);
    // a locked iPhone: the timer fires about once per second
    for (let i = 0; i < 10; i += 1) await advance(ctx, 1);
    expect(queuedAhead(ctx)).toBeGreaterThan(7);
    for (let i = 1; i < ctx.starts.length; i += 1) {
      const prevEnd = ctx.starts[i - 1].startAt + ctx.starts[i - 1].duration;
      expect(ctx.starts[i].startAt - prevEnd).toBeLessThan(0.001);
    }
    engine.stop();
  });

  it('renders at most the elapsed time plus the catch-up per tick', async () => {
    const engine = await createEngine({ scheduleAheadHiddenSeconds: 8 });
    const ctx = engine.audioContext;
    await engine.start(() => []);
    const before = queuedAhead(ctx);
    fakeDocument.setHidden(true);
    expect(queuedAhead(ctx) - before).toBeLessThan(1.5 + 0.13);
    engine.stop();
  });

  it('stays at the short lookahead while hidden unless asked', async () => {
    const engine = await createEngine();
    const ctx = engine.audioContext;
    await engine.start(() => []);
    fakeDocument.setHidden(true);
    for (let i = 0; i < 5; i += 1) await advance(ctx, 0.075);
    expect(queuedAhead(ctx)).toBeLessThan(0.6 + 0.13);
    engine.stop();
  });

  it('calls onEnded once the last frame and the tail have been heard', async () => {
    const engine = await createEngine({ scheduleAheadHiddenSeconds: 8 });
    const ctx = engine.audioContext;
    const onEnded = vi.fn();
    // 100 frames = 2 s at 50 fps, ends at startedAt + 2 + 0.7
    await engine.start(() => [], { endFrame: 100, onEnded });
    fakeDocument.setHidden(true);
    const endsAt = engine.startedAt + 2 + 0.7;
    while (ctx.currentTime + 1 < endsAt) await advance(ctx, 1);
    expect(onEnded).not.toHaveBeenCalled();
    await advance(ctx, 1);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(engine.isRunning).toBe(false);
    await advance(ctx, 1);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('can start the next song from onEnded', async () => {
    const engine = await createEngine();
    const ctx = engine.audioContext;
    let next = null;
    await engine.start(() => [], {
      endFrame: 10,
      onEnded: () => {
        next = engine.start(() => []);
      },
    });
    while (!next) await advance(ctx, 0.075);
    await next;
    expect(engine.isRunning).toBe(true);
    expect(engine.frameIndex).toBeGreaterThan(0);
    engine.stop();
  });
});
