import { describe, expect, it } from 'vitest';
import { createVoiceClaimManager, arbitrateVoicePokes, NUM_VOICES } from '../src/engine/liveAudition.js';

describe('createVoiceClaimManager', () => {
  it('claims the lowest-numbered free voice when no index is requested', () => {
    const mgr = createVoiceClaimManager();
    expect(mgr.claimVoice()).toBe(0);
    expect(mgr.claimVoice()).toBe(1);
    expect(mgr.claimVoice()).toBe(2);
  });

  it('returns null when every voice is already claimed', () => {
    const mgr = createVoiceClaimManager();
    mgr.claimVoice();
    mgr.claimVoice();
    mgr.claimVoice();
    expect(mgr.claimVoice()).toBeNull();
  });

  it('claims a specific requested voice', () => {
    const mgr = createVoiceClaimManager();
    expect(mgr.claimVoice(1)).toBe(1);
    expect(mgr.isClaimed(1)).toBe(true);
    expect(mgr.isClaimed(0)).toBe(false);
    expect(mgr.isClaimed(2)).toBe(false);
  });

  it('refuses to claim a voice that is already claimed', () => {
    const mgr = createVoiceClaimManager();
    expect(mgr.claimVoice(0)).toBe(0);
    expect(mgr.claimVoice(0)).toBeNull();
  });

  it('frees a voice on release so it can be claimed again', () => {
    const mgr = createVoiceClaimManager();
    mgr.claimVoice(2);
    mgr.releaseVoice(2);
    expect(mgr.isClaimed(2)).toBe(false);
    expect(mgr.claimVoice(2)).toBe(2);
  });

  it('tracks an opaque owner tag per claimed voice', () => {
    const mgr = createVoiceClaimManager();
    mgr.claimVoice(0, 'panel-a');
    expect(mgr.ownerOf(0)).toBe('panel-a');
    expect(mgr.ownerOf(1)).toBeNull();
  });

  it('reports every claimed voice in ascending order', () => {
    const mgr = createVoiceClaimManager();
    mgr.claimVoice(2);
    mgr.claimVoice(0);
    expect(mgr.claimedVoices()).toEqual([0, 2]);
  });

  it('rejects an out-of-range voice index', () => {
    const mgr = createVoiceClaimManager();
    expect(() => mgr.claimVoice(3)).toThrow(/0, 1, or 2/);
    expect(() => mgr.releaseVoice(-1)).toThrow(/0, 1, or 2/);
  });

  it('exposes exactly 3 hardware voices', () => {
    expect(NUM_VOICES).toBe(3);
  });
});

describe('arbitrateVoicePokes (live wins on its claimed voice)', () => {
  it('drops sequenced pokes addressed to the claimed voice\'s own 7 registers', () => {
    // Voice 1's registers are chip-relative 7..13.
    const sequencedPokes = [
      { addr: 4, value: 0x11 }, // voice 0 control - untouched
      { addr: 11, value: 0x41 }, // voice 1 control - claimed, must be dropped
      { addr: 7, value: 0x22 }, // voice 1 freqLo - claimed, must be dropped
      { addr: 0x18, value: 0x0f }, // shared filter/volume - untouched
    ];
    const livePokes = [{ addr: 11, value: 0x21 }];

    const merged = arbitrateVoicePokes(sequencedPokes, 1, livePokes);

    expect(merged).toEqual([
      { addr: 4, value: 0x11 },
      { addr: 0x18, value: 0x0f },
      { addr: 11, value: 0x21 },
    ]);
  });

  it('appends live pokes after the filtered sequenced pokes, so live writes last (and wins)', () => {
    const merged = arbitrateVoicePokes([{ addr: 0, value: 1 }], 0, [{ addr: 0, value: 99 }]);
    expect(merged).toEqual([{ addr: 0, value: 99 }]);
  });

  it('leaves other voices\' registers entirely alone', () => {
    const sequencedPokes = [
      { addr: 0, value: 1 }, // voice 0
      { addr: 14, value: 2 }, // voice 2
    ];
    const merged = arbitrateVoicePokes(sequencedPokes, 1, []);
    expect(merged).toEqual(sequencedPokes);
  });

  it('tolerates empty/undefined poke lists', () => {
    expect(arbitrateVoicePokes([], 0, [])).toEqual([]);
    expect(arbitrateVoicePokes(undefined, 0, undefined)).toEqual([]);
  });
});
