// A rest after a note on a voice with `insts` keeps the last instrument, as
// in a tracker: its tables run on while the envelope releases. Dropping it
// fell back to the chain's waveform (triangle by default) at the last
// frequency, so a noise drum pinned to a high pitch rang on as a beep.
import { describe, it, expect } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { compile } from '../../src/compiler/compile.js';

function runFrames(source, n) {
  const frameSource = compile(compileDslV2Source(source));
  const regs = new Array(32).fill(0);
  const states = [];
  for (let i = 0; i < n; i += 1) {
    for (const { addr, value } of frameSource(i)) regs[addr] = value;
    states.push(regs.slice());
  }
  return states;
}

const SONG = `tempo 120 beats 4

instrument kick
  wave pulse
  arp =36
  adsr 0 8 0 0
  gate -1
end

instrument snare
  wave noise pulse noise
  arp =92 =57 =84
  loop wave 2 arp 2
  adsr 0 0 14 9
  gate -1
end

voice 0 kick
  notes "c4 c4 ~ ~"
  insts "kick snare ~ ~"
end
`;

describe('rests keep the last instrument', () => {
  it('a rest after a noise snare stays noise, never the triangle fallback', () => {
    const states = runFrames(SONG, 100);
    // beats 3-4 (frames 50-99) are the rest after the snare
    const waves = states.slice(50).map((s) => s[4] & 0xf0);
    expect(waves.filter((w) => w === 0x10)).toEqual([]);
    expect(waves.every((w) => w === 0x80)).toBe(true);
  });

  it('the table clock runs on in the rest instead of restarting the table', () => {
    // one instrument, no insts: it already stayed in rests, but its tables
    // restarted at the first rest frame and replayed the onset
    const song = SONG.replace(/voice 0 kick\n[^]*$/, 'voice 0 snare\n  notes "c4 ~ ~ ~"\nend\n');
    const states = runFrames(song, 100);
    const pulseBody = states[1][0] | (states[1][1] << 8);
    const rest = states.slice(25);
    expect(rest.map((s) => s[0] | (s[1] << 8))).not.toContain(pulseBody);
    expect(rest.every((s) => (s[4] & 0xf0) === 0x80)).toBe(true);
  });
});
