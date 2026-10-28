// Live SID engine: frame-interleaved poke()/readChunk() against a
// rasterklang-wasm LiveSession, scheduled into Web Audio via lookahead
// AudioBufferSourceNodes.
//
// The live session's chip clock is fixed to PAL 985248Hz. How often the
// frame source is pumped is not: per ADR 0002 a song may declare its own
// drive rate (`target { video NTSC }`, `target { driveCycles 12801 }`, ...),
// which decides how many samples one frame is worth. Callers pass it as
// framesPerSecond (default 50).
// Register addresses passed through frameSource() must be chip-relative
// (0x00-0x1f, i.e. addr - 0xD400), not full $D400+ CPU addresses.

export const PAL_CLOCK_HZ = 985248;
export const FRAME_RATE_HZ = 50;

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_MODEL = '6581';
const DEFAULT_FRAMES_PER_BUFFER = 6; // ~120ms per scheduled AudioBuffer at 50fps
const DEFAULT_SCHEDULE_AHEAD_SECONDS = 0.6;
const DEFAULT_SCHEDULE_INTERVAL_MS = 75;

// Locked screens / hidden tabs: browsers (a locked iPhone in particular)
// throttle the main-thread timer that drives the pump loop, so a 0.6 s
// queue runs dry between ticks and the sound stutters. scheduleAheadHiddenSeconds
// is the lookahead used while document.visibilityState is 'hidden'; it
// defaults to scheduleAheadSeconds (off), because a long queue delays
// setFrameSource() hot-swaps by up to that long. Players of finished songs
// pass a few seconds (e.g. 8). A tick never renders more than the time that
// passed since the previous tick plus CATCH_UP_SECONDS, so the queue grows
// towards the hidden lookahead even when ticks arrive late, without one
// long main-thread block when the page hides.
const CATCH_UP_SECONDS = 1.5;

// Seconds of audio after the last song frame that still count as the song
// (release tails), see start()'s endFrame option.
const DEFAULT_END_TAIL_SECONDS = 0.7;

// Low-latency "audition" scheduling profile - a SEPARATE preset from the
// DEFAULT_* constants above, which stay large on purpose for glitch-free
// SEQUENCED song playback (large lookahead absorbs scheduling jitter at the
// cost of latency, which doesn't matter for a song that was already decided
// in advance). A live-triggered note (keyboard or pattern-preview
// audition) needs the opposite tradeoff: "press a key, hear it now". The
// values below were tuned from wall-clock trigger-to-audible measurements
// against the real WASM engine with a real-time fake AudioContext (see
// test/auditionSchedulingLatency.test.js and
// scripts/measureAuditionLatency.mjs).
//
// AUDITION_FRAMES_PER_BUFFER = 1: the smallest scheduling grain (one PAL
// frame, ~20ms of audio). A poke+readChunk cycle costs a few ms per frame
// (see liveAudition.js's measureFrameCycleCostMs), well under that budget,
// and the total frames rendered per second is the same either way; the
// gain is finer-grained scheduling.
//
// AUDITION_SCHEDULE_AHEAD_SECONDS = 0.05 / AUDITION_SCHEDULE_INTERVAL_MS = 15:
// measured a median trigger-to-audible latency around 40-60ms with no
// scheduling underruns (gaps between consecutive buffers) under idle and
// moderately loaded conditions. A tighter lookahead (0.03-0.04s) had similar
// latency but occasional underruns under main-thread load, so this pairing
// keeps some margin.
export const AUDITION_FRAMES_PER_BUFFER = 1;
export const AUDITION_SCHEDULE_AHEAD_SECONDS = 0.05;
export const AUDITION_SCHEDULE_INTERVAL_MS = 15;

const DEFAULT_WASM_JS_URL = '/wasm/rasterklang.js';
const DEFAULT_WASM_EXEC_URL = '/wasm/wasm_exec.js';
const DEFAULT_WASM_URL = '/wasm/rasterklang.wasm';

