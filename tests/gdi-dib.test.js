import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('tests/fixtures/resource-bitmaps/resource-bitmaps.exe'));
function setup(width = 3, height = 4) {
  const r = new Runtime(iced, { files: new Map([['fixture.exe', exe]]), exe: 'fixture.exe' });
  const call = (name, ...args) => r.apiProvider.get(`gdi32.dll!${name}`)(r, (i) => args[i] >>> 0);
  const dc = r.apiProvider.get('user32.dll!GetDC')(r, () => 0).result;
  const bitmap = call('CreateCompatibleBitmap', dc, width, height).result;
  const info = r.allocate(124 + 1024),
    bits = r.allocate(4096);
  const header = (depth, signedHeight = height, compression = 0, size = 40, w = width) => {
    r.data.fill(0, info, info + 1148);
    r.write32(info, size);
    if (size === 12) {
      [w, signedHeight, 1, depth].forEach((v, i) => r.view.setUint16(info + 4 + i * 2, v, true));
    } else {
      r.write32(info + 4, w);
      r.write32(info + 8, signedHeight);
      r.view.setUint16(info + 12, 1, true);
      r.view.setUint16(info + 14, depth, true);
      r.write32(info + 16, compression);
    }
  };
  const colors = () => {
    const memory = call('CreateCompatibleDC', dc).result;
    const old = call('SelectObject', memory, bitmap).result;
    const result = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => call('GetPixel', memory, x, y).result),
    );
    call('SelectObject', memory, old);
    call('DeleteDC', memory);
    return result;
  };
  return { r, call, dc, bitmap, info, bits, header, colors };
}
test('GetDIBits uses SDK argument order, queries native metadata, and preserves buffer tails', () => {
  const { r, call, dc, bitmap, info, bits, header } = setup();
  header(0);
  r.data.fill(0xcc, info + 40, info + 48);
  assert.deepEqual(call('GetDIBits', dc, bitmap, 0, 4, 0, info, 0), { result: 1, argc: 7 });
  assert.deepEqual(
    [4, 8, 12, 16, 20].map((n) => r.read32(info + n)),
    [3, 4, 0x200001, 0, 48],
  );
  assert.ok(r.data.slice(info + 40, info + 48).every((b) => b === 0xcc));
  assert.equal(call('GetDIBits', bitmap, dc, 0, 4, bits, info, 0).result, 0);
  assert.equal(r.lastError, 6);
  header(0, 4, 0, 12);
  assert.equal(call('GetDIBits', dc, bitmap, 0, 0, 0, info, 0).result, 1);
  assert.deepEqual(
    [4, 6, 8, 10].map((n) => r.view.getUint16(info + n, true)),
    [3, 4, 1, 32],
  );
});
test('Set/GetDIBits handle 16/24/32-bit RGB, row padding, top-down and bottom-up buffers', () => {
  for (const depth of [16, 24, 32])
    for (const topDown of [false, true]) {
      const { r, call, dc, bitmap, info, bits, header, colors } = setup(3, 2);
      header(depth, topDown ? -2 : 2);
      const row =
        depth === 16
          ? [0, 0x7c, 0xe0, 3, 0x1f, 0, 0xcc, 0xcc]
          : depth === 24
            ? [0, 0, 255, 0, 255, 0, 255, 0, 0, 0xcc, 0xcc, 0xcc]
            : [0, 0, 255, 0x77, 0, 255, 0, 0x88, 255, 0, 0, 0x99];
      r.data.set(row, bits);
      r.data.fill(0xff, bits + row.length, bits + row.length * 2);
      assert.equal(call('SetDIBits', dc, bitmap, 0, 2, bits, info, 0).result, 2);
      assert.deepEqual(
        colors(),
        topDown
          ? [
              [0xff, 0xff00, 0xff0000],
              [0xffffff, 0xffffff, 0xffffff],
            ]
          : [
              [0xffffff, 0xffffff, 0xffffff],
              [0xff, 0xff00, 0xff0000],
            ],
      );
      const output = bits + 128;
      r.data.fill(0xcc, output, output + row.length * 2 + 8);
      assert.equal(call('GetDIBits', dc, bitmap, 0, 2, output, info, 0).result, 2);
      const expected = row.slice();
      if (depth === 16) expected.fill(0, 6);
      if (depth === 24) expected.fill(0, 9);
      if (depth === 32) [3, 7, 11].forEach((n) => (expected[n] = 0));
      assert.deepEqual([...r.data.slice(output, output + row.length)], expected);
      assert.ok(
        r.data.slice(output + row.length * 2, output + row.length * 2 + 8).every((v) => v === 0xcc),
      );
    }
});
test('partial top-down scan buffers start at height-count-start, and bottom-up starts at height-1-start', () => {
  for (const topDown of [false, true]) {
    const { r, call, dc, bitmap, info, bits, header, colors } = setup(1, 4);
    header(32, topDown ? -4 : 4);
    r.data.set([0, 0, 255, 0, 0, 255, 0, 0], bits);
    assert.equal(call('SetDIBits', dc, bitmap, 1, 2, bits, info, 0).result, 2);
    assert.deepEqual(colors(), topDown ? [[0], [255], [65280], [0]] : [[0], [65280], [255], [0]]);
    r.data.fill(0xcc, bits + 32, bits + 48);
    assert.equal(call('GetDIBits', dc, bitmap, 1, 2, bits + 32, info, 0).result, 2);
    assert.deepEqual([...r.data.slice(bits + 32, bits + 40)], [0, 0, 255, 0, 0, 255, 0, 0]);
    assert.ok(r.data.slice(bits + 40, bits + 48).every((b) => b === 0xcc));
  }
});
test('input dimensions clip to the target object while partial rows remain anchored to DIB height', () => {
  const { r, call, dc, bitmap, info, bits, header, colors } = setup(2, 4);
  header(24, 6, 0, 40, 3);
  r.data.set([0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0], bits);
  assert.equal(call('SetDIBits', dc, bitmap, 2, 1, bits, info, 0).result, 1);
  assert.deepEqual(colors(), [
    [0, 0],
    [0, 0],
    [0, 0],
    [255, 65280],
  ]);
  assert.equal(call('SetDIBits', dc, bitmap, 6, 1, bits, info, 0).result, 0);
});
test('RGB565 input masks work in INFO/V4 headers; invalid masks fail without modifying pixels', () => {
  for (const size of [40, 108]) {
    const { r, call, dc, bitmap, info, bits, header, colors } = setup(3, 1);
    header(16, 1, 3, size);
    [0xf800, 0x7e0, 0x1f].forEach((v, i) => r.write32(info + 40 + i * 4, v));
    r.data.set([0, 0xf8, 0xe0, 7, 31, 0, 0, 0], bits);
    assert.equal(call('SetDIBits', dc, bitmap, 0, 1, bits, info, 0).result, 1);
    assert.deepEqual(colors(), [[255, 65280, 16711680]]);
    r.write32(info + 44, 0xf800);
    assert.equal(call('SetDIBits', dc, bitmap, 0, 1, bits, info, 0).result, 0);
    assert.equal(r.lastError, 87);
    assert.deepEqual(colors(), [[255, 65280, 16711680]]);
    r.write32(info + 44, 0x7e0);
    assert.equal(call('GetDIBits', dc, bitmap, 0, 1, bits + 32, info, 0).result, 1);
    assert.deepEqual(
      [40, 44, 48].map((n) => r.read32(info + n)),
      [0x7c00, 0x3e0, 0x1f],
    );
    assert.deepEqual([...r.data.slice(bits + 32, bits + 38)], [0, 0x7c, 0xe0, 3, 31, 0]);
  }
});
test('indexed DIB input palettes and packed 1/4/8-bit output round-trip real colors', () => {
  for (const [depth, input, expectedIndices] of [
    [1, [0xa0, 0, 0, 0], [0xa0, 0, 0, 0]],
    [4, [0x01, 0x20, 0, 0], [0x9a, 0xc0, 0, 0]],
    [8, [0, 1, 2, 0], [249, 250, 252, 0]],
  ]) {
    const { r, call, dc, bitmap, info, bits, header, colors } = setup(3, 1);
    header(depth, 1);
    r.write32(info + 32, depth === 1 ? 2 : 3);
    const palette =
      depth === 1
        ? [
            [0, 0, 0, 0],
            [255, 255, 255, 0],
          ]
        : [
            [0, 0, 255, 0],
            [0, 255, 0, 0],
            [255, 0, 0, 0],
          ];
    r.data.set(palette.flat(), info + 40);
    r.data.set(input, bits);
    assert.equal(call('SetDIBits', dc, bitmap, 0, 1, bits, info, 0).result, 1);
    assert.deepEqual(colors(), depth === 1 ? [[0xffffff, 0, 0xffffff]] : [[255, 65280, 16711680]]);
    assert.equal(call('GetDIBits', dc, bitmap, 0, 1, bits + 32, info, 0).result, 1);
    assert.deepEqual([...r.data.slice(bits + 32, bits + 36)], expectedIndices);
    if (depth === 4)
      assert.deepEqual([...r.data.slice(info + 40 + 9 * 4, info + 40 + 10 * 4)], [0, 0, 255, 0]);
  }
});
test('BITMAPCOREINFO uses WORD dimensions and RGB triples', () => {
  const { r, call, dc, bitmap, info, bits, header, colors } = setup(3, 1);
  header(4, 1, 0, 12);
  r.data.set([0, 0, 255, 0, 255, 0, 255, 0, 0], info + 12);
  r.data.set([0x01, 0x20, 0, 0], bits);
  assert.equal(call('SetDIBits', dc, bitmap, 0, 1, bits, info, 0).result, 1);
  assert.deepEqual(colors(), [[255, 65280, 16711680]]);
  assert.equal(call('GetDIBits', dc, bitmap, 0, 1, bits + 32, info, 0).result, 1);
  assert.deepEqual([...r.data.slice(bits + 32, bits + 36)], [0x9a, 0xc0, 0, 0]);
});
test('invalid format, missing DC/bitmap and null buffers fail; omitted palette entries are black', () => {
  const { r, call, dc, bitmap, info, bits, header, colors } = setup(3, 1);
  header(8);
  r.write32(info + 32, 1);
  r.data.set([0, 1, 0, 0], bits);
  assert.equal(call('SetDIBits', dc, bitmap, 0, 1, bits, info, 0).result, 1);
  assert.deepEqual(colors(), [[0, 0, 0]]);
  for (const name of ['GetDIBits', 'SetDIBits']) {
    assert.equal(call(name, 0, bitmap, 0, 1, bits, info, 0).result, 0);
    assert.equal(call(name, dc, 0xdead, 0, 1, bits, info, 0).result, 0);
    assert.equal(call(name, dc, bitmap, 0, 1, bits, info, 2).result, 0);
    header(24, 1, 1);
    assert.equal(call(name, dc, bitmap, 0, 1, bits, info, 0).result, 0);
  }
  header(24);
  assert.equal(call('SetDIBits', dc, bitmap, 0, 1, 0, info, 0).result, 0);
});

