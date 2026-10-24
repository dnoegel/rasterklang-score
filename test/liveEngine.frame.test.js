import { describe, expect, it } from 'vitest';
import {
  renderFrameBatch,
  renderOfflineFrames,
  samplesPerFrameFor,
  FRAME_RATE_HZ,
  pruneTimeline,
  findAudibleFrame,
} from '../src/engine/liveEngine.js';

// A fake LiveSession that just records poke() calls and returns deterministic
// "samples" from readChunk() (session.pokeRegister/etc. are not exercised
// here - this is pure JS logic, no WASM/audio required).
function createFakeSession() {
  const pokeLog = [];
  const readLog = [];
  return {
    pokeLog,
    readLog,
    poke(addr, value) {
      pokeLog.push({ addr, value });
    },
    readChunk(frames) {
      readLog.push(frames);
      // Return a ramp so we can tell frames apart in the output buffer.
      const out = new Int16Array(frames);
      for (let i = 0; i < frames; i += 1) out[i] = 100;
      return out;
    },
  };
}

describe('samplesPerFrameFor', () => {
  it('computes samples-per-frame at 44100Hz', () => {
    expect(samplesPerFrameFor(44100)).toBe(Math.round(44100 / 50));
  });

  it('computes samples-per-frame at 48000Hz', () => {
    expect(samplesPerFrameFor(48000)).toBe(Math.round(48000 / 50));
  });

  it('computes samples-per-frame at 22050Hz', () => {
    expect(samplesPerFrameFor(22050)).toBe(Math.round(22050 / 50));
  });

  it('uses a fixed 50fps PAL frame rate', () => {
    expect(FRAME_RATE_HZ).toBe(50);
  });
});

