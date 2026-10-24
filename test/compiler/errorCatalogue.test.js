// ADR 0003 D14: a named error catalogue - every listed failure is a
// specific message with the offending text and a suggestion, not a
// generic parse failure. One test per catalogue entry; most of these
// messages predate this ADR (recorded here as evidence they already meet
// the bar), two (invalid note name, ADSR out of range) were added with it.
import { describe, expect, it } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';

const compiles = (src) => () => compileDslV2Source(src);

describe('ADR 0003 D14: named error catalogue', () => {
  it('unknown instrument', () => {
    expect(compiles('tempo 120 beats 4\nvoice 0 bogus "c4"\n')).toThrow(/unknown instrument "bogus"/);
  });

  it('unknown pattern', () => {
    expect(compiles('tempo 120 beats 4\nvoice 0 $bogus\n')).toThrow(/pattern "\$bogus" is not defined/);
  });

  it('unknown table', () => {
    expect(compiles('tempo 120 beats 4\ninstrument lead\n  wave pulse\n  filterTable $bogus\nend\nvoice 0 lead "c4"\n')).toThrow(
      /unknown table '\$bogus'/,
    );
  });

  it('more than 3 voices', () => {
    expect(compiles('tempo 120 beats 4\nvoice 3 "c4"\n')).toThrow(/voice index must be 0, 1, or 2 \(got 3\)/);
  });

  it('invalid note name, with a suggestion for the German-notation false friend', () => {
    expect(compiles('tempo 120 beats 4\nvoice 0 "h4"\n')).toThrow(/invalid note name "h4".*did you mean "b4"/);
  });

  it('invalid note name, generic (no specific suggestion)', () => {
    expect(compiles('tempo 120 beats 4\nvoice 0 "z9"\n')).toThrow(/invalid note name "z9".*a-g/);
  });

  it('invalid note name inside a NAMED pattern declaration, not just an inline voice string', () => {
    // Regression: checkNoteNames used to run only for resolveNotesValueStructural
    // (the inline-voice-string path); the PatternDecl case built pattern/
    // highlightPattern directly and never checked, so a named pattern - the
    // recommended style for anything beyond a one-off - went unchecked.
    expect(compiles('tempo 120 beats 4\npattern bad = "h4"\nvoice 0 $bad\n')).toThrow(
      /invalid note name "h4".*did you mean "b4"/,
    );
  });

  it('invalid note name inside a slideTo: target (ADR 0003 D12)', () => {
    // Regression: the boundary-exclusion charset used to include ':', so
    // the check never looked past 'slideTo:' at all.
    expect(compiles('tempo 120 beats 4\nvoice 0 "slideTo:h4"\n')).toThrow(
      /invalid note name "h4".*did you mean "b4"/,
    );
  });

  it('invalid duration', () => {
    // '/' with no digits at all - miniNotation.js's parseDuration names the
    // position and the legal shape.
    expect(compiles('tempo 120 beats 4\nvoice 0 "c4/x"\n')).toThrow(/[Ee]xpected a duration/);
  });

  it('ADSR value out of 0..15', () => {
    expect(
      compiles('tempo 120 beats 4\ninstrument lead\n  wave pulse\n  adsr 0 20 0 0\nend\nvoice 0 lead "c4"\n'),
    ).toThrow(/adsr's decay value must be an integer 0\.\.15, got 20/);
  });

  it('recursive pattern reference (D4 arrangements)', () => {
    expect(
      compiles('tempo 120 beats 4\npattern loop1 = $loop1\nvoice 0 $loop1\n'),
    ).toThrow(/recursive reference/);
  });

  it('mixed /N and @n in one pattern (D1)', () => {
    expect(compiles('tempo 120 beats 4\nvoice 0 "c4/4 e4@2"\n')).toThrow(/mixes \/N durations.*@N weights/);
  });

  it('proportional auto-fit is reported (D8, info level, not an error)', async () => {
    const { evaluateWithDiagnostics } = await import('../../src/compiler/diagnostics.js');
    const result = evaluateWithDiagnostics('tempo 120 beats 4\nvoice 0 "c4 e4 g4"\n');
    expect(result.song).not.toBeNull();
    const info = result.diagnostics.find((d) => d.message.includes('proportional'));
    expect(info.severity).toBe('info');
  });

  it('cutoff above 2047 is a warning, not silently clamped without saying so (ADR 0001 decision 9)', async () => {
    const { evaluateWithDiagnostics } = await import('../../src/compiler/diagnostics.js');
    const result = evaluateWithDiagnostics('tempo 120 beats 4\nvoice 0 "c4"\nfilter\n  cutoff 3000\n  route 0\nend\n');
    expect(result.song).not.toBeNull();
    const warning = result.diagnostics.find((d) => d.message.includes('clipped'));
    expect(warning.severity).toBe('warning');
    expect(warning.message).toContain('3000');
    expect(warning.message).toContain('2047');
  });
});
