// ADR 0003 D11 (gate modes: legato/retrigger, hardRestart) and D12
// (slideTo:NOTE), verified at the register level per the ADR's own
// acceptance criteria - never by listening, never by an aggregate score.
import { describe, it, expect } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from '../../src/compiler/compile.js';

function runFrames(source, n) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  const states = [];
  const pokes = [];
  for (let i = 0; i < n; i += 1) {
    const p = frameSource(i);
    pokes.push(p);
    for (const { addr, value } of p) regs[addr] = value;
    states.push(regs.slice());
  }
  return { states, pokes };
}

const voiceFreq = (state, v) => state[v * 7] | (state[v * 7 + 1] << 8);
const controlWritesAt = (run, frame) => run.pokes[frame].filter((p) => p.addr === 4);

// frameObservableOnsets: per-voice count of gate low->high transitions as
// seen by a once-per-frame register sampler (mirrors
// gateRetrigger.test.js's helper - the point of the whole distinction
// between isOnset's same-frame forcedControl pair and a real
// gateReleaseFrames-driven edge).
function frameObservableOnsets(source, frames, voice = 0) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  let count = 0;
  let previousGate = 0;
  for (let i = 0; i < frames; i += 1) {
    for (const { addr, value } of frameSource(i)) regs[addr] = value;
    const gate = regs[voice * 7 + 4] & 0x01;
    if (gate && !previousGate) count += 1;
    previousGate = gate;
  }
  return count;
}

describe('ADR 0003 D11: gate legato', () => {
  const src = (extra) => `tempo 120 beats 4
instrument lead
  wave pulse
  pw 400 420 440 460 480 500 520 540
  ${extra}
end
voice 0 lead "c4 g4"
`;

  it('suppresses the control-register write on a note-to-note transition (no retrigger)', () => {
    const plain = runFrames(src(''), 60);
    const legato = runFrames(src('gate legato'), 60);
    // framesPerCycle is 100 here, so the second note's onset is frame 50.
    expect(controlWritesAt(plain, 50).length).toBeGreaterThan(0);
    expect(controlWritesAt(legato, 50)).toHaveLength(0);
  });

  it('keeps framesSinceOnset running so the pw table does not restart at the boundary', () => {
    // Without legato, pw resets to table index 0 (value 400) at frame 50's
    // onset. With legato, it keeps advancing from wherever it was.
    const plain = runFrames(src(''), 60);
    const legato = runFrames(src('gate legato'), 60);
    const pwAt = (run, frame) => run.states[frame][2] | (run.states[frame][3] << 8);
    expect(pwAt(plain, 50)).toBe(400);
    expect(pwAt(legato, 50)).not.toBe(400);
    expect(pwAt(legato, 50)).toBe(pwAt(legato, 49) + 20 > 540 ? pwAt(legato, 49) : pwAt(legato, 49) + 20);
  });

  it('still lets the pitch change to the new note even while legato', () => {
    const legato = runFrames(src('gate legato'), 60);
    expect(voiceFreq(legato.states[49], 0)).not.toBe(voiceFreq(legato.states[50], 0));
  });

  it('applies based on the INCOMING instrument on an insts-switching voice, not the ending one', () => {
    // Regression: gateModeInst used to read runtime.activeInstrument (the
    // ENDING note's instrument, held from the previous onset) rather than
    // the instrument the switch is INTO - so a voice that switches from a
    // plain instrument onto a `gate legato` one would not suppress the
    // transition it declares, only the one after it.
    const switchInto = (a, b) => `tempo 120 beats 4
instrument plain
  wave pulse
end
instrument legatoInst
  wave pulse
  gate legato
end
voice 0 "c4 g4" insts:"${a} ${b}"
`;
    // c4 (plain) -> g4 (legatoInst): the incoming instrument wants legato,
    // so this transition should now be suppressed.
    const into = runFrames(switchInto('plain', 'legatoInst'), 60);
    expect(controlWritesAt(into, 50)).toHaveLength(0);

    // c4 (legatoInst) -> g4 (plain): the incoming instrument does NOT want
    // legato, so this transition should still retrigger normally, even
    // though the ENDING instrument (legatoInst) does.
    const outOf = runFrames(switchInto('legatoInst', 'plain'), 60);
    expect(controlWritesAt(outOf, 50).length).toBeGreaterThan(0);
  });
});

