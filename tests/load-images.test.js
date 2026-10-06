import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('tests/fixtures/load-images/load-images.exe'));
const names = [
  'indexed4.bmp',
  'indexed8.bmp',
  'core4.bmp',
  'mono.bmp',
  'rgb24.bmp',
  'rgb565.bmp',
  'rgb32.bmp',
  'gap.bmp',
  'truncated.bmp',
];
const files = new Map(
  await Promise.all(
    names.map(async (name) => [
      name,
      new Uint8Array(await readFile('tests/fixtures/load-images/' + name)),
    ]),
  ),
);
function setup() {
  const r = new Runtime(iced, {
    files: new Map([['fixture.exe', exe], ...files]),
    exe: 'fixture.exe',
  });
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0);
  const text = (value, wide = false) => {
    const p = r.allocate(value.length * 2 + 2);
    if (wide) {
      for (let i = 0; i < value.length; i++) r.view.setUint16(p + i * 2, value.charCodeAt(i), true);
      r.view.setUint16(p + value.length * 2, 0, true);
    } else r.data.set(new TextEncoder().encode(value + '\0'), p);
    return p;
  };
  const describe = (bitmap) => {
    const p = r.allocate(84);
    const count = call('gdi32.dll!GetObjectW', bitmap, 84, p).result;
    return {
      count,
      width: r.read32(p + 4),
      height: r.read32(p + 8),
      stride: r.read32(p + 12),
      depth: r.view.getUint16(p + 18, true),
      bits: r.read32(p + 20),
      compression: r.read32(p + 40),
    };
  };
  const pixel = (bitmap, x, y) => {
    const dc = call('gdi32.dll!CreateCompatibleDC', 0).result;
    const old = call('gdi32.dll!SelectObject', dc, bitmap).result;
    const value = call('gdi32.dll!GetPixel', dc, x, y).result;
    call('gdi32.dll!SelectObject', dc, old);
    call('gdi32.dll!DeleteDC', dc);
    return value;
  };
  return { r, call, text, describe, pixel };
}
test('LoadImage follows all six SDK arguments and routes bitmap/icon/cursor resource types', () => {
  const { r, call, text, describe, pixel } = setup();
  for (const wide of [false, true])
    for (const name of [101, text('NamedBitmap', wide)]) {
      const loaded = call(
        'user32.dll!LoadImage' + (wide ? 'W' : 'A'),
        r.pe.imageBase,
        name,
        0,
        0,
        0,
        0,
      );
      assert.equal(loaded.argc, 6);
      assert.ok(loaded.result);
      assert.deepEqual(describe(loaded.result), {
        count: 24,
        width: 8,
        height: 2,
        stride: 32,
        depth: 32,
        bits: 0,
        compression: 0,
      });
      assert.equal(pixel(loaded.result, 1, 0), 0x808080);
      call('gdi32.dll!DeleteObject', loaded.result);
    }
  const icon = call('user32.dll!LoadImageA', r.pe.imageBase, 202, 1, 0, 0, 0x8000);
  const cursor = call('user32.dll!LoadImageW', r.pe.imageBase, 201, 2, 0, 0, 0x8000);
  assert.ok(icon.result && cursor.result);
  assert.equal(icon.argc, 6);
  assert.equal(cursor.argc, 6);
  assert.equal(call('user32.dll!LoadImageW', r.pe.imageBase, 101, 3, 0, 0, 0).result, 0);
  assert.equal(r.lastError, 87);
});
test('resources and files produce independent shared DIBs in all seven authored native layouts', () => {
  const { r, call, text, describe, pixel } = setup();
  const depths = [4, 8, 4, 1, 24, 16, 32],
    first = [0, 0, 0, 0xffffff, 0x1e140a, 255, 0x1e140a];
  const originals = new Map([...files].map(([name, bytes]) => [name, bytes.slice()]));
  const originalExe = exe.slice();
  for (let i = 0; i < 7; i++)
    for (const fromFile of [false, true]) {
      const bitmap = call(
        'user32.dll!LoadImageW',
        fromFile ? 0 : r.pe.imageBase,
        fromFile ? text(names[i], true) : 101 + i,
        0,
        0,
        0,
        0x2000 | (fromFile ? 0x10 : 0),
      ).result;
      assert.ok(bitmap);
      const info = describe(bitmap);
      assert.equal(info.count, 84);
      assert.equal(info.depth, depths[i]);
      assert.ok(info.bits);
      assert.equal(pixel(bitmap, 0, 0), first[i]);
      assert.equal(call('gdi32.dll!DeleteObject', bitmap).result, 1);
      assert.equal(r.guestMemory.writeObservers.length, 0);
    }
  assert.deepEqual(exe, originalExe);
  for (const [name, bytes] of files) assert.deepEqual(bytes, originals.get(name));
});
test('BMP pixel offsets, DOS paths and released source snapshots retain owned bitmap storage', () => {
  const { r, call, text, pixel, describe } = setup();
  for (const name of ['gap.bmp', 'C:\\winebrowser\\GAP.BMP', './gap.bmp']) {
    const bitmap = call('user32.dll!LoadImageA', 0, text(name), 0, 0, 0, 0x10).result;
    assert.ok(bitmap);
    assert.equal(pixel(bitmap, 1, 0), 0x808080);
    call('gdi32.dll!DeleteObject', bitmap);
  }
  const bitmap = call('user32.dll!LoadImageW', 0, text('rgb24.bmp', true), 0, 0, 0, 0x2010).result;
  assert.ok(bitmap);
  const info = describe(bitmap);
  r.files.delete('rgb24.bmp');
  r.guestMemory.write(info.bits, 255, 1);
  r.guestMemory.write(info.bits + 1, 0, 1);
  r.guestMemory.write(info.bits + 2, 255, 1);
  assert.equal(pixel(bitmap, 0, 0), 0xff00ff);
  assert.equal(pixel(bitmap, 1, 0), 0xffffff);
});
test('DIB sections preserve packed indices, padding, unused BGRA bytes and RGB565 masks without resizing', () => {
  const { r, call, text, describe } = setup();
  for (const [name, offset, size] of [
    ['mono.bmp', 62, 8],
    ['rgb32.bmp', 54, 8],
    ['rgb565.bmp', 66, 8],
  ]) {
    const bitmap = call('user32.dll!LoadImageA', 0, text(name), 0, 0, 0, 0x2010).result;
    assert.ok(bitmap);
    const info = describe(bitmap);
    assert.deepEqual(
      r.data.slice(info.bits, info.bits + size),
      files.get(name).slice(offset, offset + size),
    );
  }
  const duplicate = files.get('indexed4.bmp').slice();
  duplicate.set([0, 0, 0, 0], 58);
  r.files.set('duplicate.bmp', duplicate);
  const bitmap = call('user32.dll!LoadImageA', 0, text('duplicate.bmp'), 0, 0, 0, 0x2010).result;
  const info = describe(bitmap);
  assert.deepEqual(r.data.slice(info.bits, info.bits + 8), duplicate.slice(70));
});
test('requested width/height independently scale native pixels and keep the DIB format', () => {
  const { r, call, describe, pixel } = setup();
  const bitmap = call('user32.dll!LoadImageW', r.pe.imageBase, 101, 0, 16, 4, 0xa040).result;
  assert.ok(bitmap);
  assert.deepEqual(describe(bitmap), {
    count: 84,
    width: 16,
    height: 4,
    stride: 8,
    depth: 4,
    bits: describe(bitmap).bits,
    compression: 0,
  });
  assert.equal(pixel(bitmap, 2, 0), 0x808080);
  assert.equal(pixel(bitmap, 0, 3), 0xffffff);
  const heightOnly = call('user32.dll!LoadImageW', r.pe.imageBase, 105, 0, 0, 4, 0x2000).result;
  assert.equal(describe(heightOnly).width, 3);
  assert.equal(pixel(heightOnly, 0, 3), 0x030201);
  const second = call('user32.dll!LoadImageW', r.pe.imageBase, 101, 0, 16, 4, 0xa040).result;
  assert.notEqual(second, bitmap, 'LR_SHARED does not cache bitmaps');
});
test('system palette flags alter colors without rewriting resource indices or source color tables', () => {
  const { r, call, text, describe, pixel } = setup();
  const bitmap = call('user32.dll!LoadImageW', r.pe.imageBase, 101, 0, 0, 0, 0x3020).result;
  const info = describe(bitmap);
  assert.equal(pixel(bitmap, 3, 0), call('user32.dll!GetSysColor', 15).result);
  assert.equal(pixel(bitmap, 0, 0), 0);
  assert.deepEqual(r.data.slice(info.bits, info.bits + 8), files.get('indexed4.bmp').slice(70));
  const altered = files.get('indexed4.bmp').slice();
  altered.set([223, 223, 223, 0], 66);
  r.files.set('light.bmp', altered);
  const light = call('user32.dll!LoadImageA', 0, text('light.bmp'), 0, 0, 0, 0x3010).result;
  assert.equal(pixel(light, 3, 0), call('user32.dll!GetSysColor', 22).result);
});
test('malformed files, offsets and flags fail without leaking shared mappings', () => {
  const { r, call, text } = setup();
  const before = r.virtualMemory.stats().reservedBytes;
  const variants = [];
  for (const offset of [1, 20, 69, 0xffffffff]) {
    const bytes = files.get('indexed4.bmp').slice();
    new DataView(bytes.buffer).setUint32(10, offset, true);
    variants.push(bytes);
  }
  for (const [i, bytes] of variants.entries()) {
    const name = 'bad' + i + '.bmp';
    r.files.set(name, bytes);
    assert.equal(call('user32.dll!LoadImageA', 0, text(name), 0, 0, 0, 0x2010).result, 0);
    assert.equal(r.lastError, 13);
    assert.equal(r.guestMemory.writeObservers.length, 0);
  }
  for (const [name, error] of [
    ['missing.bmp', 2],
    ['truncated.bmp', 13],
  ]) {
    assert.equal(call('user32.dll!LoadImageA', 0, text(name), 0, 0, 0, 0x2010).result, 0);
    assert.equal(r.lastError, error);
  }
  assert.equal(call('user32.dll!LoadImageW', r.pe.imageBase, 101, 0, -1, 0, 0).result, 0);
  assert.equal(r.lastError, 87);
  assert.equal(call('user32.dll!LoadImageW', r.pe.imageBase, 101, 0, 0, 0, 0x100).result, 0);
  assert.equal(r.lastError, 87);
  assert.equal(r.virtualMemory.stats().reservedBytes, before);
});

test('omitted entries in partial BMP color tables retain black defaults and are not recolored by transparent flags', () => {
  const { r, call, text, pixel, describe } = setup();
  const bytes = files.get('indexed4.bmp').slice();
  bytes[70] = 255;
  r.files.set('partial.bmp', bytes);
  for (const flags of [0x2010, 0x2030, 0x3030]) {
    const bitmap = call('user32.dll!LoadImageA', 0, text('partial.bmp'), 0, 0, 0, flags).result;
    assert.ok(bitmap);
    assert.equal(pixel(bitmap, 0, 1), 0);
    assert.equal(r.data[describe(bitmap).bits], 255);
    call('gdi32.dll!DeleteObject', bitmap);
  }
});
