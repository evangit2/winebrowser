import test from 'node:test';
import assert from 'node:assert/strict';
import { mmioApis } from '../src/winmm-mmio.js';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

test('native Windows MMIO/window fixture passes with the public ABI and original import table', async () => {
  const exe = new Uint8Array(await readFile('tests/fixtures/mmio/mmio.exe'));
  const wave = new Uint8Array(await readFile('tests/fixtures/mmio/tone.wav'));
  const events = [];
  const r = new Runtime(iced, {
    files: new Map([
      ['contracts/mmio.exe', exe],
      ['contracts/tone.wav', wave],
    ]),
    exe: 'contracts/mmio.exe',
    emit: (event) => events.push(event),
  });
  try {
    const run = await r.run();
    assert.equal(run.exitCode, 0, JSON.stringify(run));
    assert.equal(r.mmioHandles.size, 0);
    assert.ok(events.some((e) => e.type === 'window' && e.window.minimized));
    assert.ok(events.some((e) => e.type === 'window' && e.operation === 'destroy'));
  } finally {
    r.windows.dispose();
  }
});

const call = (r, name, args) => mmioApis['winmm.dll!' + name](r, (i) => args[i]).result;
const four = (s) => [...s].reduce((n, c, i) => n + c.charCodeAt(0) * 2 ** (8 * i), 0);
function fixture() {
  const payload = Uint8Array.from({ length: 10001 }, (_, i) => i & 255);
  const chunk = (id, bytes) => {
    const out = new Uint8Array(8 + bytes.length + (bytes.length & 1));
    const v = new DataView(out.buffer);
    v.setUint32(0, four(id), true);
    v.setUint32(4, bytes.length, true);
    out.set(bytes, 8);
    return out;
  };
  const chunks = [
    chunk('JUNK', new Uint8Array([1, 2, 3])),
    chunk('fmt ', new Uint8Array(16)),
    chunk('data', payload),
  ];
  const bytes = new Uint8Array(12 + chunks.reduce((n, x) => n + x.length, 0));
  const v = new DataView(bytes.buffer);
  v.setUint32(0, four('RIFF'), true);
  v.setUint32(4, bytes.length - 8, true);
  v.setUint32(8, four('WAVE'), true);
  let at = 12;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  const data = new Uint8Array(1024 * 1024),
    view = new DataView(data.buffer),
    freed = [];
  data.set(new TextEncoder().encode('tone.wav\0'), 128);
  let heap = 16384;
  const r = {
    data,
    cwd: 'audio/',
    files: new Map([['audio/tone.wav', bytes]]),
    freed,
    check(p, n) {
      if (!p || p < 0 || n < 0 || p + n > data.length) throw Error('memory');
    },
    read32: (p) => view.getUint32(p, true),
    write32: (p, n) => view.setUint32(p, n >>> 0, true),
    string(p) {
      let end = p;
      while (data[end]) end++;
      return new TextDecoder().decode(data.subarray(p, end));
    },
    allocate(n) {
      const p = heap;
      heap += n;
      return p;
    },
    free(p) {
      freed.push(p);
    },
  };
  return { r, bytes, payload };
}

test('MMIO RIFF search skips odd padded chunks, reads across buffers and preserves a failed search position', () => {
  const { r, bytes, payload } = fixture();
  const h = call(r, 'mmioOpenA', [128, 0, 0x10000]);
  assert.ok(h);
  r.write32(512 + 8, four('WAVE'));
  assert.equal(call(r, 'mmioDescend', [h, 512, 0, 0x20]), 0);
  assert.deepEqual(
    [0, 4, 8, 12].map((n) => r.read32(512 + n)),
    [four('RIFF'), bytes.length - 8, four('WAVE'), 8],
  );
  assert.equal(call(r, 'mmioSeek', [h, 0, 1]), 12);
  r.write32(600, four('gone'));
  assert.equal(call(r, 'mmioDescend', [h, 600, 512, 0x10]), 265);
  assert.equal(call(r, 'mmioSeek', [h, 0, 1]), 12);
  r.write32(600, four('data'));
  assert.equal(call(r, 'mmioDescend', [h, 600, 512, 0x10]), 0);
  const dataAt = r.read32(612);
  assert.equal(
    call(r, 'mmioRead', [h, 100000, payload.length + 100]),
    payload.length + 1,
    'read includes the file padding byte, not an artificial chunk EOF',
  );
  assert.deepEqual(r.data.slice(100000, 100000 + payload.length), payload);
  assert.equal(call(r, 'mmioRead', [h, 100000, 1]), 0);
  assert.equal(call(r, 'mmioSeek', [h, dataAt, 0]), dataAt);
  assert.equal(call(r, 'mmioAscend', [h, 600, 0]), 0);
  assert.equal(call(r, 'mmioSeek', [h, 0, 1]), bytes.length);
  assert.equal(call(r, 'mmioClose', [h, 0]), 0);
  assert.equal(r.freed.length, 1);
  assert.equal(call(r, 'mmioClose', [h, 0]), 5);
});

