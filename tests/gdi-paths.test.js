import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = JSON.parse(await readFile('tests/fixtures/gdi-paths/wine-oracle.json', 'utf8'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) =>
      r.apiProvider.get(name.includes('!') ? name : 'gdi32.dll!' + name)(r, (i) => args[i] >>> 0),
    call = (name, ...args) => api(name, ...args).result;
  const dc = call('CreateCompatibleDC', 0),
    info = r.allocate(40),
    out = r.allocate(4);
  r.data.fill(0, info, info + 40);
  r.write32(info, 40);
  r.write32(info + 4, 32);
  r.write32(info + 8, -32);
  r.view.setUint16(info + 12, 1, true);
  r.view.setUint16(info + 14, 32, true);
  const bitmap = call('CreateDIBSection', dc, info, 0, out, 0, 0);
  assert.ok(bitmap);
  call('SelectObject', dc, bitmap);
  const bits = r.read32(out);
  const brush = call('CreateSolidBrush', 0x1e91f0);
  assert.ok(brush);
  call('SelectObject', dc, brush);
  return { r, api, call, dc, bits };
}
test('Polygon/PolyPolygon alternate and winding coverage plus independent PolyPolyline groups match 112 actual native Wine snapshots', (t) => {
  const { r, api, call, dc, bits } = setup(t);
  for (const c of oracle.cases) {
    for (let i = 0; i < 1024; i++) r.write32(bits + i * 4, 0x406080);
    call('SelectClipRgn', dc, 0);
    call('SetPolyFillMode', dc, c.mode);
    call('SelectObject', dc, call('GetStockObject', c.kind === 2 || c.outlined ? 6 : 8));
    if (c.clip) {
      const region = call('CreateRectRgn', 3, 5, 28, 27),
        hole = call('CreateRectRgn', 12, 12, 20, 20);
      call('CombineRgn', region, region, hole, 4);
      call('SelectClipRgn', dc, region);
      call('DeleteObject', region);
      call('DeleteObject', hole);
    }
    const points = r.allocate(c.points.length * 8),
      counts = r.allocate(c.counts.length * 4),
      current = r.allocate(8);
    c.points.flat().forEach((v, i) => r.write32(points + i * 4, v));
    c.counts.forEach((v, i) => r.write32(counts + i * 4, v));
    call('MoveToEx', dc, 7, 9, 0);
    r.lastError = 777;
    const result =
      c.kind === 2
        ? api('PolyPolyline', dc, points, counts, c.counts.length)
        : c.kind === 1
          ? api('PolyPolygon', dc, points, counts, c.counts.length)
          : api('Polygon', dc, points, c.counts[0]);
    assert.equal(result.result, c.result, c.name);
    assert.equal(result.argc, c.kind === 0 ? 3 : 4);
    assert.equal(r.lastError, c.error);
    call('GetCurrentPositionEx', dc, current);
    assert.deepEqual([r.read32(current), r.read32(current + 4)], c.current, c.name + '/position');
    for (let i = 0; i < 1024; i++) {
      const raw = r.read32(bits + i * 4),
        rgb = ((raw & 255) << 16) | (raw & 0xff00) | ((raw >>> 16) & 255);
      assert.equal(rgb, c.pixels[i], `${c.name}/${i % 32},${Math.floor(i / 32)}`);
    }
  }
});
test('fill mode survives nested SaveDC/RestoreDC; invalid mode and malformed later groups fail atomically', (t) => {
  const { r, api, call, dc, bits } = setup(t);
  assert.equal(call('GetPolyFillMode', dc), 1);
  const first = call('SaveDC', dc);
  assert.equal(call('SetPolyFillMode', dc, 2), 1);
  const second = call('SaveDC', dc);
  assert.equal(call('SetPolyFillMode', dc, 1), 2);
  assert.equal(call('RestoreDC', dc, second), 1);
  assert.equal(call('GetPolyFillMode', dc), 2);
  assert.equal(call('RestoreDC', dc, first), 1);
  assert.equal(call('GetPolyFillMode', dc), 1);
  for (const mode of [0, 3, -1]) {
    assert.deepEqual(api('SetPolyFillMode', dc, mode), { result: 0, argc: 2 });
    assert.equal(r.lastError, 87);
    assert.equal(call('GetPolyFillMode', dc), 1);
  }
  const points = r.allocate(32),
    counts = r.allocate(8);
  [0, 0, 20, 20, 20, 0, 0, 20].forEach((v, i) => r.write32(points + i * 4, v));
  r.write32(counts, 2);
  r.write32(counts + 4, 1);
  const before = r.data.slice(bits, bits + 4096);
  for (const name of ['PolyPolyline', 'PolyPolygon']) {
    r.lastError = 777;
    assert.deepEqual(api(name, dc, points, counts, 2), { result: 0, argc: 4 });
    assert.equal(r.lastError, 777);
    assert.deepEqual(r.data.slice(bits, bits + 4096), before);
    assert.deepEqual(api(name, dc, 0, 0, 0), { result: 1, argc: 4 });
  }
  r.write32(counts + 4, 1024);
  assert.equal(call('PolyPolyline', dc, points, counts, 2), 0);
  assert.equal(r.lastError, 8);
  assert.deepEqual(r.data.slice(bits, bits + 4096), before);
  assert.equal(call('GetPolyFillMode', 0xdead), 0);
  assert.equal(r.lastError, 6);
});
test('CreatePenIndirect owns native LOGPEN metadata, normalizes negative widths and null pens, and draws its real color', (t) => {
  const { r, api, call, dc, bits } = setup(t),
    input = r.allocate(16),
    output = r.allocate(16),
    points = r.allocate(16),
    counts = r.allocate(4);
  for (const width of [-1, 0, 1]) {
    r.write32(input, 0);
    r.write32(input + 4, width);
    r.write32(input + 8, 123);
    r.write32(input + 12, 0xff332211);
    r.lastError = 777;
    const pen = call('CreatePenIndirect', input);
    assert.ok(pen);
    assert.equal(r.lastError, 777);
    assert.equal(call('GetObjectW', pen, 16, output), 16);
    assert.deepEqual(
      [0, 4, 8, 12].map((i) => r.read32(output + i)),
      [0, Math.abs(width), 0, 0xff332211],
    );
    r.data.fill(0, input, input + 16);
    const old = call('SelectObject', dc, pen);
    [2, 2, 8, 2].forEach((v, i) => r.write32(points + i * 4, v));
    r.write32(counts, 2);
    assert.equal(call('PolyPolyline', dc, points, counts, 1), 1);
    assert.equal(call('GetPixel', dc, 3, 2), 0);
    call('SelectObject', dc, old);
    assert.equal(call('DeleteObject', pen), 1);
  }
  r.write32(input, 5);
  r.write32(input + 4, 100);
  r.write32(input + 12, 0x123456);
  const pen = call('CreatePenIndirect', input);
  assert.ok(pen);
  call('GetObjectA', pen, 16, output);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(output + i)),
    [5, 1, 0, 0],
  );
  call('SelectObject', dc, pen);
  const before = r.data.slice(bits, bits + 4096);
  call('PolyPolyline', dc, points, counts, 1);
  assert.deepEqual(r.data.slice(bits, bits + 4096), before);
  r.write32(input, 1);
  assert.deepEqual(api('CreatePenIndirect', input), { result: 0, argc: 1 });
  assert.equal(r.lastError, 120);
});

