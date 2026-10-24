import { describe, expect, it } from 'vitest';
import { song, note } from '../../src/compiler/song.js';
import { Pattern, pure } from '../../src/pattern/query.js';
import { jux } from '../../src/pattern/combinators.js';

describe('song() builder', () => {
  it('defaults beatsPerCycle to 4 and stores tempo', () => {
    const s = song(140);
    expect(s.tempoBPM).toBe(140);
    expect(s.beatsPerCycle).toBe(4);
    expect(s.voices).toEqual([undefined, undefined, undefined]);
  });

  it('defaults startOffsetFrames to 0', () => {
    const s = song(140);
    expect(s.startOffsetFrames).toBe(0);
  });

  it('stores an explicit startOffsetFrames option', () => {
    const s = song(140, { startOffsetFrames: 7 });
    expect(s.startOffsetFrames).toBe(7);
  });

  it('.voice() assigns a chain and is chainable', () => {
    const s = song(120).voice(0, note('c4'));
    expect(s.voices[0]).toBeInstanceOf(Object);
    expect(s.voices[0].notePattern).toBeInstanceOf(Pattern);
  });

  it('note() records the raw mini-notation string as noteSourceText (for editor highlighting)', () => {
    expect(note('c4 e4 g4').noteSourceText).toBe('c4 e4 g4');
  });

  it('note() leaves noteSourceText null when given a Pattern instead of a string', () => {
    expect(note(pure(60)).noteSourceText).toBeNull();
  });

  it('.voice() rejects out-of-range indices', () => {
    const s = song(120);
    expect(() => s.voice(3, note('c4'))).toThrow();
    expect(() => s.voice(-1, note('c4'))).toThrow();
  });

  it('.stack() assigns chains to free voices in order', () => {
    const s = song(120).stack(note('c4'), note('e4'), note('g4'));
    expect(s.voices[0].notePattern.query(0)[0].value).toBe(60);
    expect(s.voices[1].notePattern.query(0)[0].value).toBe(64);
    expect(s.voices[2].notePattern.query(0)[0].value).toBe(67);
  });

  it('.stack() throws when it runs out of free voices', () => {
    const s = song(120).voice(0, note('c4'));
    expect(() => s.stack(note('e4'), note('g4'), note('b4'))).toThrow(/no free/i);
  });

  it('.filter() configures the shared filter chain and is chainable', () => {
    const s = song(120).filter((f) => f.cutoff(1000).resonance(8).mode('lowpass').route(0, 1));
    expect(s.filterChain.cutoffPattern.queryAt(0, 0)).toBe(1000);
    expect(s.filterChain.resonancePattern.queryAt(0, 0)).toBe(8);
    expect(s.filterChain.modePattern.queryAt(0, 0)).toBe('lowpass');
    expect(s.filterChain.routingPattern.queryAt(0, 0)).toEqual({ voice0: true, voice1: true, voice2: false });
  });
});

describe('note() chain', () => {
  it('wraps a constant, a mini-notation string, and a Pattern uniformly', () => {
    const fromString = note('c4 e4');
    expect(fromString.notePattern.query(0).length).toBe(2);

    const fromPattern = note(pure(42));
    expect(fromPattern.notePattern.queryAt(0, 0)).toBe(42);
  });

  it('.s()/.adsr()/.pw()/.sync()/.ring() are chainable and store Patterns', () => {
    const chain = note('c4').s('pulse').adsr(1, 2, 3, 4).pw(1024).sync(true).ring('1 0');
    expect(chain.waveform.queryAt(0, 0)).toBe('pulse');
    expect(chain.attack.queryAt(0, 0)).toBe(1);
    expect(chain.decay.queryAt(0, 0)).toBe(2);
    expect(chain.sustain.queryAt(0, 0)).toBe(3);
    expect(chain.release.queryAt(0, 0)).toBe(4);
    expect(chain.pulseWidth.queryAt(0, 0)).toBe(1024);
    expect(chain.syncPattern.queryAt(0, 0)).toBe(true);
    expect(chain.ringPattern.queryAt(0, 0)).toBe(1);
  });

  it('has sensible defaults when nothing is chained', () => {
    const chain = note('c4');
    expect(chain.waveform.queryAt(0, 0)).toBe('triangle');
    expect(chain.pulseWidth.queryAt(0, 0)).toBe(2048);
    expect(chain.sustain.queryAt(0, 0)).toBe(15);
  });

  it('recognizes a jux()/off() { left, right } pair as a voice-split marker', () => {
    const chain = note(jux((p) => p, pure(60)));
    expect(chain.notePattern.isVoiceSplit).toBe(true);
    expect(chain.notePattern.left).toBeInstanceOf(Pattern);
    expect(chain.notePattern.right).toBeInstanceOf(Pattern);
  });
});