test('caller-visible MMIOINFO permits direct byte consumption and validated buffer refills', () => {
  const { r, bytes } = fixture();
  const h = call(r, 'mmioOpenA', [128, 0, 0x10000]);
  r.data.fill(0xa5, 800, 880);
  assert.equal(call(r, 'mmioGetInfo', [h, 800, 0]), 0);
  assert.equal(r.read32(868), h, 'PE32 hmmio field is at offset 68');
  assert.equal(r.read32(872), 0xa5a5a5a5, '72-byte structure does not overwrite its guard');
  assert.equal(call(r, 'mmioAdvance', [h, 800, 0]), 0);
  const buffer = r.read32(824),
    end = r.read32(832);
  assert.equal(end - buffer, 8192);
  assert.deepEqual(r.data.slice(buffer, end), bytes.slice(0, 8192));
  r.write32(828, end);
  assert.equal(call(r, 'mmioSetInfo', [h, 800, 0]), 0);
  assert.equal(call(r, 'mmioSeek', [h, 0, 1]), 8192);
  assert.equal(call(r, 'mmioAdvance', [h, 800, 0]), 0);
  assert.equal(r.read32(840), 8192);
  assert.deepEqual(r.data.slice(buffer, r.read32(832)), bytes.slice(8192));
  r.write32(828, buffer + 8193);
  assert.equal(call(r, 'mmioSetInfo', [h, 800, 0]), 11);
  assert.equal(call(r, 'mmioAdvance', [h, 0, 1]), 262);
  assert.equal(call(r, 'mmioClose', [h, 0]), 0);
});

test('MMIO memory streams, malformed RIFF bounds, invalid modes and handle lifetime remain explicit', () => {
  const { r, bytes } = fixture();
  r.data.set(bytes, 200000);
  r.write32(804, four('MEM '));
  r.write32(820, bytes.length);
  r.write32(824, 200000);
  const h = call(r, 'mmioOpenA', [0, 800, 0]);
  assert.ok(h);
  assert.equal(call(r, 'mmioRead', [h, 500000, 12]), 12);
  assert.deepEqual(r.data.slice(500000, 500012), bytes.slice(0, 12));
  assert.equal(call(r, 'mmioClose', [h, 0]), 0);
  assert.deepEqual(r.freed, [], 'caller-owned memory is not freed');
  const malformed = bytes.slice();
  new DataView(malformed.buffer).setUint32(4, 0xffffffff, true);
  r.files.set('audio/tone.wav', malformed);
  const bad = call(r, 'mmioOpenA', [128, 0, 0]);
  r.write32(608, four('WAVE'));
  assert.equal(call(r, 'mmioDescend', [bad, 600, 0, 0x20]), 272);
  assert.equal(call(r, 'mmioSeek', [bad, 0, 1]), 0);
  assert.equal(call(r, 'mmioAdvance', [bad, 0, 0]), 266);
  assert.equal(call(r, 'mmioSeek', [bad, -1, 0]), 0xffffffff);
  assert.equal(call(r, 'mmioRead', [bad, 0, -1]), 0xffffffff);
  assert.equal(call(r, 'mmioOpenA', [128, 800, 1]), 0);
  assert.equal(r.read32(812), 259);
  assert.equal(call(r, 'mmioGetInfo', [0, 800, 0]), 5);
});