// loadRasterklangModule(wasmJsURL) -> the rasterklang.js ES module's
// exports (createRasterklang, RasterklangError, ...).
//
// wasmJsURL points at a plain static file under /public (Vite: "assets in
// the public directory are copied as-is, never processed"). A bare
// `import(/* @vite-ignore */ wasmJsURL)` works fine against a BUILT app
// (vite build/preview serve /public verbatim, so the browser's native
// dynamic import just fetches it) but Vite's DEV server middleware
// specifically refuses to serve a /public file through its module-import
// path with a 500 ("This file is in /public and will be copied as-is
// during build... should not be imported from source code"), which breaks
// callers under `npm run dev`.
//
// Fetching the source as text and importing it from a blob: URL sidesteps
// that guard entirely (blob: URLs never touch Vite's dev middleware) while
// behaving identically to a plain import() once built - same module,
// same export shape, no build-time transform either way. Falls back to
// the bare `import()` if fetch isn't available (e.g. inside a test's
// mocked environment), so unit tests can inject their own wasmJsURL.
async function loadRasterklangModule(wasmJsURL) {
  if (typeof fetch !== 'function') {
    return import(/* @vite-ignore */ wasmJsURL);
  }
  const response = await fetch(wasmJsURL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${wasmJsURL}: ${response.status} ${response.statusText}`);
  }
  const source = await response.text();
  const blob = new Blob([source], { type: 'text/javascript' });
  const blobURL = URL.createObjectURL(blob);
  try {
    return await import(/* @vite-ignore */ blobURL);
  } finally {
    URL.revokeObjectURL(blobURL);
  }
}

// samples-per-frame is derived from the *audio* sample rate and the song's
// declared drive rate, not from the chip clock - the WASM LiveSession
// handles PAL-clock-accurate rendering internally and just needs to be
// asked for `samplesPerFrame` samples once per drive tick.
//
// framesPerSecond defaults to FRAME_RATE_HZ (50).
export function samplesPerFrameFor(sampleRate, framesPerSecond = FRAME_RATE_HZ) {
  const fps = framesPerSecond > 0 ? framesPerSecond : FRAME_RATE_HZ;
  return Math.round(sampleRate / fps);
}

// Pure(ish) frame-batch renderer: pokes+reads `framesPerBuffer` frames
// against `session` (anything with .poke(addr, value) / .readChunk(frames))
// starting at `frameIndex`, and returns the batch as a Float32Array plus the
// next frame index. Kept free of AudioContext/WASM-loading concerns so it's
// directly unit-testable with a fake session.
export function renderFrameBatch({
  frameSource,
  session,
  frameIndex,
  framesPerBuffer,
  samplesPerFrame,
}) {
  const data = new Float32Array(framesPerBuffer * samplesPerFrame);
  // Per-frame snapshot of frameSource.lastFrame (see compile.js), one entry
  // per frame actually rendered in this batch - NOT just the last one.
  // frameSource.lastFrame is overwritten on every call, so it has to be
  // captured (shallow-cloned) right after each individual frameSource(index)
  // call, not read once after the loop. The caller (createLiveEngine's pump
  // loop) is what turns "frame N" into "audible at wall-clock time T", since
  // only it knows the AudioBufferSourceNode's scheduled start time - this
  // function stays audio-context-free and just hands back the raw material.
  const frameSnapshots = [];
  let index = frameIndex;

  for (let f = 0; f < framesPerBuffer; f += 1) {
    const pokes = frameSource ? frameSource(index) : null;
    if (pokes) {
      for (const { addr, value } of pokes) {
        session.poke(addr & 0x1f, value & 0xff);
      }
    }

    if (frameSource && frameSource.lastFrame) {
      frameSnapshots.push({ frameIndex: index, lastFrame: cloneLastFrame(frameSource.lastFrame) });
    }

    const samples = session.readChunk(samplesPerFrame);
    const base = f * samplesPerFrame;
    for (let i = 0; i < samples.length; i += 1) {
      data[base + i] = Math.max(-1, samples[i] / 32768);
    }

    index += 1;
  }

  return { data, nextFrameIndex: index, frameSnapshots };
}

// Shallow-ish clone of compile.js's lastFrame summary (plain data, a couple
// of levels deep - voices[] of plain objects, filter of a plain object) so
// each batched frame's snapshot survives independently of later frames
// overwriting frameSource.lastFrame in place.
function cloneLastFrame(lastFrame) {
  return {
    ...lastFrame,
    voices: Array.isArray(lastFrame.voices) ? lastFrame.voices.map((v) => ({ ...v })) : lastFrame.voices,
    filter: lastFrame.filter ? { ...lastFrame.filter } : lastFrame.filter,
  };
}

// renderOfflineFrames({frameSource, session, frames, samplesPerFrame}) ->
// Int16Array of `frames * samplesPerFrame` raw samples: pokes+reads every
// frame in one non-realtime pass (no AudioBuffer scheduling, no batching -
// nothing here is timed against a wall clock). Pure(ish) counterpart to
// renderFrameBatch, kept free of WASM-loading concerns so it's directly
// unit-testable with a fake session. renderOffline below is the wrapper
// that owns a real WASM session.
export function renderOfflineFrames({ frameSource, session, frames, samplesPerFrame }) {
  const samples = new Int16Array(Math.max(0, frames) * samplesPerFrame);
  for (let index = 0; index < frames; index += 1) {
    const pokes = frameSource ? frameSource(index) : null;
    if (pokes) {
      for (const { addr, value } of pokes) {
        session.poke(addr & 0x1f, value & 0xff);
      }
    }
    samples.set(session.readChunk(samplesPerFrame), index * samplesPerFrame);
  }
  return samples;
}

// renderOffline({frameSource, frames, sampleRate, model}) -> { samples,
// sampleRate }, a fixed-length offline bounce of an otherwise-infinite
// live-coding pattern. Starts its own fresh WASM LiveSession, independent of
// any currently-playing one (createLiveEngine's session), so a download can
// run concurrently with, or instead of, live playback without disturbing it.
export async function renderOffline({
  frameSource,
  frames,
  // ADR 0002: the song's declared play-call rate (compile.js's
  // driveRateOf(song).framesPerSecond). Default 50.
  framesPerSecond = FRAME_RATE_HZ,
  sampleRate = DEFAULT_SAMPLE_RATE,
  model = DEFAULT_MODEL,
  wasmJsURL = DEFAULT_WASM_JS_URL,
  wasmExecURL = DEFAULT_WASM_EXEC_URL,
  wasmURL = DEFAULT_WASM_URL,
} = {}) {
  const mod = await loadRasterklangModule(wasmJsURL);
  const rk = await mod.createRasterklang({ wasmExecURL, wasmURL });
  const session = rk.startLive({ sampleRate, model });
  try {
    const samples = renderOfflineFrames({
      frameSource,
      session,
      frames,
      samplesPerFrame: samplesPerFrameFor(sampleRate, framesPerSecond),
    });
    return { samples, sampleRate };
  } finally {
    session.stop();
  }
}

// pruneTimeline(timeline, cutoff) -> timeline with entries older than cutoff
// (by audibleAt) dropped from the front. Pure/exported so it's directly
// unit-testable without a real AudioContext - see createLiveEngine's
// pruneNowPlayingTimeline wrapper, which just supplies `cutoff`.
export function pruneTimeline(timeline, cutoff) {
  let i = 0;
  while (i < timeline.length - 1 && timeline[i].audibleAt < cutoff) i += 1;
  return i > 0 ? timeline.slice(i) : timeline;
}

// findAudibleFrame(timeline, now) -> the lastFrame of the most recent
// timeline entry whose audibleAt <= now, or null if nothing in the timeline
// is audible yet. Pure/exported for the same reason as pruneTimeline - this
// is the actual "what's playing right now, not what's been computed ahead
// of now" logic getNowPlaying() wraps.
export function findAudibleFrame(timeline, now) {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i].audibleAt <= now) return timeline[i].lastFrame;
  }
  return null;
}

export async function createLiveEngine({
  // ADR 0002: the drive rate the engine pumps frameSource at (default 50).
  // setFrameSource() takes an override so a newly evaluated song with a
  // different `target` block retunes a running engine.
  framesPerSecond = FRAME_RATE_HZ,
  sampleRate = DEFAULT_SAMPLE_RATE,
  model = DEFAULT_MODEL,
  framesPerBuffer = DEFAULT_FRAMES_PER_BUFFER,
  scheduleAheadSeconds = DEFAULT_SCHEDULE_AHEAD_SECONDS,
  scheduleIntervalMs = DEFAULT_SCHEDULE_INTERVAL_MS,
  scheduleAheadHiddenSeconds = scheduleAheadSeconds,
  wasmJsURL = DEFAULT_WASM_JS_URL,
  wasmExecURL = DEFAULT_WASM_EXEC_URL,
  wasmURL = DEFAULT_WASM_URL,
} = {}) {
  const mod = await loadRasterklangModule(wasmJsURL);
  const rk = await mod.createRasterklang({ wasmExecURL, wasmURL });

  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error('This browser does not support Web Audio.');
  }
  const audioContext = new AudioContextCtor({ sampleRate });
  const actualSampleRate = audioContext.sampleRate;

  const session = rk.startLive({ sampleRate: actualSampleRate, model });

  const masterGain = audioContext.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(audioContext.destination);

  let samplesPerFrame = samplesPerFrameFor(actualSampleRate, framesPerSecond);

  let frameSource = null;
  let frameIndex = 0;
  let scheduledTime = 0;
  let startedAt = 0;
  let lastTick = 0;
  let running = false;
  let timerId = null;
  const activeSources = new Set();

  // start()'s endFrame/onEnded: endsAt is the audioContext time at which
  // endFrame plus the release tail has been heard, known once the batch
  // containing endFrame is scheduled.
  let endFrame = null;
  let endTailSeconds = DEFAULT_END_TAIL_SECONDS;
  let onEnded = null;
  let endsAt = null;

  const hasDocument = typeof document !== 'undefined';
  const isHidden = () => hasDocument && document.visibilityState === 'hidden';
  if (hasDocument && scheduleAheadHiddenSeconds > scheduleAheadSeconds) {
    // Fill the long queue right away when the screen locks, before the
    // throttled timer fires.
    document.addEventListener('visibilitychange', () => {
      if (running && isHidden()) pump();
    });
  }

  // now-playing timeline: {audibleAt, lastFrame}[], time-ordered, one entry
  // per rendered frame, tagged with the audioContext time its audio is
  // actually scheduled to start playing (not when it was computed - the
  // pump loop renders up to `scheduleAheadSeconds` ahead of playback by
  // design, for glitch-free scheduling, so "just computed" and "audible
  // right now" are two different points in time). getNowPlaying() reads
  // this against audioContext.currentTime so a UI (e.g. live note
  // highlighting) shows what is actually sounding, not what has been
  // computed ahead of it.
  const frameDurationSeconds = samplesPerFrame / actualSampleRate;
  let nowPlayingTimeline = [];

  function stopScheduling() {
    running = false;
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    for (const source of activeSources) {
      try {
        source.stop();
      } catch {
        // Already stopped/ended.
      }
    }
    activeSources.clear();
  }

  function pump() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (!running) return;
    const now = audioContext.currentTime;
    if (endsAt !== null && now >= endsAt) {
      const ended = onEnded;
      stopScheduling();
      nowPlayingTimeline = [];
      if (ended) ended();
      return;
    }
    const ahead = isHidden() ? scheduleAheadHiddenSeconds : scheduleAheadSeconds;
    const target = Math.min(now + ahead, scheduledTime + (now - lastTick) + CATCH_UP_SECONDS);
    lastTick = now;
    try {
      while (scheduledTime < target) {
        const firstFrame = frameIndex;
        const { data, nextFrameIndex, frameSnapshots } = renderFrameBatch({
          frameSource,
          session,
          frameIndex,
          framesPerBuffer,
          samplesPerFrame,
        });
        frameIndex = nextFrameIndex;

        const buffer = audioContext.createBuffer(1, data.length, actualSampleRate);
        if (typeof buffer.copyToChannel === 'function') {
          buffer.copyToChannel(data, 0);
        } else {
          buffer.getChannelData(0).set(data);
        }

        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(masterGain);
        source.onended = () => activeSources.delete(source);

        const startAt = Math.max(scheduledTime, audioContext.currentTime + 0.01);
        source.start(startAt);
        activeSources.add(source);

        if (endFrame !== null && endsAt === null && nextFrameIndex > endFrame) {
          endsAt = startAt + ((endFrame - firstFrame) * samplesPerFrame) / actualSampleRate + endTailSeconds;
        }

        // Tag each snapshot with the wall-clock (audioContext) time its
        // frame's audio actually starts playing - frame f within this batch
        // starts f frame-durations after the buffer itself starts.
        for (let f = 0; f < frameSnapshots.length; f += 1) {
          nowPlayingTimeline.push({
            audibleAt: startAt + f * frameDurationSeconds,
            lastFrame: frameSnapshots[f].lastFrame,
          });
        }
        nowPlayingTimeline = pruneTimeline(nowPlayingTimeline, audioContext.currentTime - 1);

        scheduledTime = startAt + buffer.duration;
      }
    } catch (error) {
      stopScheduling();
      throw error;
    }
    if (running) {
      timerId = setTimeout(pump, scheduleIntervalMs);
    }
  }

  return {
    audioContext,
    session,
    masterGain,
    samplesPerFrame,

    // Starts (or restarts) playback with the given frameSource. frameIndex
    // resets to 0 and then increases monotonically for this run.
    //
    // For a song of known length pass endFrame (the number of song frames)
    // and onEnded: the engine keeps calling frameSource past endFrame (it
    // should return silence or gate-offs there) until endFrame plus
    // endTailSeconds has actually been heard, then stops and calls
    // onEnded(). The end is taken from the audio clock, not a timer, so it
    // stays right with a long hidden-page queue.
    async start(newFrameSource, options = {}) {
      stopScheduling();
      frameSource = newFrameSource || null;
      frameIndex = 0;
      nowPlayingTimeline = [];
      endFrame = options.endFrame ?? null;
      endTailSeconds = options.endTailSeconds ?? DEFAULT_END_TAIL_SECONDS;
      onEnded = options.onEnded ?? null;
      endsAt = null;
      await audioContext.resume();
      running = true;
      scheduledTime = audioContext.currentTime + 0.06;
      startedAt = scheduledTime;
      lastTick = audioContext.currentTime;
      pump();
    },

    stop() {
      stopScheduling();
      nowPlayingTimeline = [];
    },

    // Hot-swap: reassigns the closure variable the pump loop reads from.
    // Takes effect on the next frame the pump loop renders - it does not
    // reset frameIndex or restart audio. Deliberately does NOT clear
    // nowPlayingTimeline: frames already scheduled under the old frameSource
    // are still what's genuinely audible for the next moment or so, and
    // clearing here would make getNowPlaying() go briefly blank on every
    // edit/evaluate instead of finishing out what's already playing.
    // nextFramesPerSecond (ADR 0002) retunes the frame cadence at the same
    // time, for a re-evaluated song whose `target` block changed. Omitted
    // means unchanged.
    setFrameSource(newFn, nextFramesPerSecond) {
      frameSource = newFn;
      if (nextFramesPerSecond > 0) {
        samplesPerFrame = samplesPerFrameFor(actualSampleRate, nextFramesPerSecond);
      }
    },

    // getNowPlaying() -> the lastFrame snapshot (see compile.js) for
    // whatever's actually audible right now (audioContext.currentTime),
    // NOT the most recently *computed* frame - those differ by up to
    // scheduleAheadSeconds because of lookahead scheduling. Returns null if
    // nothing in the timeline is audible yet (e.g. right after start(),
    // before the first buffer's scheduled time has arrived) or the timeline
    // is empty (not running / no frameSource has produced a lastFrame).
    getNowPlaying() {
      return findAudibleFrame(nowPlayingTimeline, audioContext.currentTime);
    },

    get isRunning() {
      return running;
    },

    get frameIndex() {
      return frameIndex;
    },

    // audioContext time at which frame 0 of the current run starts playing.
    get startedAt() {
      return startedAt;
    },
  };
}
