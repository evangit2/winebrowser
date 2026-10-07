import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = JSON.parse(await readFile('tests/fixtures/gdi-alpha/wine-oracle.json', 'utf8'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) =>
      r.apiProvider.get(name.includes('!') ? name : 'gdi32.dll!' + name)(r, (i) => args[i] >>> 0),
    call = (name, ...args) => api(name, ...args).result;
  const bitmap = (w, h, depth = 32, bottomUp = false) => {
    const info = r.allocate(40),
      out = r.allocate(4);
    r.data.fill(0, info, info + 40);
    r.write32(info, 40);
    r.write32(info + 4, w);
    r.write32(info + 8, bottomUp ? h : -h);
    r.view.setUint16(info + 12, 1, true);
    r.view.setUint16(info + 14, depth, true);
    const dc = call('CreateCompatibleDC', 0),
      handle = call('CreateDIBSection', dc, info, 0, out, 0, 0);
    assert.ok(handle);
    call('SelectObject', dc, handle);
    return {
      dc,
      handle,
      bits: r.read32(out),
      width: w,
      height: h,
      depth,
      stride: Math.ceil((w * depth) / 32) * 4,
    };
  };
  return { r, api, call, bitmap };
}
test('msimg32 and GDI native alpha blending match desktop Wine RGB and raw destination-alpha bytes at rounding boundaries', (t) => {
  const { r, api, call, bitmap } = setup(t),
    source = bitmap(2, 2),
    dst = bitmap(4, 4);
  oracle.source.forEach((v, i) => r.write32(source.bits + i * 4, v));
  for (const c of oracle.cases)
    for (const entry of ['msimg32.dll!AlphaBlend', 'gdi32.dll!GdiAlphaBlend']) {
      call('SelectClipRgn', dst.dc, 0);
      for (let i = 0; i < 16; i++) r.write32(dst.bits + i * 4, oracle.destination);
      if (c.clip) {
        const a = call('CreateRectRgn', 0, 0, 3, 4),
          b = call('CreateRectRgn', 1, 1, 2, 3);
        call('CombineRgn', a, a, b, 4);
        call('SelectClipRgn', dst.dc, a);
        call('DeleteObject', a);
        call('DeleteObject', b);
      }
      r.lastError = 777;
      assert.deepEqual(
        api(entry, dst.dc, 0, 0, 4, 4, source.dc, 0, 0, 2, 2, (c.flags << 24) | (c.alpha << 16)),
        { result: c.result, argc: 11 },
      );
      assert.equal(r.lastError, c.error);
      assert.deepEqual(
        c.raw.map((_, i) => r.read32(dst.bits + i * 4)),
        c.raw,
        `${entry}/${c.name}/raw`,
      );
      call('SelectClipRgn', dst.dc, 0);
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          assert.equal(
            call('GetPixel', dst.dc, x, y),
            c.pixels[y * 4 + x],
            `${entry}/${c.name}/${x},${y}`,
          );
    }
});
test('alpha blend rejects invalid function words, bounds and overlapping same-surface rectangles before mutation; zero extents succeed', (t) => {
  const { r, api, call, bitmap } = setup(t),
    source = bitmap(4, 4);
  for (let i = 0; i < 16; i++) r.write32(source.bits + i * 4, oracle.destination);
  const before = r.data.slice(source.bits, source.bits + 64);
  for (const [args, error] of [
    [[source.dc, 0, 0, 2, 2, source.dc, 0, 0, 2, 2, 0x01ff0000], 87],
    [[source.dc, 0, 0, 2, 2, source.dc, -1, 0, 2, 2, 0x01ff0000], 87],
    [[source.dc, 0, 0, -2, 2, source.dc, 0, 0, 2, 2, 0x01ff0000], 87],
    [[source.dc, 0, 0, 2, 2, source.dc, 2, 0, 2, 2, 0x01ff0001], 87],
    [[0xdead, 0, 0, 2, 2, source.dc, 0, 0, 2, 2, 0x01ff0000], 6],
  ]) {
    assert.deepEqual(api('msimg32.dll!AlphaBlend', ...args), { result: 0, argc: 11 });
    assert.equal(r.lastError, error);
    assert.deepEqual(r.data.slice(source.bits, source.bits + 64), before);
  }
  r.lastError = 777;
  for (const [dw, sw] of [
    [0, 2],
    [2, 0],
  ])
    assert.equal(
      call('msimg32.dll!AlphaBlend', source.dc, 0, 0, dw, 2, source.dc, 0, 0, sw, 2, 0x01ff0000),
      1,
    );
  assert.equal(r.lastError, 777);
});

