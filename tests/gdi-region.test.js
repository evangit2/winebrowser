import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { describeGdiBitmap } from '../src/win32-gdi.js';
import { combineRegions } from '../src/gdi-region.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const shapeOracle = JSON.parse(
  await readFile('tests/fixtures/gdi-shapes/wine-oracle.json', 'utf8'),
);
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get('gdi32.dll!' + name)(r, (i) => args[i] >>> 0);
  const call = (name, ...args) => api(name, ...args).result;
  const region = (...rect) => call('CreateRectRgn', ...rect);
  const put = (p, words) => words.forEach((v, i) => r.write32(p + i * 4, v));
  const box = r.allocate(32);
  const get = (handle) => {
    call('GetRgnBox', handle, box);
    return [0, 4, 8, 12].map((i) => r.read32(box + i) | 0);
  };
  const data = (handle) => {
    const size = call('GetRegionData', handle, 0, 0),
      p = r.allocate(size + 16);
    r.data.fill(0xcc, p, p + size + 16);
    assert.equal(call('GetRegionData', handle, size, p), size);
    assert.ok(r.data.subarray(p + size, p + size + 16).every((v) => v === 0xcc));
    return { p, size, words: Array.from({ length: size / 4 }, (_, i) => r.read32(p + i * 4) | 0) };
  };
  return { r, api, call, region, put, box, get, data };
}
const has = (pieces, x, y) => pieces.some(([l, t, r, b]) => x >= l && y >= t && x < r && y < b);

test('polygon, winding, polypolygon, rounded and elliptical region pixels match 289 desktop Wine 11 SDK oracle cases', (t) => {
  const { r, api, call, put, data } = setup(t);
  assert.equal(shapeOracle.cases.length, 289);
  for (const [index, sample] of shapeOracle.cases.entries()) {
    let result;
    if (sample.kind === 'polygon') {
      const [mode, count, ...points] = sample.args,
        p = r.allocate(points.length * 4);
      put(p, points);
      result = api('CreatePolygonRgn', p, count, mode);
      assert.equal(result.argc, 3);
    } else if (sample.kind === 'polypolygon') {
      const [mode, count, ...rest] = sample.args,
        counts = rest.slice(0, count),
        points = rest.slice(count),
        p = r.allocate(points.length * 4),
        c = r.allocate(count * 4);
      put(p, points);
      put(c, counts);
      result = api('CreatePolyPolygonRgn', p, c, count, mode);
      assert.equal(result.argc, 4);
    } else {
      result = api(
        sample.kind === 'round' ? 'CreateRoundRectRgn' : 'CreateEllipticRgn',
        ...sample.args,
      );
      assert.equal(result.argc, sample.kind === 'round' ? 6 : 4);
    }
    assert.ok(result.result, `${index}: ${JSON.stringify(sample)}`);
    const words = data(result.result).words;
    const actual = Array.from({ length: words[2] }, (_, i) => words.slice(8 + i * 4, 12 + i * 4));
    assert.deepEqual(
      actual,
      combineRegions(sample.rects, [], 2),
      `${index}: ${JSON.stringify(sample.args)}`,
    );
    if (sample.kind === 'ellipse') {
      const rect = r.allocate(16);
      put(rect, sample.args);
      const indirect = api('CreateEllipticRgnIndirect', rect);
      assert.equal(indirect.argc, 1);
      assert.equal(call('EqualRgn', result.result, indirect.result), 1);
      assert.equal(call('DeleteObject', indirect.result), 1);
    }
    assert.equal(call('DeleteObject', result.result), 1);
  }
});

