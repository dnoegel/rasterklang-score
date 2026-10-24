import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../src/export/wavExport.js';

function readAscii(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

describe('encodeWav', () => {
  it('writes a well-formed 44-byte RIFF/WAVE/fmt/data header', () => {
    const samples = new Int16Array([0, 100, -100, 32767, -32768]);
    const bytes = encodeWav(samples, 44100);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(readAscii(bytes, 0, 4)).toBe('RIFF');
    expect(readAscii(bytes, 8, 4)).toBe('WAVE');
    expect(readAscii(bytes, 12, 4)).toBe('fmt ');
    expect(readAscii(bytes, 36, 4)).toBe('data');

    expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample

    const dataSize = samples.length * 2;
    expect(view.getUint32(4, true)).toBe(36 + dataSize);
    expect(view.getUint32(40, true)).toBe(dataSize);
    expect(bytes.length).toBe(44 + dataSize);
  });

  it('round-trips sample values little-endian, including negative numbers', () => {
    const samples = new Int16Array([0, 100, -100, 32767, -32768]);
    const bytes = encodeWav(samples, 44100);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples.length; i += 1) {
      expect(view.getInt16(44 + i * 2, true)).toBe(samples[i]);
    }
  });

  it('produces an empty data chunk for an empty sample array', () => {
    const bytes = encodeWav(new Int16Array([]), 22050);
    expect(bytes.length).toBe(44);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(40, true)).toBe(0);
  });
});
