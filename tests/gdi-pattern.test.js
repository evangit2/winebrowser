import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { describeGdiBrush } from '../src/win32-gdi.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = JSON.parse(await readFile('tests/fixtures/gdi-pattern/wine-oracle.json', 'utf8'));
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
  [0, 0, 16, 16].forEach((v, i) => r.write32(rect + i * 4, v));
  const fill = (brush) => call('user32.dll!FillRect', dc, rect, brush);
  const dib = (width, height, depth = 32, palette = []) => {
    const info = r.allocate(40 + palette.length * 4),
      out = r.allocate(4);
    r.data.fill(0, info, info + 40 + palette.length * 4);
    r.write32(info, 40);
    r.write32(info + 4, width);
    r.write32(info + 8, -height);
    r.view.setUint16(info + 12, 1, true);
    r.view.setUint16(info + 14, depth, true);
    palette.forEach((v, i) => r.write32(info + 40 + i * 4, v));
    const handle = call('CreateDIBSection', display, info, 0, out, 0, 0);
    assert.ok(handle);
    return { handle, bits: r.read32(out) };
  };
  return { r, api, call, display, dc, rect, fill, dib };
}
const mod = (v, n) => ((v % n) + n) % n;

test('all six hatch pixel phases and shifted origins match actual desktop Wine SDK tiles', (t) => {
  const { call, dc, fill } = setup(t);
  call('SetBkColor', dc, 0xf4ebdc);
  call('SetBkMode', dc, 2);
  for (const tile of oracle.tiles.filter((row) => row.name.startsWith('hatch'))) {
    const style = tile.name === 'hatch' ? 5 : Number(tile.name.split('-')[1]),
      brush = call('CreateHatchBrush', style, 0x784628);
    call('SetBrushOrgEx', dc, ...tile.origin, 0);
    assert.equal(fill(brush), 1);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        assert.equal(
          call('GetPixel', dc, x, y),
          tile.pixels[(y % tile.size) * tile.size + (x % tile.size)],
          `${tile.name}/${x},${y}`,
        );
    assert.equal(call('DeleteObject', brush), 1);
  }
});

test('copied color patterns retain native LOGBRUSH provenance after source deletion and share brush origins across FillRect/PatBlt/SaveDC', (t) => {
  const { r, api, call, dc, fill, dib } = setup(t),
    source = dib(2, 3),
    colors = [0x0000ff, 0x00ff00, 0xff0000, 0x00ffff, 0xff00ff, 0xffff00];
  for (let i = 0; i < 6; i++)
    r.write32(
      source.bits + i * 4,
      ((colors[i] & 255) << 16) | (colors[i] & 0xff00) | ((colors[i] >>> 16) & 255),
    );
  r.lastError = 777;
  const made = api('CreatePatternBrush', source.handle);
  assert.equal(made.argc, 1);
  assert.ok(made.result);
  assert.equal(r.lastError, 777);
  const brush = made.result,
    query = r.allocate(20);
  r.data.fill(0xcc, query, query + 20);
  assert.equal(call('GetObjectW', brush, 20, query), 12);
  assert.deepEqual(
    [0, 4, 8].map((i) => r.read32(query + i)),
    [3, 0, source.handle],
  );
  assert.ok(r.data.subarray(query + 12, query + 20).every((v) => v === 0xcc));
  r.write32(source.bits, 0xffffff);
  assert.equal(call('DeleteObject', source.handle), 1);
  const snapshot = describeGdiBrush(r, brush);
  snapshot.pattern.pixels.fill(0);
  const old = call('SelectObject', dc, brush),
    origin = r.allocate(16);
  r.data.fill(0xcc, origin, origin + 16);
  assert.deepEqual(api('GetBrushOrgEx', dc, origin), { result: 1, argc: 2 });
  assert.deepEqual([r.read32(origin), r.read32(origin + 4)], [0, 0]);
  assert.ok(r.data.subarray(origin + 8, origin + 16).every((v) => v === 0xcc));
  const verify = (ox, oy) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        assert.equal(
          call('GetPixel', dc, x, y),
          colors[mod(y - oy, 3) * 2 + mod(x - ox, 2)],
          `${x},${y}/${ox},${oy}`,
        );
  };
  for (const [x, y] of [
    [0, 0],
    [1, -1],
    [-3, 4],
    [0x7fffffff, -0x80000000],
  ]) {
    assert.deepEqual(api('SetBrushOrgEx', dc, x, y, origin), { result: 1, argc: 4 });
    assert.equal(fill(brush), 1);
    verify(x, y);
  }
  const saved = call('SaveDC', dc);
  assert.ok(saved);
  call('SetBrushOrgEx', dc, 0, 0, 0);
  assert.equal(call('RestoreDC', dc, saved), 1);
  call('GetBrushOrgEx', dc, origin);
  assert.deepEqual([r.read32(origin) | 0, r.read32(origin + 4) | 0], [0x7fffffff, -0x80000000]);
  assert.equal(call('PatBlt', dc, 0, 0, 16, 16, 0x00f00021), 1);
  verify(0x7fffffff, -0x80000000);
  assert.equal(call('DeleteObject', brush), 0);
  call('SelectObject', dc, old);
  assert.equal(call('DeleteObject', brush), 1);
});