test('owned pen color flags keep native metadata while palette indices resolve at draw time through Polygon, PolyPolyline and LineTo', async (t) => {
  const native = JSON.parse(
    await readFile('tests/fixtures/gdi-paths/pen-color-wine-oracle.json', 'utf8'),
  );
  const { r, call, dc } = setup(t),
    input = r.allocate(16),
    output = r.allocate(16),
    points = r.allocate(16),
    counts = r.allocate(4),
    data = r.allocate(16);
  r.view.setUint16(data, 0x300, true);
  r.view.setUint16(data + 2, 3, true);
  r.data.set([9, 19, 29, 0, 10, 20, 30, 0, 100, 110, 120, 0], data + 4);
  const palette = call('CreatePalette', data);
  assert.ok(palette);
  [2, 2, 8, 2].forEach((v, i) => r.write32(points + i * 4, v));
  r.write32(counts, 2);
  for (const c of native.cases) {
    call('SelectPalette', dc, c.custom ? palette : call('GetStockObject', 15), 0);
    r.write32(input, 0);
    r.write32(input + 4, -1);
    r.write32(input + 8, 123);
    r.write32(input + 12, c.color);
    r.lastError = 777;
    const pen = call('CreatePenIndirect', input);
    assert.ok(pen);
    assert.equal(r.lastError, c.error);
    call('GetObjectW', pen, 16, output);
    assert.equal(r.read32(output + 12), c.metadata);
    const old = call('SelectObject', dc, pen);
    for (const op of ['PolyPolyline', 'LineTo', 'Polygon']) {
      call('SetPixel', dc, 3, 2, 0xabcdef);
      if (op === 'LineTo') {
        call('MoveToEx', dc, 2, 2, 0);
        assert.equal(call('LineTo', dc, 8, 2), 1);
      } else if (op === 'Polygon') assert.equal(call('Polygon', dc, points, 2), 1);
      else assert.equal(call('PolyPolyline', dc, points, counts, 1), 1);
      assert.equal(call('GetPixel', dc, 3, 2), c.pixel, `${c.custom}/${c.color}/${op}`);
    }
    call('SelectObject', dc, old);
    call('DeleteObject', pen);
  }
  r.write32(input + 12, 0x10ff0001);
  assert.equal(call('CreatePenIndirect', input), 0);
  assert.equal(r.lastError, 120);
});
