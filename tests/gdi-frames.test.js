import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { paintFocusRect } from '../src/gdi-raster.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = JSON.parse(await readFile('tests/fixtures/gdi-frames/wine-oracle.json', 'utf8'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) =>
    r.apiProvider.get(name.includes('!') ? name : 'gdi32.dll!' + name)(r, (i) => args[i] >>> 0);
  const call = (name, ...args) => api(name, ...args).result;
  const display = call('user32.dll!GetDC', 0),
    dc = call('CreateCompatibleDC', display),
    bitmap = call('CreateCompatibleBitmap', display, 16, 16);
  call('SelectObject', dc, bitmap);
  const rect = r.allocate(16);
  const setRect = (values) => values.forEach((v, i) => r.write32(rect + i * 4, v));
  return { r, api, call, dc, rect, setRect };
}
test('FrameRect and XOR focus outlines match every pixel of actual desktop Wine, including clipping, degenerate and reversed bounds', (t) => {
  const { r, api, call, dc, rect, setRect } = setup(t);
  const brush = call('CreateSolidBrush', 0x784628),
    hatch = call('CreateHatchBrush', 4, 0x784628),
    white = call('GetStockObject', 0),
    empty = call('GetStockObject', 5);
  for (const c of oracle.cases) {
    call('SelectClipRgn', dc, 0);
    call('SetBrushOrgEx', dc, 0, 0, 0);
    call('SetBkMode', dc, 2);
    setRect([0, 0, 16, 16]);
    call('user32.dll!FillRect', dc, rect, white);
    if (c.clip) {
      const a = call('CreateRectRgn', 0, 0, 12, 12),
        b = call('CreateRectRgn', 4, 4, 8, 8);
      call('CombineRgn', a, a, b, 4);
      call('SelectClipRgn', dc, a);
      call('DeleteObject', a);
      call('DeleteObject', b);
    }
    if (['focus-state', 'frame-hatch', 'frame-null'].includes(c.name)) {
      call('SetBrushOrgEx', dc, 3, -5, 0);
      call('SetTextColor', dc, 0xff);
      call('SetBkColor', dc, 0xff00);
      call('SetBkMode', dc, 1);
    }
    setRect(c.rect);
    r.lastError = 777;
    for (let i = 0; i < c.repeats; i++)
      assert.deepEqual(
        api(
          c.focus ? 'user32.dll!DrawFocusRect' : 'user32.dll!FrameRect',
          dc,
          rect,
          c.name === 'frame-hatch' ? hatch : c.name === 'frame-null' ? empty : brush,
        ),
        { result: c.result, argc: c.focus ? 2 : 3 },
        c.name,
      );
    assert.equal(r.lastError, c.error, c.name);
    call('SelectClipRgn', dc, 0);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        assert.equal(call('GetPixel', dc, x, y), c.pixels[y * 16 + x], `${c.name}/${x},${y}`);
  }
});
test('focus drawing toggles arbitrary RGB twice and leaves saved DC colors, origins and selections intact', (t) => {
  const { r, call, dc, rect, setRect } = setup(t),
    brush = call('CreateSolidBrush', 0x123456);
  setRect([0, 0, 16, 16]);
  call('user32.dll!FillRect', dc, rect, brush);
  call('SetBrushOrgEx', dc, -3, 7, 0);
  call('SetTextColor', dc, 0xabcdef);
  call('SetBkColor', dc, 0xfedcba);
  call('SetBkMode', dc, 1);
  const old = call('SelectObject', dc, brush),
    save = call('SaveDC', dc);
  setRect([2, 2, 13, 12]);
  assert.equal(call('user32.dll!DrawFocusRect', dc, rect), 1);
  assert.equal(call('GetPixel', dc, 2, 2), 0xffffff ^ 0x123456);
  assert.equal(call('GetPixel', dc, 3, 3), 0x123456);
  assert.equal(call('user32.dll!DrawFocusRect', dc, rect), 1);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) assert.equal(call('GetPixel', dc, x, y), 0x123456);
  assert.equal(call('GetTextColor', dc), 0xabcdef);
  assert.equal(call('GetBkColor', dc), 0xfedcba);
  assert.equal(call('GetBkMode', dc), 1);
  const out = r.allocate(8);
  call('GetBrushOrgEx', dc, out);
  assert.deepEqual([r.read32(out) | 0, r.read32(out + 4) | 0], [-3, 7]);
  assert.equal(call('SelectObject', dc, old), brush);
  call('RestoreDC', dc, save);
  call('SelectObject', dc, old);
  assert.equal(call('DeleteObject', brush), 1);
});
test('frame and focus invalid handles/pointers return failure without touching pixels', (t) => {
  const { r, api, call, dc, rect, setRect } = setup(t);
  setRect([1, 1, 14, 14]);
  for (const [name, args, error, argc] of [
    ['user32.dll!DrawFocusRect', [0xdead, rect], 6, 2],
    ['user32.dll!DrawFocusRect', [dc, 0], 87, 2],
    ['user32.dll!DrawFocusRect', [dc, r.data.length - 8], 87, 2],
    ['user32.dll!FrameRect', [0xdead, rect, 0], 6, 3],
    ['user32.dll!FrameRect', [dc, rect, 0xdead], 6, 3],
    ['user32.dll!FrameRect', [dc, 0, 0], 87, 3],
  ]) {
    assert.deepEqual(api(name, ...args), { result: 0, argc });
    assert.equal(r.lastError, error);
  }
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) assert.equal(call('GetPixel', dc, x, y), 0);
});
test('focus raster bounds extreme coordinates and rejects unreadable control overlays atomically', () => {
  const surface = {
    width: 16,
    height: 16,
    pixels: new Uint8ClampedArray(1024),
    controlOverlay: true,
  };
  surface.pixels.fill(255);
  surface.pixels[(2 * 16 + 2) * 4 + 3] = 0;
  const before = surface.pixels.slice();
  assert.equal(paintFocusRect(surface, 2, 2, 13, 12), null);
  assert.deepEqual(surface.pixels, before);
  assert.equal(surface.dirty, undefined);
  surface.controlOverlay = false;
  assert.equal(paintFocusRect(surface, -2147483648, -2147483648, 2147483647, 2147483647), false);
  assert.equal(paintFocusRect(surface, -2147483648, 2, 2147483647, 12), true);
});

