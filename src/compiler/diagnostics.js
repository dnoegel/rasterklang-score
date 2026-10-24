// One place that turns editor source text into "here is the song, and here
// is everything worth telling the author about it".
//
// A single thrown error is not enough feedback: since DSL 3.0.0 (ADR 0001)
// there are rules that are neither grammatical nor fatal, such as a declared
// length that disagrees with its contents, an arrangement whose true period
// is worth stating, the known defects in ADR 0001 section 6, or the
// `beats`-as-stretch-lever migration hint.
//
// rasterklang-dsl already produces them, in two shapes this module unifies:
//  - a successful compile hangs its non-fatal diagnostics on the returned
//    builder as `.dslDiagnostics`,
//  - `checkSource(text)` runs the same semantic pass WITHOUT the pattern
//    engine and returns everything, errors included, so a failed compile
//    can still report more than the one error that happened to throw first.
import { checkSource } from 'rasterklang-dsl/src/dsl/index.js';
import { evaluateSongSource } from './evaluateSong.js';

// A diagnostic is { severity: 'error' | 'warning' | 'info', line, message }.
// Ordered worst-first so a banner that shows a few of them shows the ones
// that matter; ties keep source order, which is how the author reads.
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

export function compareDiagnostics(a, b) {
  const bySeverity = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
  return bySeverity !== 0 ? bySeverity : (a.line ?? 0) - (b.line ?? 0);
}

// formatDiagnostic(d) -> the one-line string a banner shows. The line
// number leads, because every other error message in this pipeline already
// leads with it and an author scanning a list wants the location first.
export function formatDiagnostic(d) {
  return d.line ? `line ${d.line}: ${d.message}` : d.message;
}

// evaluateWithDiagnostics(sourceText) -> { song, diagnostics, error }.
//
// Never throws. `song` is null when the source did not compile, and
// `error` then carries the message the compiler threw. `diagnostics` is
// populated either way: on failure it comes from checkSource(), so the
// author sees every problem the semantic pass found rather than only the
// first one to abort compilation.
export function evaluateWithDiagnostics(sourceText) {
  try {
    const song = evaluateSongSource(sourceText);
    const diagnostics = [...(song.dslDiagnostics ?? [])].sort(compareDiagnostics);
    return { song, diagnostics, error: null };
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    let diagnostics = [];
    try {
      diagnostics = checkSource(sourceText).sort(compareDiagnostics);
    } catch {
      // checkSource() already converts a lex/parse failure into a
      // diagnostic rather than throwing, so reaching here means something
      // genuinely unexpected broke. The thrown message below is still
      // shown, so nothing is lost by giving up on the list.
      diagnostics = [];
    }
    // A compile that threw for a reason the semantic pass cannot see (an
    // interpret-time error such as an unknown instrument name) would
    // otherwise show an empty list next to a filled banner. Restate it as
    // a diagnostic so the two views never disagree.
    if (!diagnostics.some((d) => d.severity === 'error')) {
      diagnostics = [{ severity: 'error', line: lineOf(error), message: stripLinePrefix(error) }, ...diagnostics];
    }
    return { song: null, diagnostics, error };
  }
}

function lineOf(message) {
  const m = /^line (\d+): /.exec(message);
  return m ? Number(m[1]) : 1;
}

function stripLinePrefix(message) {
  return message.replace(/^line \d+: /, '');
}