test('shape constructors bound guest counts and scan work, consume no failed handles, and support huge vertical polygons', (t) => {
  const { r, api, call, put, get } = setup(t);
  const p = r.allocate(32),
    counts = r.allocate(8);
  put(p, [0, -60000000, 20, -60000000, 20, 60000000, 0, 60000000]);
  const large = call('CreatePolygonRgn', p, 4, 1);
  assert.ok(large);
  assert.deepEqual(get(large), [0, -60000000, 20, 60000000]);
  assert.equal(call('DeleteObject', large), 1);
  for (const [name, args, error] of [
    ['CreatePolygonRgn', [p, -1, 1], 87],
    ['CreatePolygonRgn', [p, 4097, 1], 87],
    ['CreatePolygonRgn', [0, 3, 1], 87],
    ['CreatePolyPolygonRgn', [p, counts, -1, 1], 87],
    ['CreatePolyPolygonRgn', [p, 0, 1, 1], 87],
    ['CreateEllipticRgnIndirect', [0], 87],
    ['CreateEllipticRgn', [0, 0, 50000, 50000], 8],
    ['CreateRoundRectRgn', [0, 0, 50000, 8, 50000, 6], 8],
    ['CreateRoundRectRgn', [-0x4000000, 0, -0x4000000, 4, 0, 0], 87],
  ]) {
    assert.equal(api(name, ...args).result, 0, name);
    assert.equal(r.lastError, error, name);
  }
  put(counts, [4096, 1]);
  assert.equal(call('CreatePolyPolygonRgn', p, counts, 2, 1), 0);
  assert.equal(r.lastError, 87);
  put(p, [0, 0, 20, 40000, 0, 40000]);
  assert.equal(call('CreatePolygonRgn', p, 3, 1), 0);
  assert.equal(r.lastError, 8);
  // Construction failures leave existing geometry and selected clips intact.
  assert.ok(call('CreateEllipticRgn', 0, 0, 20, 20));
  const empty = call('CreatePolygonRgn', 0, 0, 1);
  assert.ok(empty);
  assert.deepEqual(get(empty), [0, 0, 0, 0]);
});

test('region boolean sweep matches independent pixel membership across overlapping decompositions and emits canonical bands', () => {
  let seed = 19;
  const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % 15) - 7;
  for (let example = 0; example < 40; example++) {
    const shapes = [0, 1].map(() =>
      Array.from({ length: 6 }, () => {
        const [a, b, c, d] = [next(), next(), next(), next()];
        return [Math.min(a, b), Math.min(c, d), Math.max(a, b), Math.max(c, d)];
      }),
    );
    for (const mode of [1, 2, 3, 4]) {
      const result = combineRegions(...shapes, mode);
      assert.ok(result);
      for (let y = -8; y < 9; y++)
        for (let x = -8; x < 9; x++) {
          const a = has(shapes[0], x, y),
            b = has(shapes[1], x, y);
          const expected =
            mode === 1 ? a && b : mode === 2 ? a || b : mode === 3 ? a !== b : a && !b;
          assert.equal(has(result, x, y), expected, `${example}/${mode}/${x},${y}`);
          assert.ok(
            result.filter(([l, t, r, b]) => x >= l && y >= t && x < r && y < b).length <= 1,
          );
        }
      assert.deepEqual(combineRegions(result.toReversed(), [], 2), result);
    }
  }
});

test('SDK region handles normalize inverted coordinates, preserve empty boxes and output guards, and identify actual object types', (t) => {
  const { r, api, call, region, box, get } = setup(t);
  r.lastError = 77;
  const a = region(10, 8, -2, -4);
  assert.ok(a);
  assert.equal(call('GetObjectType', a), 8);
  r.data.fill(0xcc, box, box + 32);
  assert.deepEqual(api('GetRgnBox', a, box), { result: 2, argc: 2 });
  assert.deepEqual(get(a), [-2, -4, 10, 8]);
  assert.ok(r.data.subarray(box + 16, box + 32).every((v) => v === 0xcc));
  assert.equal(call('PtInRegion', a, -2, -4), 1);
  assert.equal(call('PtInRegion', a, 10, 0), 0);
  assert.equal(call('PtInRegion', a, 0, 8), 0);
  assert.equal(call('SetRectRgn', a, 4, 9, 4, -2), 1);
  assert.equal(call('GetRgnBox', a, box), 1);
  assert.deepEqual(get(a), [0, 0, 0, 0]);
  assert.equal(call('OffsetRgn', a, -100, 50), 1);
  assert.equal(r.lastError, 77);
  const copied = call('CreateRectRgnIndirect', box);
  assert.ok(copied && copied !== a);
  assert.equal(call('EqualRgn', a, copied), 1);
  assert.equal(call('DeleteObject', a), 1);
  assert.equal(call('GetObjectType', a), 0);
  assert.equal(r.lastError, 6);
  assert.equal(call('GetObjectType', call('GetStockObject', 0)), 2);
  assert.equal(call('GetObjectType', call('GetStockObject', 7)), 1);
  assert.equal(call('GetObjectType', call('CreateCompatibleDC', 0)), 10);
});

