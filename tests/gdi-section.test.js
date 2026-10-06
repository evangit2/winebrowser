import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('tests/fixtures/resource-bitmaps/resource-bitmaps.exe'));
function setup(depth = 32, height = -3, width = 3, compression = 0) {
  const r = new Runtime(iced, { files: new Map([['fixture.exe', exe]]), exe: 'fixture.exe' });
  const call = (name, ...args) => r.apiProvider.get('gdi32.dll!' + name)(r, (i) => args[i] >>> 0);
  const info = r.allocate(1064),
    output = r.allocate(96);
  r.data.fill(0, info, info + 1064);
  r.write32(info, 40);
  r.write32(info + 4, width);
  r.write32(info + 8, height);
  r.view.setUint16(info + 12, 1, true);
  r.view.setUint16(info + 14, depth, true);
  r.write32(info + 16, compression);
  if (compression === 3) [0xf800, 0x7e0, 0x1f].forEach((v, i) => r.write32(info + 40 + i * 4, v));
  if (depth <= 8)
    for (let i = 0; i < 1 << depth; i++)
      r.data.set(i === 0 ? [0, 0, 0, 0] : [255, 255, 255, 0], info + 40 + i * 4);
  const section = call('CreateDIBSection', 0, info, 0, output, 0, 0);
  assert.equal(section.argc, 6);
  assert.ok(section.result);
  const bitmap = section.result,
    bits = r.read32(output),
    stride = Math.ceil((width * depth) / 32) * 4;
  const dc = call('CreateCompatibleDC', 0).result,
    old = call('SelectObject', dc, bitmap).result;
  assert.ok(bits && old);
  return { r, call, info, output, bitmap, bits, stride, dc, old };
}
test('DIBSECTION PE32 layout, short queries and private committed memory match the SDK', () => {
  const { r, call, info, output, bitmap, bits, stride, dc, old } = setup(24, -3, 3);
  const input = r.data.slice(info, info + 40);
  assert.equal(call('GetObjectW', bitmap, 0, 0).result, 24);
  for (const size of [0, 1, 23, 24, 80, 84, 96]) {
    r.data.fill(0xcc, output, output + 96);
    const count = size < 24 ? 0 : size < 84 ? 24 : 84;
    assert.equal(call('GetObjectA', bitmap, size, output).result, count);
    assert.ok(r.data.slice(output + count, output + 96).every((v) => v === 0xcc));
    if (count)
      assert.deepEqual(
        [4, 8, 12, 20].map((n) => r.read32(output + n)),
        [3, 3, stride, bits],
      );
    if (count === 84) {
      assert.equal(r.view.getUint16(output + 18, true), 24);
      assert.deepEqual(
        [24, 28, 32, 36, 40, 44, 76, 80].map((n) => r.read32(output + n)),
        [40, 3, 3, 0x180001, 0, 0, 0, 0],
      );
    }
  }
  assert.deepEqual(
    r.data.slice(info, info + 40),
    input,
    'creation does not mutate caller metadata',
  );
  const query = r.apiProvider.get('kernel32.dll!VirtualQuery')(r, (i) => [bits, output, 28][i]);
  assert.equal(query.result, 28);
  assert.deepEqual(
    [0, 4, 8, 12, 16, 20, 24].map((n) => r.read32(output + n)),
    [bits, bits, 4, 4096, 0x1000, 4, 0x20000],
  );
  assert.equal(call('DeleteObject', bitmap).result, 0, 'selected objects stay alive');
  call('SelectObject', dc, old);
  assert.equal(call('DeleteObject', bitmap).result, 1);
  assert.equal(r.guestMemory.writeObservers.length, 0);
  assert.throws(() => r.check(bits, 1), /violation/);
});
test('native BGR/BGRA/packed rows and guest stores reach GDI in both scan orders', () => {
  for (const depth of [1, 4, 8, 16, 24, 32])
    for (const topDown of [false, true]) {
      const { r, call, bits, stride, dc } = setup(depth, topDown ? -3 : 3);
      const row = bits;
      const y = topDown ? 0 : 2;
      const data =
        depth === 1
          ? [0xa0, 0, 0, 0]
          : depth === 4
            ? [0x10, 0x10, 0, 0]
            : depth === 8
              ? [1, 0, 1, 0]
              : depth === 16
                ? [0, 0x7c, 0xe0, 3, 31, 0, 0, 0]
                : depth === 24
                  ? [0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0]
                  : [0, 0, 255, 0x33, 0, 255, 0, 0x44, 255, 0, 0, 0x55];
      r.check(row, data.length, true);
      r.data.set(data, row);
      assert.deepEqual(
        [0, 1, 2].map((x) => call('GetPixel', dc, x, y).result),
        depth <= 8 ? [0xffffff, 0, 0xffffff] : [255, 65280, 16711680],
      );
      assert.equal(call('GetPixel', dc, 0, 1).result, 0);
      assert.equal(call('GetPixel', dc, 0, topDown ? 2 : 0).result, 0);
      // Scalar CPU stores are also observed after the region-cache fast path.
      r.guestMemory.write(row, 0, 1);
      assert.equal(
        call('GetPixel', dc, 0, y).result,
        depth === 16 ? 255 : depth === 1 ? 0 : depth === 4 ? 0 : depth === 8 ? 0 : 255,
      );
    }
});