test('DIB_PAL_COLORS uses selected logical palette WORD indices and returns packed indices', () => {
  const { r, call, dc, bitmap, info, bits, header, colors } = setup(3, 1);
  const logical = r.allocate(16);
  r.data.set([0, 3, 3, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0], logical);
  const palette = call('CreatePalette', logical).result;
  const stock = call('GetStockObject', 15).result;
  assert.ok(palette && stock);
  assert.equal(call('SelectPalette', dc, palette, 0).result, stock);
  header(4, 1);
  r.write32(info + 32, 3);
  [2, 0, 4].forEach((value, i) => r.view.setUint16(info + 40 + i * 2, value, true));
  r.data.set([0x01, 0x20, 0, 0], bits);
  assert.equal(call('SetDIBits', dc, bitmap, 0, 1, bits, info, 1).result, 1);
  assert.deepEqual(colors(), [[0xff0000, 255, 65280]]);
  assert.equal(call('GetDIBits', dc, bitmap, 0, 1, bits + 32, info, 1).result, 1);
  assert.deepEqual([...r.data.slice(bits + 32, bits + 36)], [0x20, 0x10, 0, 0]);
  assert.deepEqual(
    Array.from({ length: 16 }, (_, i) => r.view.getUint16(info + 40 + i * 2, true)),
    Array.from({ length: 16 }, (_, i) => i),
  );
  assert.equal(call('DeleteObject', palette).result, 0);
  assert.equal(call('SelectPalette', dc, stock, 0).result, palette);
  assert.equal(call('DeleteObject', palette).result, 1);
  assert.equal(call('GetPaletteEntries', stock, 0, 0, 0).result, 20);
  assert.equal(call('SetPaletteEntries', stock, 0, 1, logical + 4).result, 0);
});
