/** Bounded RIFF/WAVE PCM decoder used by the browser audio driver. */
export function decodeWave(bytes) {
  if (bytes.length < 12 || bytes.length > 16 * 1024 * 1024) throw Error('Invalid WAVE size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const end = view.getUint32(4, true) + 8;
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || end < 12 || end > bytes.length)
    throw Error('Invalid RIFF/WAVE container');
  let format, data;
  for (let offset = 12; offset < end;) {
    if (offset + 8 > end) throw Error('Truncated WAVE chunk header');
    const size = view.getUint32(offset + 4, true),
      start = offset + 8;
    if (start + size + (size & 1) > end) throw Error('Truncated WAVE chunk');
    if (tag(offset) === 'fmt ') {
      if (format || size < 16) throw Error('Invalid WAVE format chunk');
      format = {
        encoding: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        byteRate: view.getUint32(start + 8, true),
        blockAlign: view.getUint16(start + 12, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (tag(offset) === 'data') {
      if (data) throw Error('Multiple WAVE data chunks unsupported');
      data = bytes.subarray(start, start + size);
    }
    offset = start + size + (size & 1);
  }
  if (!format || !data) throw Error('Missing WAVE format or data');
  const { encoding, channels, sampleRate, byteRate, blockAlign, bits } = format;
  if (encoding !== 1 || ![1, 2].includes(channels) || ![8, 16].includes(bits))
    throw Error('WAVE supports mono/stereo 8/16-bit PCM only');
  if (
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    blockAlign !== (channels * bits) / 8 ||
    byteRate !== sampleRate * blockAlign ||
    data.length % blockAlign
  )
    throw Error('Inconsistent WAVE PCM format');
  const frames = data.length / blockAlign;
  if (!frames || frames > sampleRate * 10) throw Error('WAVE duration must be 0–10 seconds');
  const samples = Array.from({ length: channels }, () => new Float32Array(frames));
  const pcm = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channels; channel++) {
      const offset = frame * blockAlign + (channel * bits) / 8;
      samples[channel][frame] =
        bits === 8 ? (data[offset] - 128) / 128 : pcm.getInt16(offset, true) / 32768;
    }
  return { sampleRate, samples, frames };
}
