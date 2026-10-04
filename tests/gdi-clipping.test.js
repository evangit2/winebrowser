import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { describeGdiBitmap } from '../src/win32-gdi.js';
import { createOwnedIcon } from '../src/win32-icons.js';
const executable = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
function fixture(t) {
  const r = new Runtime(iced, {
    files: new Map([['console.exe', executable]]),
    exe: 'console.exe',
  });
  r.gdiTextRasterizer = {
    rasterize() {
      return { width: 16, height: 8, alpha: new Uint8Array(128).fill(255), advance: 16 };
    },
  };
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0).result;
  const display = call('user32.dll!GetDC', 0),
    dc = call('gdi32.dll!CreateCompatibleDC', display),
    bitmap = call('gdi32.dll!CreateCompatibleBitmap', display, 32, 32);
  call('gdi32.dll!SelectObject', dc, bitmap);
  const rect = r.allocate(16);
  [0, 0, 32, 32].forEach((v, i) => r.write32(rect + 4 * i, v));
  call('user32.dll!FillRect', dc, rect, call('gdi32.dll!GetStockObject', 0));
  const brush = call('gdi32.dll!CreateSolidBrush', 0x000000ff);
  call('gdi32.dll!SelectObject', dc, brush);
  return { r, call, dc, bitmap, rect, brush, pixels: () => describeGdiBitmap(r, bitmap).pixels };
}
const pixel = (pixels, x, y) => [...pixels.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
const visible = (x, y) =>
  x >= 4 && y >= 4 && x < 28 && y < 28 && !(x >= 12 && y >= 12 && x < 20 && y < 20);

test('temporary text clips and empty regions preserve the selected DC clip', (t) => {
  const { r, call, dc, rect, brush, pixels } = fixture(t);
  call('gdi32.dll!IntersectClipRect', dc, 4, 4, 28, 28);
  [8, 8, 12, 12].forEach((v, i) => r.write32(rect + i * 4, v));
  assert.equal(call('gdi32.dll!ExtTextOutA', dc, 4, 8, 4, rect, r.allocString('text'), 4, 0), 1);
  assert.deepEqual(pixel(pixels(), 8, 8), [0, 0, 0, 255]);
  assert.deepEqual(pixel(pixels(), 12, 8), [255, 255, 255, 255]);
  assert.equal(call('user32.dll!DrawTextA', dc, r.allocString('text'), 4, rect, 0), 16);
  assert.deepEqual(pixel(pixels(), 12, 10), [255, 255, 255, 255]);
  call('user32.dll!DrawTextA', dc, r.allocString('text'), 4, rect, 0x100);
  assert.deepEqual(pixel(pixels(), 12, 10), [0, 0, 0, 255]);
  assert.equal(call('gdi32.dll!ExcludeClipRect', dc, 100, 100, 110, 110), 2);
  assert.equal(call('gdi32.dll!ExcludeClipRect', dc, 0, 0, 32, 32), 1);
  assert.equal(call('gdi32.dll!GetClipBox', dc, rect), 1);
  call('user32.dll!FillRect', dc, rect, brush);
  assert.equal(call('gdi32.dll!SetPixel', dc, 8, 8, 0xff), 0xffffffff);
  assert.equal(call('gdi32.dll!SelectClipRgn', dc, 0), 2);
  assert.equal(call('gdi32.dll!SetPixel', dc, 0, 0, 0xff), 0xff);
});

test('saved complex clip regions preserve their holes, classify intersections, and restore actual drawing', (t) => {
  const { r, call, dc, rect, brush, pixels } = fixture(t);
  const save = call('gdi32.dll!SaveDC', dc);
  assert.equal(call('gdi32.dll!IntersectClipRect', dc, 4, 4, 28, 28), 2);
  assert.equal(call('gdi32.dll!ExcludeClipRect', dc, 12, 12, 20, 20), 3);
  const box = r.allocate(16);
  assert.equal(call('gdi32.dll!GetClipBox', dc, box), 3);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(box + i)),
    [4, 4, 28, 28],
  );
  const holeSave = call('gdi32.dll!SaveDC', dc);
  assert.equal(
    call('gdi32.dll!IntersectClipRect', dc, 4, 4, 12, 28),
    2,
    'adjacent fragments merge into a simple region',
  );
  call('user32.dll!FillRect', dc, rect, brush);
  assert.deepEqual(pixel(pixels(), 8, 24), [255, 0, 0, 255]);
  assert.deepEqual(pixel(pixels(), 24, 24), [255, 255, 255, 255]);
  assert.equal(call('gdi32.dll!RestoreDC', dc, holeSave), 1);
  assert.equal(call('gdi32.dll!GetClipBox', dc, box), 3);
  call('user32.dll!FillRect', dc, rect, brush);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++)
      assert.deepEqual(
        pixel(pixels(), x, y),
        visible(x, y) ? [255, 0, 0, 255] : [255, 255, 255, 255],
      );
  assert.equal(call('gdi32.dll!SetPixel', dc, 14, 14, 0), 0xffffffff);
  assert.equal(call('gdi32.dll!GetPixel', dc, 14, 14), 0xffffffff);
  assert.equal(call('gdi32.dll!RestoreDC', dc, save), 1);
  assert.equal(call('gdi32.dll!GetClipBox', dc, box), 2);
  assert.equal(call('gdi32.dll!SetPixel', dc, 14, 14, 0), 0);
  assert.deepEqual(pixel(pixels(), 14, 14), [0, 0, 0, 255]);
});