describe('renderFrameBatch', () => {
  it('calls frameSource once per frame with sequential frame indices', () => {
    const session = createFakeSession();
    const seenIndices = [];
    const frameSource = (frameIndex) => {
      seenIndices.push(frameIndex);
      return [];
    };

    const { nextFrameIndex } = renderFrameBatch({
      frameSource,
      session,
      frameIndex: 10,
      framesPerBuffer: 6,
      samplesPerFrame: 882,
    });

    expect(seenIndices).toEqual([10, 11, 12, 13, 14, 15]);
    expect(nextFrameIndex).toBe(16);
  });

  it('preserves poke ordering within a frame and across frames', () => {
    const session = createFakeSession();
    const frameSource = (frameIndex) => [
      { addr: 0x04, value: frameIndex },
      { addr: 0x00, value: frameIndex * 2 },
    ];

    renderFrameBatch({
      frameSource,
      session,
      frameIndex: 0,
      framesPerBuffer: 3,
      samplesPerFrame: 10,
    });

    expect(session.pokeLog).toEqual([
      { addr: 0x04, value: 0 },
      { addr: 0x00, value: 0 },
      { addr: 0x04, value: 1 },
      { addr: 0x00, value: 2 },
      { addr: 0x04, value: 2 },
      { addr: 0x00, value: 4 },
    ]);
  });

  it('masks poke addr/value into chip-relative and byte ranges', () => {
    const session = createFakeSession();
    const frameSource = () => [{ addr: 0xd404, value: 0x140 }];

    renderFrameBatch({
      frameSource,
      session,
      frameIndex: 0,
      framesPerBuffer: 1,
      samplesPerFrame: 10,
    });

    expect(session.pokeLog).toEqual([{ addr: 0xd404 & 0x1f, value: 0x140 & 0xff }]);
  });

  it('reads samplesPerFrame samples per frame and fills the output buffer in order', () => {
    const session = createFakeSession();
    const { data } = renderFrameBatch({
      frameSource: () => [],
      session,
      frameIndex: 0,
      framesPerBuffer: 4,
      samplesPerFrame: 5,
    });

    expect(session.readLog).toEqual([5, 5, 5, 5]);
    expect(data.length).toBe(20);
    // Fake session returns raw int 100 for every sample -> 100/32768 normalized.
    expect(data[0]).toBeCloseTo(100 / 32768, 6);
    expect(data[19]).toBeCloseTo(100 / 32768, 6);
  });

  it('captures one frameSnapshot per frame, not just the last one', () => {
    // frameSource.lastFrame is mutated in place after every call (see
    // compile.js) - renderFrameBatch has to clone it per-frame or every
    // snapshot in the batch would end up identical (whatever the final
    // frame's value happened to be).
    const session = createFakeSession();
    const frameSource = (frameIndex) => {
      frameSource.lastFrame = { tag: `frame-${frameIndex}` };
      return [];
    };

    const { frameSnapshots } = renderFrameBatch({
      frameSource,
      session,
      frameIndex: 5,
      framesPerBuffer: 3,
      samplesPerFrame: 10,
    });

    expect(frameSnapshots.map((s) => s.frameIndex)).toEqual([5, 6, 7]);
    expect(frameSnapshots.map((s) => s.lastFrame.tag)).toEqual(['frame-5', 'frame-6', 'frame-7']);
  });

  it('clones lastFrame\'s nested voices/filter so later mutation of the original does not affect earlier snapshots', () => {
    const session = createFakeSession();
    const frameSource = (frameIndex) => {
      frameSource.lastFrame = {
        voices: [{ noteName: `note-${frameIndex}` }],
        filter: { cutoffRaw: frameIndex },
      };
      return [];
    };

    const { frameSnapshots } = renderFrameBatch({
      frameSource,
      session,
      frameIndex: 0,
      framesPerBuffer: 2,
      samplesPerFrame: 10,
    });

    expect(frameSnapshots[0].lastFrame.voices[0].noteName).toBe('note-0');
    expect(frameSnapshots[0].lastFrame.filter.cutoffRaw).toBe(0);
    expect(frameSnapshots[1].lastFrame.voices[0].noteName).toBe('note-1');
  });

  it('produces no frameSnapshots when frameSource has no lastFrame (e.g. the hardcoded test-scale pattern)', () => {
    const session = createFakeSession();
    const { frameSnapshots } = renderFrameBatch({
      frameSource: () => [],
      session,
      frameIndex: 0,
      framesPerBuffer: 3,
      samplesPerFrame: 10,
    });
    expect(frameSnapshots).toEqual([]);
  });

  it('tolerates a null frameSource (no pokes, still reads audio)', () => {
    const session = createFakeSession();
    expect(() =>
      renderFrameBatch({
        frameSource: null,
        session,
        frameIndex: 0,
        framesPerBuffer: 2,
        samplesPerFrame: 4,
      }),
    ).not.toThrow();
    expect(session.pokeLog).toEqual([]);
    expect(session.readLog).toEqual([4, 4]);
  });
});

describe('renderOfflineFrames', () => {
  it('calls frameSource once per frame with sequential indices from 0', () => {
    const session = createFakeSession();
    const seenIndices = [];
    const frameSource = (frameIndex) => {
      seenIndices.push(frameIndex);
      return [];
    };

    renderOfflineFrames({ frameSource, session, frames: 4, samplesPerFrame: 10 });

    expect(seenIndices).toEqual([0, 1, 2, 3]);
  });

  it('pokes each frame\'s registers, masked into chip-relative/byte ranges, before reading that frame\'s audio', () => {
    const session = createFakeSession();
    const frameSource = (frameIndex) => [{ addr: 0xd404, value: frameIndex }];

    renderOfflineFrames({ frameSource, session, frames: 2, samplesPerFrame: 5 });

    expect(session.pokeLog).toEqual([
      { addr: 0xd404 & 0x1f, value: 0 },
      { addr: 0xd404 & 0x1f, value: 1 },
    ]);
    expect(session.readLog).toEqual([5, 5]);
  });

  it('concatenates every frame\'s samples in order into one flat Int16Array', () => {
    const session = createFakeSession();
    const samples = renderOfflineFrames({ frameSource: () => [], session, frames: 3, samplesPerFrame: 5 });
    expect(samples.length).toBe(15);
    expect(Array.from(samples)).toEqual(new Array(15).fill(100)); // fake session's readChunk always returns 100
  });

  it('tolerates a null frameSource (no pokes, still reads audio)', () => {
    const session = createFakeSession();
    expect(() => renderOfflineFrames({ frameSource: null, session, frames: 2, samplesPerFrame: 4 })).not.toThrow();
    expect(session.pokeLog).toEqual([]);
    expect(session.readLog).toEqual([4, 4]);
  });
});

