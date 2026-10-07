import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const load = async (name) =>
  JSON.parse(await readFile(`tests/fixtures/gdi-transfer/${name}-wine-oracle.json`, 'utf8'));
const geometry = JSON.parse(await readFile('tests/fixtures/gdi-transfer/wine-oracle.json', 'utf8'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get('gdi32.dll!' + name)(r, (i) => args[i] >>> 0),
    call = (name, ...args) => api(name, ...args).result;
  const info = r.allocate(1064),
    bits = r.allocate(4096),
    out = r.allocate(4),
    dc = call('CreateCompatibleDC', 0);
  const header = (w, h) => {
    r.data.fill(0, info, info + 1064);
    r.write32(info, 40);
    r.write32(info + 4, w);
    r.write32(info + 8, h);
    r.view.setUint16(info + 12, 1, true);
    r.view.setUint16(info + 14, 32, true);
  };
  header(16, -16);
  const handle = call('CreateDIBSection', dc, info, 0, out, 0, 0),
    dst = r.read32(out);
  assert.ok(handle);
  call('SelectObject', dc, handle);
  const reset = () => {
    call('SelectClipRgn', dc, 0);
    for (let i = 0; i < 256; i++) r.write32(dst + i * 4, geometry.destination);
    r.lastError = 777;
  };
  const verify = (c, args, usage = 0) => {
    assert.deepEqual(
      api('SetDIBitsToDevice', dc, ...args, bits, info, usage),
      { result: c.result, argc: 12 },
      c.name + '/return',
    );
    assert.equal(r.lastError, c.error, c.name + '/error');
    const actual = c.raw.map((_, i) => r.read32(dst + i * 4));
    if (actual.some((v, i) => v !== c.raw[i])) {
      const i = actual.findIndex((v, i) => v !== c.raw[i]);
      assert.equal(actual[i], c.raw[i], `${c.name}/raw/${i % 16},${Math.floor(i / 16)}`);
    }
    assert.deepEqual(actual, c.raw, c.name + '/raw');
    call('SelectClipRgn', dc, 0);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        assert.equal(call('GetPixel', dc, x, y), c.pixels[y * 16 + x], `${c.name}/rgb/${x},${y}`);
  };
  return { r, api, call, dc, info, bits, dst, header, reset, verify };
}

test('SetDIBitsToDevice matches native partial scanlines, orientation, crop, clips, return counts and raw alpha', (t) => {
  const { r, call, dc, bits, header, reset, verify } = setup(t);
  for (const c of geometry.cases) {
    header(3, c.signedHeight);
    geometry.source.forEach((v, i) => r.write32(bits + i * 4, v));
    reset();
    if (c.clip) {
      const a = call('CreateRectRgn', 2, 2, 6, 6),
        b = call('CreateRectRgn', 3, 3, 5, 5);
      call('CombineRgn', a, a, b, 4);
      call('SelectClipRgn', dc, a);
      call('DeleteObject', a);
      call('DeleteObject', b);
    }
    verify(c, c.args);
  }
});

test('SetDIBitsToDevice decodes indexed, 555/565, padded RGB and masked source formats against native bytes', async (t) => {
  const { r, info, bits, reset, verify } = setup(t);
  for (const c of (await load('formats')).cases) {
    r.data.set(c.info, info);
    r.data.set(c.bytes, bits);
    reset();
    verify(c, [2, 2, 3, 3, 0, 0, 0, 3], c.usage);
  }
});
test('scanline transfer reads only supplied rows at a guard-page edge, snapshots aliases, and rejects invalid input before paint', (t) => {
  const { r, call, api, dc, info, dst, header, reset } = setup(t);
  header(3, -3);
  reset();
  const allocation = r.virtualMemory.allocate(0, 8192, 0x3000, 4);
  assert.equal(allocation.status, 0);
  const bits = allocation.base + 4096 - 12;
  assert.equal(r.virtualMemory.protect(allocation.base + 4096, 4096, 1).status, 0);
  geometry.source.slice(0, 3).forEach((v, i) => r.write32(bits + i * 4, v));
  assert.equal(call('SetDIBitsToDevice', dc, 2, 2, 3, 3, 0, 0, 0, 1, bits, info, 0), 1);
  for (let i = 0; i < 3; i++)
    assert.equal(r.read32(dst + (4 * 16 + 2 + i) * 4), geometry.source[i]);
  header(16, -16);
  const before = [];
  for (let i = 0; i < 256; i++) {
    const v = 0x80000000 + i * 0x010101;
    before.push(v >>> 0);
    r.write32(dst + i * 4, v);
  }
  assert.equal(call('SetDIBitsToDevice', dc, 1, 1, 15, 2, 0, 14, 14, 2, dst, info, 0), 2);
  for (let y = 1; y < 3; y++)
    for (let x = 1; x < 16; x++)
      assert.equal(r.read32(dst + (y * 16 + x) * 4), before[(y - 1) * 16 + x - 1]);
  const snapshot = r.data.slice(dst, dst + 1024);
  r.write32(info + 16, 1);
  assert.deepEqual(api('SetDIBitsToDevice', dc, 0, 0, 3, 3, 0, 0, 0, 3, bits, info, 0), {
    result: 0,
    argc: 12,
  });
  assert.equal(r.lastError, 87);
  assert.deepEqual(r.data.slice(dst, dst + 1024), snapshot);
  assert.deepEqual(api('SetDIBitsToDevice', 0xdead, 0, 0, 3, 3, 0, 0, 0, 3, bits, info, 0), {
    result: 0,
    argc: 12,
  });
  assert.equal(r.lastError, 6);
});
test('all four native GUI channels reproduce raw bytes and RGB in eight scanline stages', async (t) => {
  const { r, call, dc, info, bits, header, reset, verify } = setup(t),
    formats = (await load('formats')).cases;
  const native = JSON.parse(
    await readFile('tests/fixtures/gdi-transfer/gui-wine-oracle.json', 'utf8'),
  );
  for (const c of native.cases) {
    if (c.panel < 2) {
      header(3, c.panel === 0 ? 3 : -3);
      geometry.source.slice(0, 9).forEach((v, i) => r.write32(bits + i * 4, v));
    } else {
      const fmt = formats.find((v) => v.name === `format-${c.panel === 2 ? 5 : 4}`);
      assert.ok(fmt);
      r.data.set(fmt.info, info);
      r.data.set(fmt.bytes, bits);
    }
    reset();
    if (c.stage === 5) {
      const a = call('CreateRectRgn', 2, 2, 6, 6),
        b = call('CreateRectRgn', 3, 3, 5, 5);
      call('CombineRgn', a, a, b, 4);
      call('SelectClipRgn', dc, a);
      call('DeleteObject', a);
      call('DeleteObject', b);
    }
    const size = c.stage === 4 ? 2 : c.stage === 8 ? 1 : 3,
      origin = c.stage === 4 ? 1 : 0,
      start = c.stage === 3 ? 1 : 0,
      count = c.stage === 2 ? 1 : c.stage === 3 ? 2 : c.stage === 6 ? 5 : c.stage === 7 ? 0 : 3;
    verify(c, [2, 2, size, size, origin, origin, start, count]);
  }
});