test('CreateBitmap uses top-down WORD rows; monochrome patterns draw current DC colors in both background modes', (t) => {
  const { r, call, dc, fill } = setup(t),
    bits = r.allocate(8);
  r.data.set([0x80, 0, 0x40, 0, 0xaa, 0xaa, 0xaa, 0xaa], bits);
  const bitmap = call('CreateBitmap', 2, 2, 1, 1, bits);
  assert.ok(bitmap);
  const brush = call('CreatePatternBrush', bitmap);
  assert.ok(brush);
  assert.equal(call('DeleteObject', bitmap), 1);
  for (const mode of [1, 2])
    for (const [text, background] of [
      [0xff, 0xff00],
      [0xff0000, 0xffff],
    ]) {
      call('SetBkMode', dc, mode);
      call('SetTextColor', dc, text);
      call('SetBkColor', dc, background);
      fill(brush);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          assert.equal(call('GetPixel', dc, x, y), (x + y) % 2 ? text : background);
    }
  const color = r.allocate(8);
  r.data.set([0, 0, 255, 0xcc, 255, 0, 0, 0xcc], color);
  const dd = call('CreateBitmap', 1, 2, 1, 24, color);
  assert.ok(dd);
  const copied = call('CreatePatternBrush', dd);
  call('DeleteObject', dd);
  fill(copied);
  assert.equal(call('GetPixel', dc, 0, 0), 0xff);
  assert.equal(call('GetPixel', dc, 0, 1), 0xff0000);
  assert.equal(call('DeleteObject', brush), 1);
  assert.equal(call('DeleteObject', copied), 1);
});

test('one-bit DIB pattern brushes retain their color table instead of using monochrome DDB DC colors', (t) => {
  const { r, call, dc, fill, dib } = setup(t),
    source = dib(2, 2, 1, [0xff0000, 0x0000ff]);
  r.write32(source.bits, 0x80);
  r.write32(source.bits + 4, 0x40);
  const brush = call('CreatePatternBrush', source.handle);
  assert.ok(brush);
  call('DeleteObject', source.handle);
  call('SetTextColor', dc, 0x123456);
  call('SetBkColor', dc, 0x654321);
  fill(brush);
  assert.equal(call('GetPixel', dc, 0, 0), 0xff0000);
  assert.equal(call('GetPixel', dc, 1, 0), 0xff);
  assert.equal(call('GetPixel', dc, 0, 1), 0xff);
  assert.equal(call('GetPixel', dc, 1, 1), 0xff0000);
});

test('indirect brushes preserve SDK style/argc and pattern ownership, copied clips and saved selections', (t) => {
  const { r, api, call, dc, rect, fill, dib } = setup(t),
    source = dib(1, 1);
  r.write32(source.bits, 0xff0000);
  const input = r.allocate(12);
  [3, 0xdeadbeef, source.handle].forEach((v, i) => r.write32(input + i * 4, v));
  const result = api('CreateBrushIndirect', input);
  assert.equal(result.argc, 1);
  assert.ok(result.result);
  call('DeleteObject', source.handle);
  const clip = call('CreateRectRgn', 0, 0, 10, 10),
    hole = call('CreateRectRgn', 3, 3, 7, 7);
  call('CombineRgn', clip, clip, hole, 4);
  call('SelectClipRgn', dc, clip);
  call('DeleteObject', clip);
  call('DeleteObject', hole);
  const old = call('SelectObject', dc, result.result),
    save = call('SaveDC', dc);
  call('SelectObject', dc, old);
  assert.equal(call('DeleteObject', result.result), 0);
  assert.equal(fill(result.result), 1);
  call('SelectClipRgn', dc, 0);
  assert.equal(call('GetPixel', dc, 2, 2), 0xff);
  assert.equal(call('GetPixel', dc, 4, 4), 0);
  call('RestoreDC', dc, save);
  call('SelectObject', dc, old);
  assert.equal(call('DeleteObject', result.result), 1);
  for (const style of [0, 1, 2]) {
    [style, 0x123456, 4].forEach((v, i) => r.write32(input + i * 4, v));
    const got = api('CreateBrushIndirect', input);
    assert.equal(got.argc, 1);
    assert.ok(got.result);
    assert.equal(call('GetObjectA', got.result, 12, rect), 12);
    assert.equal(r.read32(rect), style);
    call('DeleteObject', got.result);
  }
});

test('pattern failures and quota accounting preserve existing pixels and origins, and deletion releases retained bitmap storage', (t) => {
  const { r, api, call, dc, display } = setup(t),
    out = r.allocate(16);
  r.data.fill(0xcc, out, out + 16);
  for (const [name, args, error] of [
    ['CreatePatternBrush', [0xdead], 6],
    ['CreateBrushIndirect', [0], 87],
    ['SetBrushOrgEx', [0xdead, 1, 2, out], 6],
    ['GetBrushOrgEx', [dc, 0], 87],
  ]) {
    assert.equal(api(name, ...args).result, 0);
    assert.equal(r.lastError, error);
  }
  assert.ok(r.data.subarray(out, out + 16).every((v) => v === 0xcc));
  const source = call('CreateCompatibleBitmap', display, 1024, 1024),
    copies = [];
  assert.ok(source);
  for (let i = 0; i < 16; i++) {
    const brush = call('CreatePatternBrush', source);
    if (!brush) {
      assert.equal(r.lastError, 8);
      break;
    }
    copies.push(brush);
  }
  assert.ok(copies.length > 1 && copies.length < 16);
  const freed = copies.pop();
  assert.equal(call('DeleteObject', freed), 1);
  const replacement = call('CreatePatternBrush', source);
  assert.ok(replacement);
  copies.push(replacement);
  for (const brush of copies) assert.equal(call('DeleteObject', brush), 1);
  call('DeleteObject', source);
});