test('CombineRgn handles both destination aliases, ignores COPY source2, coalesces adjacent pieces and preserves failures', (t) => {
  const { r, call, region, get, data } = setup(t);
  for (const alias of ['none', 'first', 'second'])
    for (const mode of [1, 2, 3, 4, 5]) {
      const a = region(0, 0, 10, 10),
        b = region(2, 2, 8, 8),
        out = alias === 'first' ? a : alias === 'second' ? b : region(0, 0, 0, 0);
      const classification = call('CombineRgn', out, a, mode === 5 ? 0xdead : b, mode);
      assert.equal(classification, [0, 2, 2, 3, 3, 2][mode]);
      for (let y = -1; y < 12; y++)
        for (let x = -1; x < 12; x++) {
          const aa = x >= 0 && y >= 0 && x < 10 && y < 10,
            bb = x >= 2 && y >= 2 && x < 8 && y < 8;
          const expected =
            mode === 1
              ? aa && bb
              : mode === 2
                ? aa || bb
                : mode === 3
                  ? aa !== bb
                  : mode === 4
                    ? aa && !bb
                    : aa;
          assert.equal(call('PtInRegion', out, x, y), +expected);
        }
      if (mode === 4)
        assert.deepEqual(
          data(out).words,
          [32, 1, 4, 64, 0, 0, 10, 10, 0, 0, 10, 2, 0, 2, 2, 8, 8, 2, 10, 8, 0, 8, 10, 10],
        );
    }
  const a = region(0, 0, 10, 10),
    b = region(10, 0, 20, 10);
  assert.equal(call('CombineRgn', a, a, b, 2), 2);
  assert.deepEqual(get(a), [0, 0, 20, 10]);
  assert.equal(call('OffsetRgn', a, -7, 3), 2);
  assert.deepEqual(get(a), [-7, 3, 13, 13]);
  for (const [args, error] of [
    [[a, a, 0xdead, 1], 6],
    [[a, a, b, 99], 87],
  ]) {
    assert.equal(call('CombineRgn', ...args), 0);
    assert.equal(r.lastError, error);
    assert.deepEqual(get(a), [-7, 3, 13, 13]);
  }
});

test('RGNDATA round-trips canonical geometry with guards, preflight counts and explicit identity-only XFORM support', (t) => {
  const { r, api, call, region, put, data, get } = setup(t);
  const a = region(0, 0, 20, 20),
    hole = region(4, 4, 16, 16);
  call('CombineRgn', a, a, hole, 4);
  const { p, size, words } = data(a);
  const copy = call('ExtCreateRegion', 0, size, p);
  assert.ok(copy);
  assert.equal(call('EqualRgn', a, copy), 1);
  put(p + 16, [999, 999, 1000, 1000]);
  assert.equal(
    call('EqualRgn', a, call('ExtCreateRegion', 0, size, p)),
    1,
    'input bounding box cannot replace real geometry',
  );
  assert.equal(call('GetRegionData', a, size - 1, p), 0);
  assert.equal(r.lastError, 122);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, i) => r.read32(p + 16 + i * 4)),
    [999, 999, 1000, 1000],
  );
  const identity = r.allocate(24);
  [1, 0, 0, 1, 0, 0].forEach((v, i) => r.view.setFloat32(identity + i * 4, v, true));
  assert.ok(call('ExtCreateRegion', identity, size, p));
  r.view.setFloat32(identity + 16, 1, true);
  assert.equal(call('ExtCreateRegion', identity, size, p), 0);
  assert.equal(r.lastError, 120);
  assert.equal(call('ExtCreateRegion', 0, 32, p), 0);
  assert.equal(r.lastError, 87);
  put(p, [32, 1, 1, 16, 0, 0, 0, 0, 20, 20, 1, 1]);
  const empty = call('ExtCreateRegion', 0, 48, p);
  assert.ok(empty);
  assert.deepEqual(get(empty), [0, 0, 0, 0]);
  assert.equal(api('CreateRectRgnIndirect', 0).argc, 1);
  assert.equal(call('CreateRectRgn', 0, 0, 0x4000000, 1), 0);
  assert.equal(r.lastError, 87);
  assert.ok(words.length > 8);
});

