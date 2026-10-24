// evaluateSong.js turns DSL source text into a Song via rasterklang-dsl's
// compileDslV2Source, turning every way that can go wrong into a plain,
// UI-safe Error message.

import { describe, expect, it } from 'vitest';
import { evaluateSongSource } from '../../src/compiler/evaluateSong.js';
import { compile } from '../../src/compiler/compile.js';

describe('evaluateSongSource', () => {
  it('compiles a DSL v2 script to a Song, with tempo/voice/filter all recognized', () => {
    const source = [
      'tempo 120 beats 4',
      'voice 0 "c4 e4" wave:pulse',
      'filter',
      '  cutoff sine 200..2000',
      '  mode   lowpass',
      '  route  0',
      'end',
    ].join('\n');
    const result = evaluateSongSource(source);
    expect(result.tempoBPM).toBe(120);
    expect(result.voices[0]).toBeTruthy();
    // Sanity: the returned Song actually compiles to a working frameSource.
    expect(() => compile(result)(0)).not.toThrow();
  });

  it('supports pipelines (rev/every/etc.) on a voice\'s note pattern', () => {
    const source = ['tempo 140 beats 4', 'voice 0 "c2 e2 g2 a2" |> every 2 rev'].join('\n');
    const result = evaluateSongSource(source);
    expect(result.voices[0].notePattern.query(0).length).toBe(4);
  });

  it('supports named patterns ($name) declared with `pattern`', () => {
    const source = ['tempo 120 beats 4', 'pattern hook = "c4 e4 g4"', 'voice 0 $hook'].join('\n');
    const result = evaluateSongSource(source);
    expect(result.voices[0].notePattern.query(0)).toHaveLength(3);
  });

  it('throws a clear, line-numbered error for a syntax mistake (e.g. a missing `end`)', () => {
    const source = ['tempo 120 beats 4', 'voice 0', '  notes "c4"'].join('\n');
    expect(() => evaluateSongSource(source)).toThrow(/line \d+/i);
  });

  it('throws a clear error for a semantic mistake inside the script (e.g. an unknown instrument reference)', () => {
    expect(() => evaluateSongSource('tempo 120 beats 4\nvoice 0 nope\n  notes "c4"\nend')).toThrow(/unknown instrument/i);
  });

  it('throws a clear error when the source has no `tempo` statement at all', () => {
    expect(() => evaluateSongSource('voice 0 "c4"')).toThrow(/tempo/i);
  });
});
