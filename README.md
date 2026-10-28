# rasterklang-score

The music engine behind the rasterklang language for the C64 SID chip. It
turns a song (written in the [rasterklang-dsl](https://github.com/dnoegel/rasterklang-dsl)
language) into the per-frame stream of SID register writes that a SID
emulator or a real chip plays.

> **Status: research project.** This is experimental code from an ongoing
> exploration of how to write SID music as text. The language, the APIs and
> the output format change without notice, there are no releases with
> compatibility guarantees, and parts of it exist only to support
> experiments. Use it to read, learn from or play with, not as a stable
> dependency.

## What's here

- **`src/pattern/`**: a small pattern algebra in the spirit of
  TidalCycles/Strudel (independently implemented): mini-notation parsing,
  combinators (`rev`, `every`, `ply`, `degradeBy`, ...), continuous signals
  and scales, all deterministic and SID-agnostic.
- **`src/compiler/`**: the song model and the compiler from a song to SID
  register writes per frame (instruments, wave/pulse/filter tables, gate
  handling, arpeggios, vibrato, multispeed and NTSC drive rates).
- **`src/engine/`**: live playback and low-latency note audition on top of a
  WebAssembly SID emulator (the emulator itself is not part of this
  package).
  `engine/iosAudio.js` makes that playback audible on iPhones with the
  silent switch on and after autoplay or call interruptions.
- **`src/export/`**: `.sid` (PSID v2 with a register-dump replay routine) and
  `.wav` export.

## Example

```js
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from 'rasterklang-score/compiler/compile.js';

const song = compileDslV2Source(`
tempo 120 meter 4/4

instrument lead
  wave pulse
  adsr 0 9 6 4
  pw   2048
end

voice 0 lead
  notes "c4/4 e4/4 g4/4 <c5 b4>/4"
end
`);

const frameSource = compile(song);
// Call frameSource(0), frameSource(1), ... in order: each call returns the
// SID register writes for that frame.
```

## Installing

There is no npm release. Install from GitHub together with the language
package (the two depend on each other):

```sh
npm install github:dnoegel/rasterklang-dsl github:dnoegel/rasterklang-score
```

Modules are imported by path: `rasterklang-score/pattern/*`,
`rasterklang-score/compiler/*`, `rasterklang-score/engine/*`,
`rasterklang-score/export/*`.

## Development

The tests expect a checkout of `rasterklang-dsl` next to this one:

```sh
git clone https://github.com/dnoegel/rasterklang-dsl.git
git clone https://github.com/dnoegel/rasterklang-score.git
cd rasterklang-score && npm install && npm test
```

The audition latency tests measure against a real build of the WebAssembly
emulator in a sibling `rasterklang-wasm/dist` directory and are skipped when
it is not there.

## License

MIT, see [LICENSE](LICENSE).