test('region complexity bound fails atomically and canonical overlapping input is accepted within the output bound', (t) => {
  const { r, call, region, put, get } = setup(t),
    n = 257,
    p = r.allocate(32 + n * 16);
  put(p, [32, 1, n, n * 16, 0, 0, 1000, 1000]);
  for (let i = 0; i < n; i++) put(p + 32 + i * 16, [i * 3, 0, i * 3 + 1, 1]);
  assert.equal(call('ExtCreateRegion', 0, 32 + n * 16, p), 0);
  assert.equal(r.lastError, 8);
  r.write32(p + 8, 256);
  const a = call('ExtCreateRegion', 0, 32 + 256 * 16, p);
  assert.ok(a);
  const b = region(900, 0, 901, 1),
    dest = region(1, 2, 3, 4);
  assert.equal(call('CombineRgn', dest, a, b, 2), 0);
  assert.equal(r.lastError, 8);
  assert.deepEqual(get(dest), [1, 2, 3, 4]);
  r.write32(p + 8, n);
  for (let i = 0; i < n; i++) put(p + 32 + i * 16, [0, 0, 20, 20]);
  assert.deepEqual(get(call('ExtCreateRegion', 0, 32 + n * 16, p)), [0, 0, 20, 20]);
});

function drawing(t) {
  const f = setup(t),
    { r, call } = f;
  const display = r.apiProvider.get('user32.dll!GetDC')(r, () => 0).result;
  const dc = call('CreateCompatibleDC', display),
    bitmap = call('CreateCompatibleBitmap', display, 32, 32);
  call('SelectObject', dc, bitmap);
  const all = r.allocate(16);
  f.put(all, [0, 0, 32, 32]);
  r.apiProvider.get('user32.dll!FillRect')(r, (i) => [dc, all, call('GetStockObject', 0)][i]);
  const brush = call('CreateSolidBrush', 0xff),
    green = call('CreateSolidBrush', 0xff00);
  call('SelectObject', dc, green);
  const region = f.region(4, 4, 28, 28),
    hole = f.region(12, 12, 20, 20);
  call('CombineRgn', region, region, hole, 4);
  const pixels = () => describeGdiBitmap(r, bitmap).pixels;
  const pixel = (x, y) => [...pixels().subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  return { ...f, dc, bitmap, all, brush, green, shape: region, pixel };
}
const inShape = (x, y) =>
  x >= 4 && y >= 4 && x < 28 && y < 28 && !(x >= 12 && y >= 12 && x < 20 && y < 20);

test('clip geometry SDK failures return ERROR, GetClipRgn errors return minus one, and output guards survive', (t) => {
  const { r, api, call, box } = setup(t);
  r.data.fill(0xcc, box, box + 32);
  for (const [name, args, argc, value] of [
    ['GetClipBox', [0xdead, box], 2, 0],
    ['IntersectClipRect', [0xdead, 1, 2, 3, 4], 5, 0],
    ['ExcludeClipRect', [0xdead, 1, 2, 3, 4], 5, 0],
    ['SelectClipRgn', [0xdead, 0], 2, 0],
    ['ExtSelectClipRgn', [0xdead, 0, 5], 3, 0],
    ['GetClipRgn', [0xdead, 0], 2, 0xffffffff],
  ]) {
    assert.deepEqual(api(name, ...args), { result: value, argc });
    assert.equal(r.lastError, 6);
    assert.ok(r.data.subarray(box, box + 32).every((v) => v === 0xcc));
  }
  const dc = call('CreateCompatibleDC', 0);
  assert.equal(call('ExtSelectClipRgn', dc, 0, 1), 0);
  assert.equal(r.lastError, 87);
  assert.equal(call('GetClipBox', dc, box), 2);
});

test('selected region shapes are copied, independent of original/deleted handles and saved DC clips', (t) => {
  const { r, call, region, dc, shape, brush, pixel, box, get } = drawing(t);
  const query = region(1, 2, 3, 4);
  assert.equal(call('GetClipRgn', dc, query), 0);
  assert.deepEqual(get(query), [1, 2, 3, 4]);
  assert.equal(call('SelectObject', dc, shape), 3);
  const save = call('SaveDC', dc);
  assert.equal(call('SetRectRgn', shape, 0, 0, 1, 1), 1);
  assert.equal(call('DeleteObject', shape), 1);
  assert.equal(call('GetClipRgn', dc, query), 1);
  assert.deepEqual(get(query), [4, 4, 28, 28]);
  call('SelectClipRgn', dc, 0);
  assert.equal(call('RestoreDC', dc, save), 1);
  assert.equal(call('FillRgn', dc, query, brush), 1);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++)
      assert.deepEqual(pixel(x, y), inShape(x, y) ? [255, 0, 0, 255] : [255, 255, 255, 255]);
  for (const [rect, expected] of [
    [[12, 12, 20, 20], 0],
    [[8, 8, 14, 14], 1],
    [[28, 4, 30, 10], 0],
    [[10, 10, 8, 8], 1],
    [[100, 100, 110, 110], 0],
  ]) {
    [0, 4, 8, 12].forEach((off, i) => r.write32(box + off, rect[i]));
    assert.equal(call('RectVisible', dc, box), expected);
    assert.equal(call('RectInRegion', query, box), expected);
  }
  assert.equal(call('ExtSelectClipRgn', dc, query, 3), 1);
  assert.equal(call('GetClipBox', dc, box), 1);
  assert.equal(call('SelectClipRgn', 0xdead, query), 0);
  assert.equal(r.lastError, 6);
});

