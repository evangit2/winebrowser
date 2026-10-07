import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const capture = JSON.parse(await readFile('tests/fixtures/gdi-brush-rop/wine-oracle.json'));
function setup(t, dib = false) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) =>
    r.apiProvider.get(name.includes('!') ? name : 'gdi32.dll!' + name)(r, (i) => args[i] >>> 0);
  const call = (name, ...args) => api(name, ...args).result;
  const display = call('user32.dll!GetDC', 0),
    dc = call('CreateCompatibleDC', display);
  let bitmap, bits;
  if (dib) {
    const info = r.allocate(40),
      out = r.allocate(4);
    r.data.fill(0, info, info + 40);
    r.write32(info, 40);
    r.write32(info + 4, 16);
    r.write32(info + 8, -16);
    r.view.setUint16(info + 12, 1, true);
    r.view.setUint16(info + 14, 32, true);
    bitmap = call('CreateDIBSection', display, info, 0, out, 0, 0);
    bits = r.read32(out);
  } else bitmap = call('CreateCompatibleBitmap', display, 16, 16);
  call('SelectObject', dc, bitmap);
  const sourceBits = r.allocate(16);
  r.data.set([0xaa, 0, 0x55, 0, 0xaa, 0, 0x55, 0, 0xaa, 0, 0x55, 0, 0xaa, 0, 0x55, 0], sourceBits);
  const source = call('CreateBitmap', 8, 8, 1, 1, sourceBits),
    mono = call('CreatePatternBrush', source);
  call('DeleteObject', source);
  const brushes = [
    call('CreateSolidBrush', 0x784628),
    mono,
    mono,
    call('CreateHatchBrush', 5, 0x784628),
    0,
    call('GetStockObject', 5),
  ];
  brushes[4] = brushes[3];
  const info = r.allocate(40),
    out = r.allocate(4);
  r.data.fill(0, info, info + 40);
  r.write32(info, 40);
  r.write32(info + 4, 2);
  r.write32(info + 8, -2);
  r.view.setUint16(info + 12, 1, true);
  r.view.setUint16(info + 14, 32, true);
  const colorBitmap = call('CreateDIBSection', display, info, 0, out, 0, 0);
  [0x225588, 0x66aa33, 0xcc4477, 0xaadd99].forEach((v, i) => r.write32(r.read32(out) + i * 4, v));
  brushes.push(call('CreatePatternBrush', colorBitmap));
  call('DeleteObject', colorBitmap);
  const back = call('CreateSolidBrush', capture.background),
    rect = r.allocate(16),
    point = r.allocate(8);
  const setRect = (values) => values.forEach((v, i) => r.write32(rect + i * 4, v));
  return { r, api, call, dc, brushes, back, rect, point, setRect, bits };
}
test('FillRect and all PatBlt truth tables match 1327 desktop Wine captures and 339712 pixels', (t) => {
  const { r, api, call, dc, brushes, back, rect, point, setRect } = setup(t);
  call('SetBrushOrgEx', dc, 3, -5, 0);
  call('SetTextColor', dc, 0x123456);
  call('SetBkColor', dc, 0x654321);
  call('MoveToEx', dc, 13, 14, 0);
  for (const [index, c] of capture.cases.entries()) {
    const label = `${index}/${c.fill}/${c.rop}/${c.brush}/${c.rect}`;
    call('SelectClipRgn', dc, 0);
    setRect([0, 0, 16, 16]);
    call('user32.dll!FillRect', dc, rect, back);
    if (c.clip) {
      const a = call('CreateRectRgn', 1, 2, 14, 15),
        b = call('CreateRectRgn', 5, 6, 9, 10);
      call('CombineRgn', a, a, b, 4);
      call('SelectClipRgn', dc, a);
      call('DeleteObject', a);
      call('DeleteObject', b);
    }
    call('SelectObject', dc, brushes[c.brush]);
    call('SetBkMode', dc, c.brush === 2 || c.brush === 4 ? 1 : 2);
    setRect(c.rect);
    r.lastError = 777;
    const [l, top, right, bottom] = c.rect;
    assert.deepEqual(
      c.fill
        ? api('user32.dll!FillRect', dc, rect, brushes[c.brush])
        : api('PatBlt', dc, l, top, right - l, bottom - top, c.rop),
      { result: c.result, argc: c.fill ? 3 : 6 },
      label,
    );
    assert.equal(r.lastError, c.error, label + ' LastError');
    call('GetCurrentPositionEx', dc, point);
    assert.deepEqual(
      [r.read32(point) | 0, r.read32(point + 4) | 0],
      c.position,
      label + ' position',
    );
    assert.deepEqual(
      [0, 4, 8, 12].map((o) => r.read32(rect + o) | 0),
      c.rect,
      label + ' rect',
    );
    assert.equal(call('GetTextColor', dc), 0x123456);
    assert.equal(call('GetBkColor', dc), 0x654321);
    const pixels = new Uint32Array(256).fill(capture.background);
    for (const [x, y, w, color] of c.runs) pixels.fill(color, y * 16 + x, y * 16 + x + w);
    call('SelectClipRgn', dc, 0);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        assert.equal(call('GetPixel', dc, x, y), pixels[y * 16 + x], `${label}/${x},${y}`);
  }
});
test('pattern raster operations write native colors directly into shared guest DIB storage', (t) => {
  const { r, call, dc, brushes, rect, setRect, bits } = setup(t, true);
  const raw = (c) => ((c & 255) << 16) | (c & 0xff00) | (c >>> 16);
  call('SetBrushOrgEx', dc, 3, -5, 0);
  call('SetTextColor', dc, 0x123456);
  call('SetBkColor', dc, 0x654321);
  for (const c of capture.cases.filter(
    (c) => !c.fill && c.brush === 2 && c.rect.join() === '13,12,2,3',
  )) {
    for (let i = 0; i < 256; i++) r.write32(bits + i * 4, raw(capture.background) | 0x5a000000);
    call('SelectObject', dc, brushes[c.brush]);
    call('SetBkMode', dc, 1);
    setRect(c.rect);
    const [l, top, right, bottom] = c.rect;
    assert.equal(call('PatBlt', dc, l, top, right - l, bottom - top, c.rop), c.result);
    const pixels = new Uint32Array(256).fill(capture.background);
    for (const [x, y, w, color] of c.runs) pixels.fill(color, y * 16 + x, y * 16 + x + w);
    for (let i = 0; i < 256; i++)
      assert.equal(r.read32(bits + i * 4) & 0xffffff, raw(pixels[i]), `${c.rop}/${i}`);
  }
});
