// ADR 0003 D13: table verbs (set/add/wait/loop/stop) as an alternative to
// a bare token row, verified against the ADR's own acceptance criterion:
// the verb form and the equivalent bare row produce byte-identical
// register output.
import { describe, it, expect } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from '../../src/compiler/compile.js';

function pwTrace(source, frames) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  const out = [];
  for (let f = 0; f < frames; f += 1) {
    for (const { addr, value } of frameSource(f)) regs[addr] = value;
    out.push((regs[3] << 8) | regs[2]);
  }
  return out;
}

const SONG = (pwField) => `tempo 120 beats 40
pattern riff 40 = "c4@40"
instrument lead
  wave pulse
${pwField}
end
voice 0 lead $riff
`;

describe('ADR 0003 D13: table verbs', () => {
  it('the verb form and the equivalent bare row + explicit loop point produce byte-identical output', () => {
    const verb = pwTrace(
      SONG(`  pw
    set 400
    add 20 repeat 8
    add -20 repeat 8
    loop
  end`),
      60,
    );
    // The verb form's trailing 'loop' marks position 17 (after all 17
    // entries), which sampleTable() clamps to the last real entry (index
    // 16) - so the bare-row equivalent needs the SAME explicit loop point,
    // not the default loopIndex 0 (which would instead wrap to the start).
    const bare = pwTrace(
      `${SONG('  pw 400 420 440 460 480 500 520 540 560 540 520 500 480 460 440 420 400\n  loop pw 16')}`,
      60,
    );
    expect(verb).toEqual(bare);
    // And it is genuinely a ramp up then down then hold, not a coincidence.
    expect(verb.slice(0, 17)).toEqual([400, 420, 440, 460, 480, 500, 520, 540, 560, 540, 520, 500, 480, 460, 440, 420, 400]);
    expect(verb.slice(17)).toEqual(new Array(43).fill(400));
  });

  it("'wait' holds the current running value for N frames without moving it", () => {
    const verb = pwTrace(
      SONG(`  pw
    set 1000
    wait 3
    add 500
  end`),
      6,
    );
    // 5 entries total (set + 3x wait + add); frame 5 is past the table's
    // own length with no loop verb given, so it wraps to the default
    // loopIndex 0 (today's only pre-D13 behavior), not a hold.
    expect(verb).toEqual([1000, 1000, 1000, 1000, 1500, 1000]);
  });

  it('a table block with no set/add/wait produces no values (error)', () => {
    expect(() => compileDslV2Source(SONG('  pw\n    loop\n  end'))).toThrow(/at least one value/);
  });

  it('an unknown verb name is a clear error', () => {
    expect(() => compileDslV2Source(SONG('  pw\n    bogus 4\n  end'))).toThrow(/unknown table verb 'bogus'/);
  });

  it('combining the loop instrument field with a verb-block loop point on the same table is an error', () => {
    const src = SONG(`  pw
    set 400
    loop
  end
  loop pw 0`);
    expect(() => compileDslV2Source(src)).toThrow(/loop point twice/);
  });
});