for (const operation of [
  'fill',
  'invert',
  'line',
  'rectangle',
  'ellipse',
  'polygon',
  'text',
  'bitblt',
  'stretchblt',
  'icon',
])
  test(`${operation} respects a complex destination clip without painting excluded pixels`, (t) => {
    const { r, call, dc, rect, brush, pixels } = fixture(t);
    call('gdi32.dll!IntersectClipRect', dc, 4, 4, 28, 28);
    call('gdi32.dll!ExcludeClipRect', dc, 12, 12, 20, 20);
    if (operation === 'fill') call('user32.dll!FillRect', dc, rect, brush);
    if (operation === 'invert') call('gdi32.dll!PatBlt', dc, 0, 0, 32, 32, 0x00550009);
    if (operation === 'line') {
      call('gdi32.dll!MoveToEx', dc, 0, 0, 0);
      call('gdi32.dll!LineTo', dc, 32, 32);
    }
    if (operation === 'rectangle') call('gdi32.dll!Rectangle', dc, 0, 0, 32, 32);
    if (operation === 'ellipse') call('gdi32.dll!Ellipse', dc, 0, 0, 32, 32);
    if (operation === 'polygon') {
      const points = r.allocate(24);
      [0, 0, 32, 0, 16, 32].forEach((v, i) => r.write32(points + 4 * i, v));
      call('gdi32.dll!Polygon', dc, points, 3);
    }
    if (operation === 'text') {
      call('gdi32.dll!SetBkMode', dc, 1);
      call('gdi32.dll!TextOutA', dc, 2, 8, r.allocString('text'), 4);
    }
    if (operation === 'icon') {
      const icon = createOwnedIcon(r, {
        width: 32,
        height: 32,
        pixels: new Uint8Array(4096).fill(255).map((v, i) => (i % 4 === 3 ? v : 0)),
      });
      assert.ok(icon);
      call('user32.dll!DrawIconEx', dc, 0, 0, icon, 32, 32, 0, 0, 3);
    }
    if (operation === 'bitblt' || operation === 'stretchblt') {
      const src = call('gdi32.dll!CreateCompatibleDC', dc),
        image = call('gdi32.dll!CreateCompatibleBitmap', dc, 32, 32);
      call('gdi32.dll!SelectObject', src, image);
      call('gdi32.dll!IntersectClipRect', src, 0, 0, 1, 1);
      assert.equal(
        operation === 'bitblt'
          ? call('gdi32.dll!BitBlt', dc, 0, 0, 32, 32, src, 0, 0, 0xcc0020)
          : call('gdi32.dll!StretchBlt', dc, 0, 0, 32, 32, src, 0, 0, 32, 32, 0xcc0020),
        1,
        'only destination clipping applies',
      );
    }
    const bytes = pixels();
    let changed = 0;
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const value = pixel(bytes, x, y);
        if (!visible(x, y)) assert.deepEqual(value, [255, 255, 255, 255], `outside/hole ${x},${y}`);
        else if (value.some((v) => v !== 255)) changed++;
      }
    assert.ok(changed > 0, 'the clip does not silently suppress all drawing');
  });