describe('ADR 0003 D11: gate retrigger', () => {
  it('produces a frame-observable low-to-high edge on every note, including a repeated pitch', () => {
    const source = `tempo 125 beats 4
instrument lead
  wave pulse
  adsr 0 8 8 8
  gate retrigger
end
voice 0 lead
  notes "c4 c4 c4 c4"
end
`;
    // 4 identical-pitch notes over 96 frames (24 frames each) - without
    // retrigger, only the SAME-FRAME forced pair fires (invisible at frame
    // granularity); with it, each onset gets a real 1-frame-low release.
    expect(frameObservableOnsets(source, 96)).toBe(4);
  });

  it('is a no-op observably identical to the default when the same pitch never repeats and no gate is set otherwise', () => {
    // Sanity: retrigger doesn't change PITCH-DIFFERENT-note behavior, only
    // guarantees the edge is real rather than same-frame.
    const source = (mode) => `tempo 125 beats 4
instrument lead
  wave pulse
  adsr 0 8 8 8
  ${mode}
end
voice 0 lead
  notes "c4 d4 e4 f4"
end
`;
    expect(frameObservableOnsets(source('gate retrigger'), 96)).toBe(4);
  });
});

describe('ADR 0003 D11: hardRestart is a spelling of gate -N', () => {
  it('hardRestart 2 is frame-identical to gate -2', () => {
    const src = (field) => `tempo 125 beats 4
instrument lead
  wave pulse
  adsr 0 8 8 8
  ${field}
end
voice 0 lead
  notes "c4 d4 e4 f4"
end
`;
    const a = runFrames(src('gate -2'), 96).states;
    const b = runFrames(src('hardRestart 2'), 96).states;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rejects a non-positive hardRestart', () => {
    const src = `tempo 120 beats 4
instrument lead
  wave pulse
  hardRestart 0
end
voice 0 lead "c4"
`;
    expect(() => compileDslV2Source(src)).toThrow(/positive integer/);
  });

  it('rejects giving gate twice in one instrument block, in any combination', () => {
    // Regression: `gate 0.5` followed by `gate retrigger` used to silently
    // let retrigger win and throw the fraction away with no diagnostic
    // (retrigger forces its own gateReleaseFrames regardless of what an
    // earlier gate/hardRestart already set) - now a named error instead.
    const src = (a, b) => `tempo 120 beats 4
instrument lead
  wave pulse
  ${a}
  ${b}
end
voice 0 lead "c4"
`;
    expect(() => compileDslV2Source(src('gate 0.5', 'gate retrigger'))).toThrow(/already has a 'gate'/);
    expect(() => compileDslV2Source(src('hardRestart 2', 'gate legato'))).toThrow(/already has a 'gate'/);
    expect(() => compileDslV2Source(src('gate legato', 'hardRestart 2'))).toThrow(/already has a 'gate'/);
  });

  it('rejects giving gate: twice as a short-mode inline attribute', () => {
    expect(() => compileDslV2Source('tempo 120 beats 4\nvoice 0 "c4" wave:pulse gate:0.5 gate:0.8\n')).toThrow(
      /already has a 'gate:'/,
    );
  });
});

describe('ADR 0003 D12: slideTo:NOTE', () => {
  const src = (notes, extra = '') => `tempo 120 beats 4
instrument lead
  wave pulse
  slide 0.5
  ${extra}
end
voice 0 lead "${notes}"
`;
  // A separate instrument with NO slide field, to read the target
  // frequency register g4 resolves to, independent of any glide.
  const noSlideSrc = (notes) => `tempo 120 beats 4
instrument lead
  wave pulse
end
voice 0 lead "${notes}"
`;

  it('produces a monotonic frequency ramp reaching the target, with no control write at the transition', () => {
    const noSlide = runFrames(noSlideSrc('c4 g4'), 60);
    const slid = runFrames(src('c4 slideTo:g4'), 60);
    // Plain (no slide field): pitch jumps straight to the target at onset
    // (frame 50).
    const target = voiceFreq(noSlide.states[55], 0);
    expect(voiceFreq(noSlide.states[50], 0)).toBe(target);
    // slideTo: no control-register write at the transition (legato, same
    // as gate legato/tp), and the frequency approaches the target
    // monotonically rather than jumping.
    expect(controlWritesAt(slid, 50)).toHaveLength(0);
    const freqs = [];
    for (let f = 50; f < 60; f += 1) freqs.push(voiceFreq(slid.states[f], 0));
    for (let i = 1; i < freqs.length; i += 1) {
      expect(freqs[i]).toBeGreaterThanOrEqual(freqs[i - 1]);
    }
    expect(freqs[freqs.length - 1]).toBe(target);
  });

  it('rejects an empty slideTo target', () => {
    expect(() => compileDslV2Source(src('c4 slideTo:'))).toThrow(/slideTo/);
  });
});
