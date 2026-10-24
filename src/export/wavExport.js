// WAV (RIFF/PCM) encoder: wraps a flat Int16Array of mono samples in a
// minimal 44-byte header, e.g. to turn a fixed-length offline render
// (liveEngine.js's renderOffline) into a downloadable file. No compression,
// no metadata chunks, just PCM16.

const BYTES_PER_SAMPLE = 2; // 16-bit
const CHANNELS = 1; // mono, matching the live engine's single readChunk() stream

export function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format: 1 = PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNELS * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * BYTES_PER_SAMPLE, samples[i], true);
  }

  return new Uint8Array(buffer);
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
