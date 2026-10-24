// src/compiler/diagnostics.js: everything the editor should be able to
// tell an author about a song, not just the first error that aborted
// compilation.
//
// The messages themselves are rasterklang-dsl's (analyze.js); what is
// tested here is that this repo actually surfaces all of them, in a shape
// the banner can render, for both the compiled and the failed case - which
// is the gap ADR 0001 section 4.2 names as "improved error messages".
import { describe, expect, it } from 'vitest';
import { compareDiagnostics, evaluateWithDiagnostics, formatDiagnostic } from '../../src/compiler/diagnostics.js';
import { compile } from '../../src/compiler/compile.js';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';

function messages(source) {
  return evaluateWithDiagnostics(source).diagnostics.map((d) => `${d.severity}: ${d.message}`);
}

function find(source, needle) {
  return evaluateWithDiagnostics(source).diagnostics.find((d) => d.message.includes(needle));
}

describe('evaluateWithDiagnostics: a song that compiles', () => {
  it('still reports the arrangement period (ADR 0001 D5)', () => {
    const result = evaluateWithDiagnostics(
      'speed 12 beats 8\npattern bass 4 = "c2 d2 e2 f2"\npattern hats 3 = "c6 d6 e6"\nvoice 0 $bass\nvoice 1 $hats\n',
    );
    expect(result.song).not.toBeNull();
    expect(result.error).toBeNull();
    const report = result.diagnostics.find((d) => d.message.startsWith('Arrangement:'));
    expect(report.severity).toBe('info');
    expect(report.message).toContain('Full period: 12 beats');
  });

  it('hints when `beats` looks like a melody-stretch lever (decision 10)', () => {
    // The real authoring session in ADR section 1.1 reached `beats 28`
    // doing exactly this.
    const hint = find('tempo 132 beats 28\nvoice 0 "c4 d4"\n', 'unusual for a time signature');
    expect(hint.severity).toBe('warning');
    expect(hint.line).toBe(1);
    expect(hint.message).toContain('pattern name 28 = ...');
  });

  it('leaves a legal odd time signature alone', () => {
    expect(messages('tempo 120 beats 8\nvoice 0 "c4 d4"\n').join('\n')).not.toContain('unusual for a time signature');
  });

  // ADR 0001 known defect 2's warning (findSpliceRepeatHazards) is deleted
  // as of ADR 0003 D5: $name is a structural reference now, so `$bassA!3`
  // genuinely replicates the WHOLE resolved pattern - the hazard the
  // warning existed for cannot occur anymore, so there is nothing to warn
  // about (see test/dsl/parser.test.js and rasterklang-dsl's own
  // miniNotation.test.js for the replicate-the-whole-pattern behavior
  // itself).
  it('no longer warns about `$name!n` - it replicates the whole pattern, not the last token', () => {
    const source = 'tempo 120 beats 4\npattern bassA = "c2 c2 g2"\nvoice 0 "<$bassA!3 c3>"\n';
    expect(find(source, 'repeats only the LAST token')).toBeUndefined();
  });

  it('warns about a cutoff clipped by the 11-bit register (known defect 4)', () => {
    const warning = find('tempo 120 beats 4\nvoice 0 "c4"\nfilter\n  cutoff sine 900..2600\nend\n', 'clipped to 2047');
    expect(warning.severity).toBe('warning');
    expect(warning.message).toContain('cutoff 2600');
  });
});

describe('evaluateWithDiagnostics: a song that does not compile', () => {
  it('names the actual length next to the declared one (ADR 0001 D1)', () => {
    // The invisible-length-error case from ADR section 1.1: 31 beats where
    // 32 was meant. Silent before 3.0.0; now it says both numbers and the
    // spelling that would fix it.
    const thirtyOne = Array.from({ length: 31 }, () => 'c4').join(' ');
    const result = evaluateWithDiagnostics(`speed 12 beats 8\npattern lead 32 = "${thirtyOne}"\nvoice 0 $lead\n`);
    expect(result.song).toBeNull();
    const error = result.diagnostics.find((d) => d.severity === 'error');
    expect(error.message).toContain('declares 32 beats');
    expect(error.message).toContain('add up to 31 beats');
    expect(error.message).toContain('pattern lead 31 = ...');
  });

  it('reports every problem, not only the one that threw first', () => {
    // A declared-length error AND a cutoff warning in the same file: the
    // banner sees one message, this list sees both, which is the whole
    // reason checkSource() is consulted on the failure path.
    const source = [
      'tempo 120 beats 28',
      'pattern lead 4 = "c4 d4 e4"',
      'voice 0 $lead',
      'filter',
      '  cutoff sine 900..2600',
      'end',
      '',
    ].join('\n');
    const result = evaluateWithDiagnostics(source);
    expect(result.song).toBeNull();
    const kinds = result.diagnostics.map((d) => d.severity);
    expect(kinds).toContain('error');
    expect(kinds).toContain('warning');
    expect(result.diagnostics.some((d) => d.message.includes('declares 4 beats'))).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes('clipped to 2047'))).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes('unusual for a time signature'))).toBe(true);
  });

  it('requires exactly one clock statement, naming which case applies (decision 11)', () => {
    expect(find('voice 0 "c4"\n', 'exactly one clock statement').severity).toBe('error');
    const both = find('tempo 120 beats 4\nspeed 6 beats 4\nvoice 0 "c4"\n', 'mutually exclusive');
    expect(both.severity).toBe('error');
    expect(both.message).toContain('lines 1, 2');
  });

  it('explains that `|>` belongs on a voice, not on a pattern (decision 8)', () => {
    const result = evaluateWithDiagnostics('tempo 120 beats 4\npattern p = "c4" |> slow 4\nvoice 0 $p\n');
    expect(result.song).toBeNull();
    // ANTLR's own "mismatched input '' expecting NEWLINE" must not be what
    // the author sees.
    expect(result.error).not.toContain('mismatched input');
    expect(result.error).toContain('pattern declarations');
  });

  it('always has at least one error diagnostic when it has an error banner', () => {
    // An interpret-time failure the semantic pass cannot see: the list and
    // the banner must not disagree about whether anything went wrong.
    const result = evaluateWithDiagnostics('tempo 120 beats 4\nvoice 0 nosuchinstrument "c4"\n');
    expect(result.error).toBeTruthy();
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('never throws, whatever it is handed', () => {
    for (const source of ['', '@@@', 'voice', 'tempo\n', 'pattern p 4 = "c4 [ d4"\n']) {
      expect(() => evaluateWithDiagnostics(source)).not.toThrow();
    }
  });
});

