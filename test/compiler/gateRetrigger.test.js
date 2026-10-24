// The defect this file exists to prevent from ever coming back silently:
// a run of consecutive notes compiling to ONE sustained note.
//
// compile() has always forced a gate-off/gate-on PAIR of pokes on a note
// onset, but both pokes land in the SAME frame. That restarts a
// cycle-accurate emulator's envelope, yet it is completely invisible to
// anything that samples the registers once per frame (a .sid register dump,
// a tool counting gate low->high edges between frames, or a real C64 player
// loop), which sees four notes as one gate onset.
//
// The fix is the absolute-frames gate form, `gate -N` ("hold the gate high
// until this note's last N frames"), which is GoatTracker's per-instrument
// gate-off timer (gplay.c: notes are fetched `gatetimer & 0x3f` ticks early
// and the gate is keyed off there). Importers rely on it, so these tests pin
// the compiler behaviour.
import { describe, it, expect } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from '../../src/compiler/compile.js';

// frameObservableOnsets(source, frames) -> per-voice count of gate low->high
// transitions as seen by a once-per-frame register sampler. Deliberately NOT
// counted off the poke list: the whole point is what a frame-granular
// observer (dump, scorer, player) can actually see.
function frameObservableOnsets(source, frames) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  const counts = [0, 0, 0];
  const previousGate = [0, 0, 0];
  for (let i = 0; i < frames; i += 1) {
    for (const { addr, value } of frameSource(i)) regs[addr] = value;
    for (let v = 0; v < 3; v += 1) {
      const gate = regs[v * 7 + 4] & 0x01;
      if (gate && !previousGate[v]) counts[v] += 1;
      previousGate[v] = gate;
    }
  }
  return counts;
}

// 8 equal notes over 2 cycles: tempo 125 with beats 4 is 96 frames/cycle, so
// each of the 4 steps is a 24-frame note and 192 frames is exactly 2 cycles.
const FOUR_NOTES = 'c4 d4 e4 f4';

function song(instrumentBody) {
  return `tempo 125 beats 4
instrument lead
  wave pulse
  adsr 0 8 8 8
${instrumentBody}end

voice 0 lead
  notes "${FOUR_NOTES}"
end
`;
}

describe('compile: per-note gate retrigger (frame-observable)', () => {
  it('emits one gate onset per note for a run of consecutive notes', () => {
    // The regression assertion: 8 notes in 192 frames -> 8 onsets, not 1.
    expect(frameObservableOnsets(song('  gate -2\n'), 192)[0]).toBe(8);
  });

  it('holds the gate high for exactly all but the last N frames of each note', () => {
    const frameSource = compile(compileDslV2Source(song('  gate -3\n')));
    const regs = new Array(32).fill(0);
    const gates = [];
    for (let i = 0; i < 24; i += 1) {
      for (const { addr, value } of frameSource(i)) regs[addr] = value;
      gates.push((regs[4] & 0x01) === 1);
    }
    // A 24-frame note with `gate -3`: high for frames 0..20, low for 21..23.
    expect(gates.slice(0, 21)).toEqual(new Array(21).fill(true));
    expect(gates.slice(21)).toEqual(new Array(3).fill(false));
  });

  it('measures the release in FRAMES, so a held note keeps its full length', () => {
    // The reason `gate -N` exists at all rather than reusing `gate FRACTION`:
    // GoatTracker's gatetimer is a fixed tick count, so a note four times as
    // long must still lose only N frames. `gate 0.875` would have matched the
    // 24-frame note above and then cut a 96-frame note by 12 frames.
    const source = `tempo 125 beats 4
instrument lead
  wave pulse
  adsr 0 8 8 8
  gate -3
end

voice 0 lead
  notes "c4@4"
end
`;
    const frameSource = compile(compileDslV2Source(source));
    const regs = new Array(32).fill(0);
    const gates = [];
    for (let i = 0; i < 96; i += 1) {
      for (const { addr, value } of frameSource(i)) regs[addr] = value;
      gates.push((regs[4] & 0x01) === 1);
    }
    expect(gates.slice(0, 93)).toEqual(new Array(93).fill(true));
    expect(gates.slice(93)).toEqual(new Array(3).fill(false));
  });

  it('leaves the legato default alone (no gate field = one sustained note)', () => {
    // Deliberate, documented behaviour, not an oversight: DSL v2's default
    // articulation stays legato for live coding and for every hand-written
    // song that predates this. Converters opt in explicitly.
    expect(frameObservableOnsets(song(''), 192)[0]).toBe(1);
    expect(frameObservableOnsets(song('  gate 1\n'), 192)[0]).toBe(1);
  });

  it('takes the gate off whichever instrument an `insts` pattern selects per note', () => {
    // A converted GoatTracker song has no single voice-level instrument - it
    // switches per note through `insts`, so the gate has to be read off the
    // instrument actually sounding, not off the (absent) chain default.
    const source = `tempo 125 beats 4
instrument lead
  wave pulse
  adsr 0 8 8 8
  gate -2
end

voice 0 "c4 d4 e4 f4" insts:"lead"
`;
    expect(frameObservableOnsets(source, 192)[0]).toBe(8);
  });
});
