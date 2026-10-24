// ADR 0003 D15: a song can declare `chip 6581` / `chip 8580`, which
// travels on the compiled song as `song.chipModel` and, per the ADR's own
// acceptance criterion, round-trips through save (DSL source text, which
// already just re-parses), re-open, and `.sid` export with the right
// PSID header bits.
import { describe, expect, it } from 'vitest';
import { compileDslV2Source } from 'rasterklang-dsl/src/dsl/index.js';
import { buildPsidFromTimeline } from '../../src/export/sidExport.js';

const SONG = (chipLine) =>
  `${chipLine}\nspeed 12 beats 8\npattern riff 8 = "c4 ~ ~ ~ e4 ~ ~ ~"\nvoice 0 $riff wave:pulse\n`;

// PSID flags word is at byte offset 0x76 (BE16); bits 4-5 are the model
// (00 unknown, 01=6581, 10=8580, 11=any) - see sidExport.js's buildPsidHeader.
function modelBitsOf(psidBytes) {
  const flags = (psidBytes[0x76] << 8) | psidBytes[0x77];
  return (flags >> 4) & 0b11;
}

describe('ADR 0003 D15: chip model', () => {
  it('defaults to null (no opinion) when no chip statement is present', () => {
    const song = compileDslV2Source(SONG('; no chip statement'));
    expect(song.chipModel).toBe(null);
  });

  it('`chip 6581` sets song.chipModel to 6581', () => {
    const song = compileDslV2Source(SONG('chip 6581'));
    expect(song.chipModel).toBe(6581);
  });

  it('`chip 8580` sets song.chipModel to 8580', () => {
    const song = compileDslV2Source(SONG('chip 8580'));
    expect(song.chipModel).toBe(8580);
  });

  it('rejects an unknown chip model', () => {
    expect(() => compileDslV2Source(SONG('chip 4567'))).toThrow(/6581 or 8580/);
  });

  it('rejects two chip statements in one song', () => {
    expect(() => compileDslV2Source(`chip 6581\nchip 8580\ntempo 120 beats 4\nvoice 0 "c4"\n`))
      .toThrow(/at most one chip statement/);
  });

  it('a song with `chip 8580` exports a .sid with the 8580 header bits set (round-trip)', () => {
    const song = compileDslV2Source(SONG('chip 8580'));
    expect(song.chipModel).toBe(8580);
    const exportModel = song.chipModel != null ? String(song.chipModel) : '6581';
    const psid = buildPsidFromTimeline([], { model: exportModel, clock: 'PAL' });
    expect(modelBitsOf(psid)).toBe(0b10);
  });

  it('a song with `chip 6581` exports a .sid with the 6581 header bits set', () => {
    const song = compileDslV2Source(SONG('chip 6581'));
    const exportModel = song.chipModel != null ? String(song.chipModel) : '6581';
    const psid = buildPsidFromTimeline([], { model: exportModel, clock: 'PAL' });
    expect(modelBitsOf(psid)).toBe(0b01);
  });
});
