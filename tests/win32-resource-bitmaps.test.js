import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { readPEResource } from '../src/pe-resources.js';
import { resourceDibLayout } from '../src/win32-resource-bitmaps.js';
const exe = new Uint8Array(await readFile('tests/fixtures/resource-bitmaps/resource-bitmaps.exe'));
function setup() {
  const r = new Runtime(iced, {
    files: new Map([['resource-bitmaps.exe', exe]]),
    exe: 'resource-bitmaps.exe',
  });
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0);
  return { r, call };
}
test('resource DIB layout rejects every truncated header/palette/pixel payload', () => {
  for (let id = 101; id <= 107; id++) {
    const dib = readPEResource(exe, 2, id),
      layout = resourceDibLayout(dib);
    assert.ok(layout);
    for (let size = 0; size < dib.length; size++)
      assert.equal(
        resourceDibLayout(dib.subarray(0, size)),
        null,
        `resource ${id}, prefix ${size}`,
      );
    const invalid = dib.slice();
    new DataView(invalid.buffer).setUint16(layout.depth === 4 && id === 103 ? 8 : 12, 2, true);
    assert.equal(resourceDibLayout(invalid), null, 'multiplane DIB rejected');
  }
});
test('resource mapping owns independent bitmap pixels and keeps PE bytes immutable', () => {
  const { r, call } = setup(),
    original = exe.slice(),
    p = r.allocate(16);
  r.write32(p, 0);
  r.write32(p + 4, 0x00332211);
  r.write32(p + 8, 0);
  r.write32(p + 12, 0x00665544);
  const bitmap = call('comctl32.dll!CreateMappedBitmap', r.pe.imageBase, 101, 0, p, 2);
  assert.equal(bitmap.argc, 5);
  assert.ok(bitmap.result);
  const dc = call('gdi32.dll!CreateCompatibleDC', 0).result;
  const old = call('gdi32.dll!SelectObject', dc, bitmap.result).result;
  assert.equal(call('gdi32.dll!GetPixel', dc, 0, 0).result, 0x00332211);
  assert.deepEqual(exe, original);
  const raw = call('user32.dll!LoadBitmapA', r.pe.imageBase, 101);
  assert.equal(raw.argc, 2);
  call('gdi32.dll!SelectObject', dc, raw.result);
  assert.equal(call('gdi32.dll!GetPixel', dc, 0, 0).result, 0);
  call('gdi32.dll!SelectObject', dc, old);
  assert.equal(call('gdi32.dll!DeleteObject', bitmap.result).result, 1);
  assert.equal(call('gdi32.dll!DeleteObject', raw.result).result, 1);
  assert.equal(call('gdi32.dll!DeleteDC', dc).result, 1);
  assert.equal(call('comctl32.dll!CreateMappedBitmap', r.pe.imageBase, 101, 2, 0, 0).result, 0);
  assert.equal(r.lastError, 120);
  assert.equal(call('comctl32.dll!CreateMappedBitmap', r.pe.imageBase, 101, 0, p, -1).result, 0);
  assert.equal(r.lastError, 87);
});
test('GetObject returns the real PE32 BITMAP, handles size probes and preserves buffer tails', () => {
  const { r, call } = setup(),
    bitmap = call('user32.dll!LoadBitmapW', r.pe.imageBase, 104).result,
    p = r.allocate(32);
  assert.ok(bitmap);
  assert.equal(call('gdi32.dll!GetObjectA', bitmap, 0, 0).result, 24);
  r.data.fill(0xcc, p, p + 32);
  assert.equal(call('gdi32.dll!GetObjectW', bitmap, 23, p).result, 0);
  assert.ok(r.data.subarray(p, p + 32).every((b) => b === 0xcc));
  assert.equal(call('gdi32.dll!GetObjectW', bitmap, 32, p).result, 24);
  assert.deepEqual(
    [0, 4, 8, 12, 20].map((i) => r.read32(p + i)),
    [0, 9, 2, 2, 0],
  );
  assert.equal(r.view.getUint16(p + 16, true), 1);
  assert.equal(r.view.getUint16(p + 18, true), 1);
  assert.ok(r.data.subarray(p + 24, p + 32).every((b) => b === 0xcc));
  assert.equal(call('gdi32.dll!DeleteObject', bitmap).result, 1);
  assert.equal(call('gdi32.dll!GetObjectA', bitmap, 0, 0).result, 0);
});
