import { describe, expect, it } from 'vitest';
import { buildPsidFromTimeline, frameSourceToTimeline } from '../../src/export/sidExport.js';

function readAscii(bytes, offset, length) {
  let end = length;
  for (let i = 0; i < length; i += 1) {
    if (bytes[offset + i] === 0) {
      end = i;
      break;
    }
  }
  return String.fromCharCode(...bytes.slice(offset, offset + end));
}

describe('frameSourceToTimeline', () => {
  it('calls frameSource sequentially from 0 and flattens each frame\'s pokes', () => {
    const seen = [];
    const frameSource = (index) => {
      seen.push(index);
      return [{ addr: 0x04, value: index }];
    };
    const timeline = frameSourceToTimeline(frameSource, 3);
    expect(seen).toEqual([0, 1, 2]);
    expect(timeline).toEqual([
      { frame: 0, reg: 0x04, value: 0 },
      { frame: 1, reg: 0x04, value: 1 },
      { frame: 2, reg: 0x04, value: 2 },
    ]);
  });

  it('masks addr/value into chip-relative and byte ranges', () => {
    const timeline = frameSourceToTimeline(() => [{ addr: 0xd404, value: 0x140 }], 1);
    expect(timeline).toEqual([{ frame: 0, reg: 0xd404 & 0x1f, value: 0x140 & 0xff }]);
  });

  it('skips frames with no pokes and tolerates a null frameSource', () => {
    expect(frameSourceToTimeline(() => null, 2)).toEqual([]);
    expect(frameSourceToTimeline(null, 2)).toEqual([]);
  });
});

describe('buildPsidFromTimeline', () => {
  const timeline = [
    { frame: 0, reg: 0x00, value: 0x11 },
    { frame: 0, reg: 0x01, value: 0x22 },
    { frame: 5, reg: 0x04, value: 0x21 },
  ];

  it('writes the PSID magic, version 2, and header offsets', () => {
    const bytes = buildPsidFromTimeline(timeline, { title: 'my song', author: 'Rasterklang Cycles' });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(readAscii(bytes, 0, 4)).toBe('PSID');
    expect(view.getUint16(0x04, false)).toBe(2); // version
    expect(view.getUint16(0x06, false)).toBe(0x7c); // dataOffset
    expect(view.getUint16(0x0a, false)).toBe(0x1000); // initAddress
    expect(view.getUint16(0x0c, false)).toBe(0x1020); // playAddress
    expect(view.getUint16(0x0e, false)).toBe(1); // songCount
    expect(view.getUint16(0x10, false)).toBe(1); // defaultSong
  });

  it('writes title/author into the padded header fields', () => {
    const bytes = buildPsidFromTimeline(timeline, { title: 'my song', author: 'Rasterklang Cycles', released: '2026' });
    expect(readAscii(bytes, 0x16, 32)).toBe('my song');
    expect(readAscii(bytes, 0x36, 32)).toBe('Rasterklang Cycles');
    expect(readAscii(bytes, 0x56, 32)).toBe('2026');
  });

  it('embeds the load address as a little-endian word right after the header', () => {
    const bytes = buildPsidFromTimeline(timeline);
    expect(bytes[0x7c]).toBe(0x00);
    expect(bytes[0x7d]).toBe(0x10);
  });

  it('produces a deterministic, non-empty file for an empty timeline (still terminates the event stream)', () => {
    const bytes = buildPsidFromTimeline([], { title: 'empty' });
    expect(bytes.length).toBeGreaterThan(0x7e);
  });

  it('sets PAL/6581 flag bits by default', () => {
    const bytes = buildPsidFromTimeline(timeline, { model: '6581', clock: 'PAL' });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = view.getUint16(0x76, false);
    expect(flags & (1 << 2)).toBeTruthy(); // PAL
    expect(flags & (1 << 4)).toBeTruthy(); // 6581
  });
});