describe('diagnostic presentation', () => {
  it('orders errors before warnings before info, then by line', () => {
    const sorted = [
      { severity: 'info', line: 1, message: 'i' },
      { severity: 'warning', line: 9, message: 'w9' },
      { severity: 'error', line: 5, message: 'e5' },
      { severity: 'warning', line: 2, message: 'w2' },
      { severity: 'error', line: 3, message: 'e3' },
    ].sort(compareDiagnostics);
    expect(sorted.map((d) => d.message)).toEqual(['e3', 'e5', 'w2', 'w9', 'i']);
  });

  it('leads with the line number, like every other message in this pipeline', () => {
    expect(formatDiagnostic({ severity: 'warning', line: 7, message: 'something' })).toBe('line 7: something');
    expect(formatDiagnostic({ severity: 'info', line: null, message: 'something' })).toBe('something');
  });
});

// ADR 0003 D17: the frame grid is reported, and a misfitting subdivision is
// named rather than left for the author to discover by ear - proven at the
// register level (not just diagnostic text), and confirming the diagnostics
// themselves change no emitted frame.
describe('ADR 0003 D17: frame-grid report and subdivision-misfit warnings', () => {
  it('reports the exact grid for meter 4/4 tempo 120 (matches the ADR\'s own worked example)', () => {
    const msg = find('tempo 120 meter 4/4\nvoice 0 "c4"\n', 'frames/bar');
    expect(msg.severity).toBe('info');
    expect(msg.message).toBe('meter 4/4, tempo 120, PAL 50.00 fps -> 100 frames/bar, 25 frames/beat.');
  });

  it('warns about a 1/16 pattern\'s subdivision jitter, and the suggested speed produces exactly even onset spacing', () => {
    const source = 'tempo 120 meter 4/4\npattern hats each 1/16 = "c6 d6 e6 f6 g6 a6 b6 c7"\nvoice 0 $hats\n';
    const warning = find(source, 'jitter by up to 1 frame');
    expect(warning.severity).toBe('warning');
    const suggested = /`speed (\d+)`/.exec(warning.message)[1];

    const frameSource = compile(compileDslV2Source(`speed ${suggested} beats 4\n${source.split('\n').slice(1).join('\n')}`));
    const base = 0 * 7;
    const spacings = [];
    let prevFreq = null;
    let prevFrame = 0;
    const regs = new Array(32).fill(0);
    for (let i = 0; i < 100; i += 1) {
      for (const { addr, value } of frameSource(i)) regs[addr] = value;
      const freq = regs[base] | (regs[base + 1] << 8);
      if (freq !== prevFreq) {
        if (prevFreq !== null) spacings.push(i - prevFrame);
        prevFreq = freq;
        prevFrame = i;
      }
    }
    expect(new Set(spacings).size).toBe(1); // every onset evenly spaced, no jitter
  });

  it('reports the actual BPM tempo 132 beats 4 plays at (90.909 -> 91 frames/bar rounds the tempo)', () => {
    const msg = find('tempo 132 beats 4\nvoice 0 "c4"\n', 'rounds to 91 frames/bar');
    expect(msg.severity).toBe('warning');
    expect(msg.message).toContain('131.87 BPM');
  });

  it('changes no emitted frame: a song with and without a jitter-triggering pattern compiles identical register output for the parts they share', () => {
    const source = 'tempo 120 meter 4/4\npattern hats each 1/16 = "c6 d6 e6 f6 g6 a6 b6 c7"\nvoice 0 $hats\n';
    const withDiagnostics = evaluateWithDiagnostics(source);
    expect(withDiagnostics.song).not.toBeNull();
    const frameSource = compile(withDiagnostics.song);
    const direct = compile(compileDslV2Source(source));
    for (let i = 0; i < 50; i += 1) {
      expect(frameSource(i)).toEqual(direct(i));
    }
  });
});