// findAudibleFrame()/pruneTimeline() are the fix for the "highlight is ahead
// of the sound" bug: the pump loop computes frames up to scheduleAheadSeconds
// (0.6s) before they're actually audible, so "the most recently computed
// frame" and "what's playing right now" are genuinely different points in
// time. getNowPlaying() (createLiveEngine) is a thin wrapper around these two
// pure functions over a real AudioContext's currentTime; these tests cover
// the actual selection logic without needing one.
describe('findAudibleFrame', () => {
  const timeline = [
    { audibleAt: 1.0, lastFrame: { tag: 'a' } },
    { audibleAt: 1.5, lastFrame: { tag: 'b' } },
    { audibleAt: 2.0, lastFrame: { tag: 'c' } },
  ];

  it('returns the most recent entry whose audibleAt has already passed', () => {
    expect(findAudibleFrame(timeline, 1.6).tag).toBe('b');
    expect(findAudibleFrame(timeline, 1.99).tag).toBe('b');
    expect(findAudibleFrame(timeline, 2.0).tag).toBe('c');
  });

  it('does not return a frame that has been computed but is not audible yet', () => {
    // "now" here represents audioContext.currentTime, e.g. still mid-lookahead
    // for entry 'c' (audibleAt 2.0) - a naive "just take the last computed
    // entry" implementation would wrongly return 'c' here.
    expect(findAudibleFrame(timeline, 1.9).tag).toBe('b');
  });

  it('returns null when nothing in the timeline is audible yet', () => {
    expect(findAudibleFrame(timeline, 0.5)).toBeNull();
  });

  it('returns null for an empty timeline', () => {
    expect(findAudibleFrame([], 5)).toBeNull();
  });
});

describe('pruneTimeline', () => {
  it('drops entries older than the cutoff, keeping at least the most recent one', () => {
    const timeline = [
      { audibleAt: 1.0, lastFrame: { tag: 'a' } },
      { audibleAt: 1.5, lastFrame: { tag: 'b' } },
      { audibleAt: 2.0, lastFrame: { tag: 'c' } },
    ];
    const pruned = pruneTimeline(timeline, 1.6);
    expect(pruned.map((e) => e.lastFrame.tag)).toEqual(['c']);
  });

  it('keeps the whole timeline if nothing is older than the cutoff', () => {
    const timeline = [
      { audibleAt: 1.0, lastFrame: { tag: 'a' } },
      { audibleAt: 1.5, lastFrame: { tag: 'b' } },
    ];
    expect(pruneTimeline(timeline, 0.5)).toEqual(timeline);
  });

  it('never empties the timeline entirely, even if every entry is older than the cutoff', () => {
    // findAudibleFrame still needs a most-recent fallback entry to compare
    // against; pruning down to zero entries would make "audible now" briefly
    // report null right after a long pause even though something is playing.
    const timeline = [
      { audibleAt: 1.0, lastFrame: { tag: 'a' } },
      { audibleAt: 1.5, lastFrame: { tag: 'b' } },
    ];
    expect(pruneTimeline(timeline, 10).length).toBe(1);
  });
});
