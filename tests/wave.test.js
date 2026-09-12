import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWave } from '../src/wave.js';
import { audioApis } from '../src/win32-audio.js';

function wave(bits = 16, channels = 2) {
  const bytes = new Uint8Array(64),
    view = new DataView(bytes.buffer);
  const put = (offset, text) => bytes.set(new TextEncoder().encode(text), offset);
  put(0, 'RIFF');
  view.setUint32(4, 56, true);
  put(8, 'WAVE');
  put(12, 'JUNK');
  view.setUint32(16, 1, true);
  bytes[20] = 99;
  put(22, 'fmt ');
  view.setUint32(26, 16, true);
  view.setUint16(30, 1, true);
  view.setUint16(32, channels, true);
  view.setUint32(34, 8000, true);
  view.setUint32(38, (8000 * channels * bits) / 8, true);
  view.setUint16(42, (channels * bits) / 8, true);
  view.setUint16(44, bits, true);
  put(46, 'data');
  view.setUint32(50, 8, true);
  if (bits === 16) [-32768, 32767, 0, -8192].forEach((s, i) => view.setInt16(54 + i * 2, s, true));
  else bytes.set([0, 255, 128, 96, 0, 255, 128, 96], 54);
  // RIFF ends after data, not after unused bytes of the backing array.
  view.setUint32(4, 54, true);
  return bytes;
}
test('WAVE decodes exact interleaved PCM and skips odd-sized padded chunks', () => {
  const w = decodeWave(wave());
  assert.equal(w.sampleRate, 8000);
  assert.equal(w.frames, 2);
  assert.deepEqual([...w.samples[0]], [-1, 0]);
  assert.deepEqual([...w.samples[1]], [32767 / 32768, -0.25]);
  assert.deepEqual(
    [...decodeWave(wave(8, 1)).samples[0]],
    [-1, 127 / 128, 0, -0.25, -1, 127 / 128, 0, -0.25],
  );
});
test('WAVE rejects malformed chunk sizes, unsupported formats and incomplete frames', () => {
  for (const [offset, value, width] of [
    [4, 100, 4],
    [16, 100, 4],
    [30, 3, 2],
    [42, 1, 2],
    [50, 7, 4],
  ]) {
    const bytes = wave(),
      view = new DataView(bytes.buffer);
    width === 2 ? view.setUint16(offset, value, true) : view.setUint32(offset, value, true);
    assert.throws(() => decodeWave(bytes));
  }
});
test('PlaySound waits for driver completion and preserves failure; missing files do not play', async () => {
  let complete,
    requested = 0;
  const r = {
    files: new Map([['assets/tone.wav', wave()]]),
    cwd: 'assets/',
    wideString: () => 'tone.wav',
    emit() {},
    request: (kind, data) => {
      assert.equal(kind, 'pcm');
      assert.equal(data.frames, 2);
      requested++;
      return new Promise((resolve) => (complete = resolve));
    },
  };
  let returned = false;
  const pending = audioApis['winmm.dll!PlaySoundW'](r, (i) => [1, 0, 0x20002][i]).then((result) => {
    returned = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(returned, false);
  complete(0);
  assert.deepEqual(await pending, { result: 0, argc: 3 });
  r.wideString = () => '../tone.wav';
  assert.equal((await audioApis['winmm.dll!PlaySoundW'](r, (i) => [1, 0, 0x20002][i])).result, 0);
  assert.equal(requested, 1);
  await assert.rejects(
    () => audioApis['winmm.dll!PlaySoundW'](r, (i) => [1, 0, 0x20003][i]),
    /synchronous/,
  );
});