test('VirtualQuery shares actual NT protection/type results and never writes short buffers', () => {
  const { r, bits, output } = setup();
  const query = (...args) =>
    r.apiProvider.get('kernel32.dll!VirtualQuery')(r, (i) => args[i] >>> 0);
  r.data.fill(0xcc, output, output + 96);
  assert.equal(query(bits, output, 27).result, 0);
  assert.equal(r.lastError, 87);
  assert.ok(r.data.slice(output, output + 96).every((v) => v === 0xcc));
  assert.equal(r.virtualMemory.protect(bits, 4096, 2).status, 0);
  assert.equal(query(bits + 9, output, 28).result, 28);
  assert.equal(r.read32(output), bits);
  assert.equal(r.read32(output + 16), 0x1000);
  assert.equal(r.read32(output + 20), 2);
  assert.equal(r.read32(output + 24), 0x20000);
  assert.equal(query(bits, 0xdeadbeef, 28).result, 0);
  assert.equal(r.lastError, 998);
  assert.equal(query(r.pe.entryPoint, output, 28).result, 28);
  assert.equal(r.read32(output + 24), 0x1000000);
});
test('SetPixel/PatBlt modify actual DIB bytes and retain untouched alpha, packed indices and padding', () => {
  for (const depth of [1, 4, 8, 16, 24, 32]) {
    const { r, call, bits, stride, dc } = setup(depth, -3);
    r.check(bits, stride * 3, true);
    r.data.fill(0, bits, bits + stride * 3);
    r.data.fill(0xcc, bits + stride - 1, bits + stride); // padding, or the last BGRA reserved byte
    const color = depth <= 8 ? 0xffffff : 0xff;
    assert.equal(call('SetPixel', dc, 0, 1, color).result, color);
    const expected =
      depth === 1
        ? [0x80]
        : depth === 4
          ? [0x10]
          : depth === 8
            ? [1]
            : depth === 16
              ? [0, 0x7c]
              : depth === 24
                ? [0, 0, 255]
                : [0, 0, 255, 0];
    assert.deepEqual([...r.data.slice(bits + stride, bits + stride + expected.length)], expected);
    assert.equal(r.data[bits + stride - 1], 0xcc);
    assert.equal(call('SetPixel', dc, 0, 1, 0).result, 0);
    assert.ok(r.data.slice(bits + stride, bits + stride + expected.length).every((v) => v === 0));
    assert.equal(call('PatBlt', dc, 1, 1, 1, 1, 0xff0062).result, 1);
    assert.equal(call('GetPixel', dc, 1, 1).result, 0xffffff);
    assert.equal(call('GetPixel', dc, 2, 1).result, 0);
  }
});
test('RGB565 stores quantize readback; source and destination blits share real storage', () => {
  const { r, call, bitmap, bits, dc } = setup(16, -3, 3, 3);
  assert.equal(call('SetPixel', dc, 1, 1, 0x00ff8000).result, 0x00ff8200);
  assert.equal(r.view.getUint16(bits + 8 + 2, true), 0x41f);
  const second = call('CreateCompatibleBitmap', dc, 5, 2).result,
    out = r.allocate(84);
  assert.equal(call('GetObjectW', second, 84, out).result, 84);
  assert.equal(r.view.getUint16(out + 18, true), 16);
  assert.equal(r.read32(out + 12), 12);
  const dst = call('CreateCompatibleDC', 0).result;
  call('SelectObject', dst, second);
  assert.equal(call('BitBlt', dst, 0, 0, 3, 2, dc, 0, 0, 0xcc0020).result, 1);
  assert.equal(call('GetPixel', dst, 1, 1).result, 0x00ff8200);
  const pointer = r.read32(out + 20);
  assert.equal(r.view.getUint16(pointer + 12 + 2, true), 0x41f);
  assert.equal(call('GetObjectA', bitmap, 84, out).result, 84);
  assert.deepEqual(
    [64, 68, 72].map((n) => r.read32(out + n)),
    [0xf800, 0x7e0, 0x1f],
  );
});
test('DIB color-table queries and mutation preserve indices and update displayed colors', () => {
  const { r, call, dc, bits, output } = setup(4, -3);
  r.write32(bits, 0x00001010);
  assert.equal(call('GetPixel', dc, 0, 0).result, 0xffffff);
  r.data.set([50, 100, 200, 0x77], output);
  assert.equal(call('SetDIBColorTable', dc, 1, 1, output).result, 1);
  assert.equal(r.read32(bits), 0x1010);
  assert.equal(call('GetPixel', dc, 0, 0).result, 0x003264c8);
  assert.equal(call('GetPixel', dc, 1, 0).result, 0);
  r.data.fill(0xcc, output, output + 12);
  assert.equal(call('GetDIBColorTable', dc, 1, 1, output).result, 1);
  assert.deepEqual(
    [...r.data.slice(output, output + 8)],
    [50, 100, 200, 0, 0xcc, 0xcc, 0xcc, 0xcc],
  );
  assert.equal(call('GetDIBColorTable', dc, 16, 2, output).result, 0);
  assert.equal(call('GdiFlush').result, 1);
});
test('shared DIB refresh checks only rows dirtied by guest writes and removed observers cannot affect reuse', () => {
  const { r, call, dc, bits, stride, bitmap, old, info, output } = setup(32, -3);
  call('GetPixel', dc, 0, 0);
  const check = r.check.bind(r),
    reads = [];
  r.check = (address, size, write = false) => {
    if (!write && address >= bits && address < bits + stride * 3) reads.push([address, size]);
    return check(address, size, write);
  };
  r.write32(bits + stride, 0x00112233);
  assert.equal(call('GetPixel', dc, 0, 1).result, 0x00332211);
  assert.deepEqual(reads, [[bits + stride, stride]]);
  call('SelectObject', dc, old);
  call('DeleteObject', bitmap);
  const next = call('CreateDIBSection', 0, info, 0, output, 0, 0).result;
  assert.ok(next);
  assert.equal(r.read32(output), bits);
  assert.equal(r.guestMemory.writeObservers.length, 1);
  call('SelectObject', dc, next);
  r.write32(bits, 0x00445566);
  assert.equal(call('GetPixel', dc, 0, 0).result, 0x00665544);
});
test('null outputs can be queried through GetObject; invalid/compressed/mapped requests fail without stale pointers', () => {
  const { r, call, info, output } = setup();
  const bitmap = call('CreateDIBSection', 0, info, 0, 0, 0, 123).result;
  assert.ok(bitmap);
  assert.equal(call('GetObjectA', bitmap, 24, output).result, 24);
  assert.ok(r.read32(output + 20));
  const before = r.virtualMemory.stats().reservedBytes;
  for (const [usage, section] of [
    [2, 0],
    [0, 0xdead],
  ]) {
    r.write32(output, 0xcccccccc);
    assert.equal(call('CreateDIBSection', 0, info, usage, output, section, 0).result, 0);
    assert.equal(r.read32(output), 0);
  }
  r.write32(info + 16, 1);
  assert.equal(call('CreateDIBSection', 0, info, 0, output, 0, 0).result, 0);
  assert.equal(r.virtualMemory.stats().reservedBytes, before);
});