test('FillRgn and FrameRgn draw actual complex-region pixels, preserve selected brush and respect independent destination clips', (t) => {
  for (const frame of [false, true]) {
    const { call, dc, shape, brush, green, pixel } = drawing(t);
    call('IntersectClipRect', dc, 0, 0, 18, 32);
    assert.equal(
      frame ? call('FrameRgn', dc, shape, brush, 2, 3) : call('FillRgn', dc, shape, brush),
      1,
    );
    assert.equal(call('GetCurrentObject', dc, 2), green);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const inner =
          inShape(x - 2, y) && inShape(x + 2, y) && inShape(x, y - 3) && inShape(x, y + 3);
        const expected = x < 18 && inShape(x, y) && (!frame || !inner);
        assert.deepEqual(
          pixel(x, y),
          expected ? [255, 0, 0, 255] : [255, 255, 255, 255],
          `${frame}/${x},${y}`,
        );
      }
  }
});

test('FrameRgn rasterizes outlines exceeding the owned-region band budget without weakening that budget', (t) => {
  const { r, call, put, data } = setup(t),
    sample = shapeOracle.cases[278];
  const p = r.allocate(40);
  put(p, sample.args.slice(2));
  const shape = call('CreatePolygonRgn', p, 5, 1);
  assert.ok(shape);
  assert.equal(data(shape).words[2], 226);
  const display = r.apiProvider.get('user32.dll!GetDC')(r, () => 0).result,
    dc = call('CreateCompatibleDC', display),
    bitmap = call('CreateCompatibleBitmap', display, 480, 280);
  call('SelectObject', dc, bitmap);
  const all = r.allocate(16);
  put(all, [0, 0, 480, 280]);
  r.apiProvider.get('user32.dll!FillRect')(r, (i) => [dc, all, call('GetStockObject', 0)][i]);
  const brush = call('CreateSolidBrush', 0xff);
  assert.equal(call('FrameRgn', dc, shape, brush, 3, 3), 1);
  const pixels = describeGdiBitmap(r, bitmap).pixels;
  for (let y = 80; y < 280; y++)
    for (let x = 0; x < 480; x++) {
      const inside = has(sample.rects, x, y),
        edge =
          inside &&
          ![
            [-3, 0],
            [3, 0],
            [0, -3],
            [0, 3],
          ].every(([dx, dy]) => has(sample.rects, x + dx, y + dy)),
        i = (y * 480 + x) * 4;
      assert.equal(pixels[i], 255);
      assert.equal(pixels[i + 1], edge ? 0 : 255, `${x},${y}`);
      assert.equal(pixels[i + 2], edge ? 0 : 255);
    }
});
