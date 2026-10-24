// Turns DSL source text into a Song builder object via rasterklang-dsl's
// compileDslV2Source (lexer -> parser -> interpret). Source is never
// evaluated as JavaScript; see rasterklang-dsl's docs/dsl-grammar-spec.md,
// "Why not JS".
//
// compileDslV2Source already throws line-numbered errors, so this module
// only adds a defensive isSongLike() check on the result.

import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';

// isSongLike(x) -> true for the plain object song() builders produce (see
// song.js): duck-typed rather than instanceof-checked since the builder has
// no class/constructor of its own, just a fluent-method-bearing object
// literal.
function isSongLike(x) {
  return (
    x != null &&
    typeof x === 'object' &&
    typeof x.voice === 'function' &&
    typeof x.filter === 'function' &&
    Array.isArray(x.voices)
  );
}

// evaluateSongSource(sourceText) -> Song. Throws a plain Error with a
// message safe to show directly in the editor's error banner - every stage
// of compileDslV2Source (lexer/parser/interpret) already throws a 1-based
// source line number plus a short description, so this function only (1)
// checks the result is song-like and (2) guarantees a plain Error even for
// an unexpected non-Error throw.
export function evaluateSongSource(sourceText) {
  let result;
  try {
    result = compileDslV2Source(sourceText);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (!isSongLike(result)) {
    throw new Error(
      'DSL v2 source must compile to a Song (a `tempo`/`voice`/`filter` program, see docs/dsl-grammar-spec.md in rasterklang-dsl) - ' +
        'got ' + (result === undefined ? 'undefined' : typeof result) + '.',
    );
  }
  return result;
}
