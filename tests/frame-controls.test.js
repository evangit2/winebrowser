import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const capture = JSON.parse(
  await readFile('tests/fixtures/frame-controls/wine-oracle.json', 'utf8'),
);
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
    dc = call('CreateCompatibleDC', display);
  const bitmap = call('CreateCompatibleBitmap', display, 32, 32);
  call('SelectObject', dc, bitmap);
  const rect = r.allocate(16),
    point = r.allocate(8);
  const setRect = (values) => values.forEach((v, i) => r.write32(rect + i * 4, v));
  const back = call('CreateSolidBrush', capture.background);
  return { r, api, call, dc, rect, point, setRect, back };
}
test('classic frame controls match 311 native SDK results, adjusted rectangles and 318464 drawing pixels', (t) => {
  const { r, api, call, dc, rect, point, setRect, back } = setup(t);
  call('SetTextColor', dc, 0x123456);
  call('SetBkColor', dc, 0x654321);
  call('SetBkMode', dc, 1);
  call('SetPolyFillMode', dc, 2);
  call('SetBrushOrgEx', dc, 3, -5, 0);
  call('MoveToEx', dc, 29, 30, 0);
  for (const [i, c] of capture.cases.entries()) {
    const label = `${i}/${c.type}/${c.flags}/${c.rect}`;
    call('SelectClipRgn', dc, 0);
    setRect([0, 0, 32, 32]);
    call('user32.dll!FillRect', dc, rect, back);
    if (c.clip) {
      const a = call('CreateRectRgn', 0, 0, 24, 27),
        b = call('CreateRectRgn', 9, 8, 15, 14);
      call('CombineRgn', a, a, b, 4);
      call('SelectClipRgn', dc, a);
      call('DeleteObject', a);
      call('DeleteObject', b);
    }
    setRect(c.rect);
    r.lastError = 777;
    assert.deepEqual(
      api('user32.dll!DrawFrameControl', dc, rect, c.type, c.flags),
      { result: c.result, argc: 4 },
      label,
    );
    assert.equal(r.lastError, c.error, label + ' LastError');
    assert.deepEqual(
      [0, 4, 8, 12].map((offset) => r.read32(rect + offset) | 0),
      c.outRect,
      label + ' RECT',
    );
    call('GetCurrentPositionEx', dc, point);
    assert.deepEqual(
      [r.read32(point) | 0, r.read32(point + 4) | 0],
      c.position,
      label + ' position',
    );
    assert.equal(call('GetTextColor', dc), c.textColor, label + ' text');
    assert.equal(call('GetBkColor', dc), c.bkColor, label + ' background');
    assert.equal(call('GetBkMode', dc), c.bkMode, label + ' background mode');
    assert.equal(call('GetPolyFillMode', dc), c.fillMode, label + ' polygon mode');
    const pixels = new Uint32Array(1024).fill(capture.background);
    for (const [x, y, w, color] of c.runs) pixels.fill(color, y * 32 + x, y * 32 + x + w);
    call('SelectClipRgn', dc, 0);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++)
        assert.equal(call('GetPixel', dc, x, y), pixels[y * 32 + x], `${label}/${x},${y}`);
  }
});

test('frame controls commit native reference colors directly to guest DIB memory', (t) => {
  const { r, call, dc, rect, setRect } = setup(t);
  const info = r.allocate(40),
    out = r.allocate(4);
  r.data.fill(0, info, info + 40);
  r.write32(info, 40);
  r.write32(info + 4, 32);
  r.write32(info + 8, -32);
  r.view.setUint16(info + 12, 1, true);
  r.view.setUint16(info + 14, 32, true);
  const bitmap = call('CreateDIBSection', dc, info, 0, out, 0, 0),
    bits = r.read32(out);
  call('SelectObject', dc, bitmap);
  const raw = (color) => ((color & 255) << 16) | (color & 0xff00) | (color >>> 16);
  const c = capture.cases.find((c) => c.type === 4 && c.flags === 1040 && !c.clip);
  assert.ok(c);
  for (let i = 0; i < 1024; i++) r.write32(bits + i * 4, raw(capture.background) | 0x5a000000);
  call('SetTextColor', dc, 0x123456);
  call('SetBkColor', dc, 0x654321);
  call('SetBrushOrgEx', dc, 3, -5, 0);
  setRect(c.rect);
  assert.equal(call('user32.dll!DrawFrameControl', dc, rect, c.type, c.flags), 1);
  const expected = new Uint32Array(1024).fill(capture.background);
  for (const [x, y, w, color] of c.runs) expected.fill(color, y * 32 + x, y * 32 + x + w);
  for (let i = 0; i < 1024; i++)
    assert.equal(r.read32(bits + i * 4) & 0xffffff, raw(expected[i]), 'DIB pixel ' + i);
});

test('unfinished frame control types and malformed inputs fail before changing pixels or DC state', (t) => {
  const { r, api, call, dc, rect, point, setRect, back } = setup(t);
  setRect([0, 0, 32, 32]);
  call('user32.dll!FillRect', dc, rect, back);
  call('MoveToEx', dc, 29, 30, 0);
  setRect([3, 4, 27, 28]);
  for (const [type, subtype] of [
    [1, 0],
    [2, 2],
    [3, 8],
    [4, 1],
    [4, 2],
    [4, 4],
  ]) {
    assert.deepEqual(api('user32.dll!DrawFrameControl', dc, rect, type, subtype), {
      result: 0,
      argc: 4,
    });
    assert.equal(r.lastError, 120);
  }
  for (const [handle, pointer, error] of [
    [0xdead, rect, 6],
    [dc, 0, 87],
    [dc, r.data.length - 8, 87],
  ]) {
    assert.deepEqual(api('user32.dll!DrawFrameControl', handle, pointer, 4, 16), {
      result: 0,
      argc: 4,
    });
    assert.equal(r.lastError, error);
  }
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) assert.equal(call('GetPixel', dc, x, y), capture.background);
  call('GetCurrentPositionEx', dc, point);
  assert.deepEqual([r.read32(point), r.read32(point + 4)], [29, 30]);
  assert.deepEqual(
    [0, 4, 8, 12].map((offset) => r.read32(rect + offset)),
    [3, 4, 27, 28],
  );
});