test('shape, line, clipped text and DIB transfers commit to native bytes at each API boundary', () => {
  const { r, call, dc, bits, stride, info, bitmap } = setup(32, -12, 12);
  r.check(bits, stride * 12, true);
  r.data.fill(0, bits, bits + stride * 12);
  for (let i = 3; i < stride * 12; i += 4) r.data[bits + i] = 0xa5;
  const pixel = (x, y) => [
    ...r.data.slice(bits + y * stride + x * 4, bits + y * stride + x * 4 + 3),
  ];
  const brush = call('CreateSolidBrush', 0xff).result;
  const pen = call('CreatePen', 0, 1, 0xff00).result;
  call('SelectObject', dc, brush);
  call('SelectObject', dc, pen);
  assert.equal(call('Rectangle', dc, 1, 1, 4, 4).result, 1);
  assert.deepEqual(pixel(2, 2), [0, 0, 255]);
  assert.deepEqual(pixel(1, 1), [0, 255, 0]);
  call('MoveToEx', dc, 0, 8, 0);
  assert.equal(call('LineTo', dc, 5, 8).result, 1);
  assert.deepEqual(pixel(4, 8), [0, 255, 0]);
  assert.deepEqual(pixel(5, 8), [0, 0, 0], 'LineTo excludes its endpoint');
  const untouched = r.data.slice(bits + stride * 10, bits + stride * 12);
  r.gdiTextRasterizer = {
    rasterize: () => ({ width: 2, height: 2, alpha: Uint8Array.of(255, 0, 0, 255) }),
  };
  const text = r.allocate(4);
  r.write32(text, 65);
  call('SetBkMode', dc, 1);
  call('SetTextColor', dc, 0xff0000);
  call('IntersectClipRect', dc, 6, 5, 7, 7);
  assert.equal(call('TextOutA', dc, 6, 5, text, 1).result, 1);
  assert.deepEqual(pixel(6, 5), [255, 0, 0]);
  assert.deepEqual(pixel(7, 6), [0, 0, 0], 'text clip applies to shared bytes');
  assert.deepEqual(r.data.slice(bits + stride * 10, bits + stride * 12), untouched);
  assert.equal(r.data[bits + stride * 11 + 3], 0xa5);
  // SetDIBits commits its supplied scanline without disturbing other rows.
  r.write32(info + 4, 12);
  r.write32(info + 8, -12);
  const row = r.allocate(stride);
  r.check(row, stride, true);
  r.data.fill(0, row, row + stride);
  for (let x = 0; x < 12; x++) r.data.set([1, 2, 3, 0], row + x * 4);
  assert.equal(call('SetDIBits', dc, bitmap, 0, 1, row, info, 0).result, 1);
  assert.deepEqual(pixel(3, 11), [1, 2, 3]);
  assert.deepEqual(pixel(6, 5), [255, 0, 0]);
});

test('saved DCs retain shared bitmap storage until released', () => {
  const { r, call, dc, bitmap, old, bits } = setup();
  const saved = call('SaveDC', dc).result;
  assert.equal(saved, 1);
  call('SelectObject', dc, old);
  assert.equal(call('DeleteObject', bitmap).result, 0);
  assert.equal(r.virtualMemory.rangeFor(bits).base, bits);
  assert.equal(call('RestoreDC', dc, saved).result, 1);
  call('SelectObject', dc, old);
  assert.equal(call('DeleteObject', bitmap).result, 1);
  assert.equal(r.guestMemory.writeObservers.length, 0);
});