test('24-bit bottom-up source uses opaque alpha for constant blends and rejects pixel alpha before mutation', async (t) => {
  const native = JSON.parse(
    await readFile('tests/fixtures/gdi-alpha/source24-wine-oracle.json', 'utf8'),
  );
  const { r, api, bitmap, call } = setup(t),
    source = bitmap(2, 2, 24, true),
    dst = bitmap(4, 4, 32, true);
  native.source.forEach((v, i) => {
    const at = source.bits + (1 - Math.floor(i / 2)) * source.stride + (i % 2) * 3;
    r.data.set([v & 255, (v >>> 8) & 255, (v >>> 16) & 255], at);
  });
  for (const c of native.cases) {
    for (let i = 0; i < 16; i++) r.write32(dst.bits + i * 4, native.destination);
    r.lastError = 777;
    assert.deepEqual(
      api(
        'msimg32.dll!AlphaBlend',
        dst.dc,
        0,
        0,
        4,
        4,
        source.dc,
        0,
        0,
        2,
        2,
        (c.flags << 24) | (c.alpha << 16),
      ),
      { result: c.result, argc: 11 },
    );
    assert.equal(r.lastError, c.error);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        assert.equal(
          r.read32(dst.bits + (3 - y) * dst.stride + x * 4),
          c.raw[y * 4 + x],
          c.name + '/raw',
        );
        assert.equal(call('GetPixel', dst.dc, x, y), c.pixels[y * 4 + x], c.name + '/RGB');
      }
  }
});
test('source clipping is ignored, clipped destination is bounded, and retained DDB alpha feeds a later pixel blend', (t) => {
  const { r, bitmap, call } = setup(t),
    source = bitmap(2, 2),
    dst = bitmap(4, 4);
  oracle.source.forEach((v, i) => r.write32(source.bits + i * 4, v));
  const clip = call('CreateRectRgn', 0, 0, 0, 0);
  call('SelectClipRgn', source.dc, clip);
  call('DeleteObject', clip);
  for (let i = 0; i < 16; i++) r.write32(dst.bits + i * 4, oracle.destination);
  assert.equal(
    call('msimg32.dll!AlphaBlend', dst.dc, 0, 0, 4, 4, source.dc, 0, 0, 2, 2, 0x01800000),
    1,
  );
  const expected = oracle.cases.find((c) => c.name === 'blend-1-128');
  assert.deepEqual(
    expected.raw.map((_, i) => r.read32(dst.bits + i * 4)),
    expected.raw,
  );
  const bytes = r.data.slice(dst.bits, dst.bits + 64);
  assert.equal(
    call(
      'msimg32.dll!AlphaBlend',
      dst.dc,
      0x7ffffffe,
      0x7ffffffe,
      0x7fffffff,
      0x7fffffff,
      source.dc,
      0,
      0,
      2,
      2,
      0x01800000,
    ),
    1,
  );
  assert.deepEqual(r.data.slice(dst.bits, dst.bits + 64), bytes);
  const input = r.allocate(4);
  r.write32(input, oracle.source[0]);
  const ddb = call('CreateBitmap', 1, 1, 1, 32, input),
    dc = call('CreateCompatibleDC', 0);
  assert.ok(ddb);
  call('SelectObject', dc, ddb);
  assert.equal(
    call('msimg32.dll!AlphaBlend', dc, 0, 0, 1, 1, source.dc, 0, 0, 1, 1, 0x01800000),
    1,
  );
  const firstAlpha =
    Math.floor((128 * 128 + 127) / 255) + Math.floor((128 * (255 - 64) + 127) / 255);
  const copy = call('user32.dll!CopyImage', ddb, 0, 1, 1, 0);
  assert.ok(copy);
  call('SelectObject', dc, copy);
  call('DeleteObject', ddb);
  r.write32(dst.bits, oracle.destination);
  assert.equal(call('msimg32.dll!AlphaBlend', dst.dc, 0, 0, 1, 1, dc, 0, 0, 1, 1, 0x01ff0000), 1);
  const raw = r.read32(dst.bits);
  assert.equal(raw >>> 24, firstAlpha + Math.floor((112 * (255 - firstAlpha) + 127) / 255));
  assert.equal(
    call('GetPixel', dst.dc, 0, 0) & 255,
    20 + Math.floor((64 * (255 - firstAlpha) + 127) / 255),
  );
});
