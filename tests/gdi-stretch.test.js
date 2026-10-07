import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const load = async (name) =>
  JSON.parse(await readFile(`tests/fixtures/gdi-stretch/${name}-wine-oracle.json`, 'utf8'));
const geometry = JSON.parse(await readFile('tests/fixtures/gdi-stretch/wine-oracle.json', 'utf8'));
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
      api('StretchDIBits', dc, ...args, bits, info, usage, c.rop ?? 0x00cc0020),
      { result: c.result, argc: 13 },
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
test('StretchDIBits matches native Wine orientation, signed source/destination extents, clipping and 32-bit raster operations', (t) => {
  const { r, call, dc, bits, header, reset, verify } = setup(t);
  const errors = [];
  for (const c of geometry.cases) {
    header(3, c.signedHeight);
    call('SetStretchBltMode', dc, c.mode);
    geometry.source.forEach((v, i) => r.write32(bits + i * 4, v));
    reset();
    if (c.clip) {
      const a = call('CreateRectRgn', 3, 3, 13, 14),
        b = call('CreateRectRgn', 6, 6, 10, 10);
      call('CombineRgn', a, a, b, 4);
      call('SelectClipRgn', dc, a);
      call('DeleteObject', a);
      call('DeleteObject', b);
    }
    try {
      verify(c, c.args);
    } catch (e) {
      errors.push(e.message);
    }
  }
  assert.deepEqual(errors, []);
});
test('StretchDIBits decodes native indexed, packed 555/565, padded RGB and swapped-mask formats', async (t) => {
  const { r, info, bits, reset, verify } = setup(t);
  for (const c of (await load('formats')).cases) {
    r.data.set(c.info, info);
    r.data.set(c.bytes, bits);
    reset();
    verify(c, [2, 2, 12, 12, 0, 0, 3, 3], c.usage);
  }
});
test('StretchDIBits native BLACKONWHITE, WHITEONBLACK, COLORONCOLOR and HALFTONE square and non-square scaling', async (t) => {
  const { r, call, dc, bits, header, reset, verify } = setup(t);
  header(3, -3);
  for (const c of (await load('modes')).cases) {
    call('SetStretchBltMode', dc, c.mode);
    c.source.forEach((v, i) => r.write32(bits + i * 4, v));
    reset();
    verify(c, [2, 2, c.width, c.height, 0, 0, 3, 3]);
  }
});
test('scaling modes are owned by each DC, survive Save/Restore and reject invalid settings before mutation', (t) => {
  const { r, api, call, dc } = setup(t),
    other = call('CreateCompatibleDC', 0);
  assert.equal(call('GetStretchBltMode', dc), 1);
  assert.equal(call('SetStretchBltMode', dc, 2), 1);
  const saved = call('SaveDC', dc);
  assert.equal(call('SetStretchBltMode', dc, 4), 2);
  assert.equal(call('GetStretchBltMode', other), 1);
  for (const mode of [0, 5, -1]) {
    r.lastError = 777;
    assert.deepEqual(api('SetStretchBltMode', dc, mode), { result: 0, argc: 2 });
    assert.equal(r.lastError, 87);
    assert.equal(call('GetStretchBltMode', dc), 4);
  }
  assert.equal(call('RestoreDC', dc, saved), 1);
  assert.equal(call('GetStretchBltMode', dc), 2);
  assert.deepEqual(api('SetStretchBltMode', 0xdead, 1), { result: 0, argc: 2 });
  assert.equal(r.lastError, 6);
  assert.deepEqual(api('GetStretchBltMode', 0xdead), { result: 0, argc: 1 });
  assert.equal(r.lastError, 6);
});
test('aliased input is snapshotted before paint and preserved 32-bit bytes feed later alpha blending', (t) => {
  const { r, call, api, dc, dst, info, header, reset } = setup(t);
  header(16, -16);
  reset();
  const before = [];
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const value = ((y * 17) << 24) | ((x * 13) << 16) | ((y * 11) << 8) | ((x + y) * 7);
      before.push(value >>> 0);
      r.write32(dst + (y * 16 + x) * 4, value);
    }
  assert.equal(call('StretchDIBits', dc, 2, 2, 12, 12, 4, 0, 12, 12, dst, info, 0, 0x00cc0020), 16);
  for (let y = 2; y < 14; y++)
    for (let x = 2; x < 14; x++)
      assert.equal(
        r.read32(dst + (y * 16 + x) * 4),
        before[(y - 2 + 4) * 16 + x - 2 + 4],
        `aliased/${x},${y}`,
      );
  const another = call('CreateCompatibleDC', 0),
    out = r.allocate(4),
    target = call('CreateDIBSection', another, info, 0, out, 0, 0),
    targetBits = r.read32(out);
  assert.ok(target);
  call('SelectObject', another, target);
  r.write32(targetBits, 0x40000000);
  assert.equal(call('GdiAlphaBlend', another, 0, 0, 1, 1, dc, 1, 1, 1, 1, 0x01ff0000), 1);
  assert.equal(r.read32(targetBits), 0x4d0d0b0e);
  const snapshot = r.data.slice(dst, dst + 1024);
  assert.deepEqual(api('StretchDIBits', dc, 0, 0, 2, 2, 0, 0, 3, 3, dst, info, 0, 0x12345678), {
    result: 0,
    argc: 13,
  });
  assert.equal(r.lastError, 120);
  assert.deepEqual(r.data.slice(dst, dst + 1024), snapshot);
});
test('huge clipped destinations visit only visible pixels and malformed later inputs do not partially paint', (t) => {
  const { r, call, api, dc, dst, info, bits, header, reset } = setup(t);
  header(3, -3);
  geometry.source.forEach((v, i) => r.write32(bits + i * 4, v));
  reset();
  assert.equal(
    call('StretchDIBits', dc, 0, 0, 0x7fffffff, 0x7fffffff, 0, 0, 3, 3, bits, info, 0, 0x00cc0020),
    3,
  );
  for (let i = 0; i < 256; i++) assert.equal(r.read32(dst + i * 4), geometry.source[0]);
  const before = r.data.slice(dst, dst + 1024);
  r.write32(info + 16, 1);
  assert.equal(call('StretchDIBits', dc, 0, 0, 16, 16, 0, 0, 3, 3, bits, info, 0, 0x00cc0020), 0);
  assert.equal(r.lastError, 87);
  assert.deepEqual(r.data.slice(dst, dst + 1024), before);
  r.write32(info + 16, 0);
  assert.deepEqual(
    api('StretchDIBits', 0xdead, 0, 0, 16, 16, 0, 0, 3, 3, bits, info, 0, 0x00cc0020),
    { result: 0, argc: 13 },
  );
  assert.equal(r.lastError, 6);
});

test('native mode return values and empty/outside-source transfers preserve LastError without painting', async (t) => {
  const { r, call, dc, info, bits, dst, header, reset } = setup(t);
  header(3, -3);
  reset();
  const before = r.data.slice(dst, dst + 1024);
  for (const c of (await load('settings')).cases) {
    r.lastError = 777;
    if (c.type === 'mode') {
      assert.equal(call('SetStretchBltMode', dc, c.value), c.result);
      assert.equal(r.lastError, c.error);
      assert.equal(call('GetStretchBltMode', dc), c.mode);
    } else {
      assert.equal(call('StretchDIBits', dc, ...c.args, bits, info, 0, 0x00cc0020), c.result);
      assert.equal(r.lastError, c.error);
      assert.deepEqual(r.data.slice(dst, dst + 1024), before);
    }
  }
});