test('frame/focus writes synchronize real guest DIB memory at the API boundary and preserve interior guest changes', (t) => {
  const { r, call, dc, rect, setRect } = setup(t),
    info = r.allocate(40),
    out = r.allocate(4);
  r.data.fill(0, info, info + 40);
  r.write32(info, 40);
  r.write32(info + 4, 16);
  r.write32(info + 8, -16);
  r.view.setUint16(info + 12, 1, true);
  r.view.setUint16(info + 14, 32, true);
  const bitmap = call('CreateDIBSection', dc, info, 0, out, 0, 0),
    bits = r.read32(out);
  assert.ok(bitmap && bits);
  call('SelectObject', dc, bitmap);
  for (let i = 0; i < 256; i++) r.write32(bits + i * 4, 0x123456);
  setRect([2, 2, 13, 12]);
  assert.equal(call('user32.dll!DrawFocusRect', dc, rect), 1);
  assert.equal(r.read32(bits + (2 * 16 + 2) * 4) & 0xffffff, 0xedcba9);
  assert.equal(r.read32(bits + (3 * 16 + 3) * 4) & 0xffffff, 0x123456);
  r.write32(bits + (3 * 16 + 3) * 4, 0xabcdef);
  assert.equal(call('user32.dll!DrawFocusRect', dc, rect), 1);
  assert.equal(r.read32(bits + (2 * 16 + 2) * 4) & 0xffffff, 0x123456);
  assert.equal(r.read32(bits + (3 * 16 + 3) * 4) & 0xffffff, 0xabcdef);
  const brush = call('CreateSolidBrush', 0x784628);
  assert.equal(call('user32.dll!FrameRect', dc, rect, brush), 1);
  assert.equal(r.read32(bits + (2 * 16 + 2) * 4) & 0xffffff, 0x284678);
  assert.equal(r.read32(bits + (3 * 16 + 3) * 4) & 0xffffff, 0xabcdef);
});
