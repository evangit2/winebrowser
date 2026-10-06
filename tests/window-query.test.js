import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { DESKTOP_WINDOW } from '../src/win32-gdi.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get('user32.dll!' + name)(r, (i) => args[i] >>> 0);
  return { r, api };
}
function window(r, id, parentId, values = {}) {
  const w = {
    id,
    parentId,
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    controlBorder: 0,
    style: parentId ? 0x40000000 : 0x80000000,
    exStyle: 0,
    visible: true,
    enabled: true,
    zOrder: id,
    ...values,
  };
  r.windows.windows.set(id, w);
  return w;
}

test('child hit testing uses client POINT-by-value, immediate siblings, z-order, borders and independent skip flags', (t) => {
  const { r, api } = setup(t);
  window(r, 100, 0, { x: 500, y: 300, width: 120, height: 90 });
  window(r, 101, 100, { x: 10, y: 12, width: 30, height: 20, controlBorder: 2 });
  window(r, 102, 100, { x: 10, y: 12, width: 30, height: 20, visible: false });
  window(r, 103, 100, { x: 10, y: 12, width: 30, height: 20, enabled: false });
  window(r, 104, 100, { x: 10, y: 12, width: 30, height: 20, exStyle: 0x20 });
  window(r, 105, 101, { x: 0, y: 0, width: 30, height: 20 });
  r.lastError = 77;
  assert.deepEqual(api('ChildWindowFromPoint', 100, 10, 12), { result: 104, argc: 3 });
  assert.deepEqual(api('ChildWindowFromPointEx', 100, 10, 12, 0), { result: 104, argc: 4 });
  assert.equal(api('ChildWindowFromPointEx', 100, 10, 12, 4).result, 103);
  assert.equal(api('ChildWindowFromPointEx', 100, 10, 12, 6).result, 102);
  assert.equal(api('ChildWindowFromPointEx', 100, 10, 12, 7).result, 101);
  assert.equal(
    api('ChildWindowFromPointEx', 100, 43, 35, 7).result,
    101,
    'border belongs to child',
  );
  assert.equal(api('ChildWindowFromPointEx', 100, 44, 36, 7).result, 100, 'exclusive outer edge');
  assert.equal(api('ChildWindowFromPoint', 100, -1, 12).result, 0);
  assert.equal(api('ChildWindowFromPoint', 100, 120, 12).result, 0);
  assert.equal(
    api('ChildWindowFromPoint', 100, 500, 300).result,
    0,
    'coordinates are client-relative',
  );
  assert.equal(api('ChildWindowFromPoint', 100, 119, 89).result, 100);
  assert.equal(r.lastError, 77);
  assert.equal(api('ChildWindowFromPointEx', 100, 10, 12, 8).result, 0);
  assert.equal(r.lastError, 87);
  assert.equal(api('ChildWindowFromPoint', 999, 0, 0).result, 0);
  assert.equal(r.lastError, 1400);
});

test('GetTopWindow and IsChild answer real hierarchy without confusing owners, hidden children or self', (t) => {
  const { r, api } = setup(t);
  window(r, 100, 0, { zOrder: 20 });
  window(r, 101, 0, { zOrder: 10, topmost: true, ownerId: 100 });
  window(r, 102, 100, { visible: false });
  window(r, 103, 100);
  window(r, 104, 103);
  assert.equal(api('GetTopWindow', 0).result, 101);
  assert.equal(api('GetTopWindow', DESKTOP_WINDOW).result, 101);
  assert.equal(api('GetTopWindow', 100).result, 103);
  assert.equal(api('GetTopWindow', 103).result, 104);
  assert.equal(api('GetTopWindow', 104).result, 0);
  r.lastError = 77;
  for (const [parent, child, value] of [
    [100, 102, 1],
    [100, 104, 1],
    [103, 104, 1],
    [100, 101, 0],
    [100, 100, 0],
    [103, 102, 0],
    [999, 104, 0],
    [100, 999, 0],
  ])
    assert.equal(api('IsChild', parent, child).result, value);
  assert.equal(r.lastError, 77);
  assert.equal(api('GetTopWindow', 999).result, 0);
  assert.equal(r.lastError, 1400);
  assert.equal(api('ChildWindowFromPointEx', DESKTOP_WINDOW, 0, 0, 0).result, 101);
});

test('SDK rectangle operations handle aliased outputs, empty/negative bounds and subtraction bounding boxes with guards', (t) => {
  const { r, api } = setup(t),
    first = r.allocate(32),
    second = r.allocate(32),
    out = r.allocate(32);
  const put = (p, rect) => rect.forEach((v, i) => r.write32(p + i * 4, v));
  const read = (p) => [0, 4, 8, 12].map((i) => r.read32(p + i) | 0);
  r.lastError = 77;
  for (const [a, b, intersection, union, subtract] of [
    [
      [0, 0, 10, 10],
      [2, 3, 8, 9],
      [2, 3, 8, 9],
      [0, 0, 10, 10],
      [0, 0, 10, 10],
    ],
    [
      [0, 0, 10, 10],
      [-2, -2, 5, 12],
      [0, 0, 5, 10],
      [-2, -2, 10, 12],
      [5, 0, 10, 10],
    ],
    [
      [0, 0, 10, 10],
      [-2, 4, 12, 12],
      [0, 4, 10, 10],
      [-2, 0, 12, 12],
      [0, 0, 10, 4],
    ],
    [
      [0, 0, 10, 10],
      [-2, -2, 12, 12],
      [0, 0, 10, 10],
      [-2, -2, 12, 12],
      [0, 0, 0, 0],
    ],
    [
      [0, 0, 10, 10],
      [10, 0, 20, 10],
      [0, 0, 0, 0],
      [0, 0, 20, 10],
      [0, 0, 10, 10],
    ],
    [
      [3, 3, 1, 1],
      [-4, -4, -1, -1],
      [0, 0, 0, 0],
      [-4, -4, -1, -1],
      [0, 0, 0, 0],
    ],
    [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
  ]) {
    for (const [name, expected] of [
      ['IntersectRect', intersection],
      ['UnionRect', union],
      ['SubtractRect', subtract],
    ]) {
      put(first, a);
      put(second, b);
      r.data.fill(0xcc, out, out + 32);
      const nonempty = expected[0] < expected[2] && expected[1] < expected[3];
      assert.deepEqual(api(name, out, first, second), { result: +nonempty, argc: 3 });
      assert.deepEqual(read(out), expected);
      assert.ok(r.data.subarray(out + 16, out + 32).every((v) => v === 0xcc));
      assert.equal(api(name, first, first, second).result, +nonempty);
      assert.deepEqual(read(first), expected, 'destination aliases first');
      put(first, a);
      put(second, b);
      assert.equal(api(name, second, first, second).result, +nonempty);
      assert.deepEqual(read(second), expected, 'destination aliases second');
    }
  }
  put(first, [-1, -2, 3, 4]);
  assert.deepEqual(api('CopyRect', out, first), { result: 1, argc: 2 });
  assert.deepEqual(read(out), [-1, -2, 3, 4]);
  assert.equal(api('IsRectEmpty', out).result, 0);
  assert.equal(api('SetRectEmpty', out).result, 1);
  assert.equal(api('IsRectEmpty', out).result, 1);
  assert.deepEqual(read(out), [0, 0, 0, 0]);
  assert.equal(api('CopyRect', 0, first).result, 0);
  assert.equal(api('SetRectEmpty', 0).result, 0);
  assert.equal(r.lastError, 77);
});

test('transparent children defer generated paint messages until pending siblings beneath them have painted, preserving filters', (t) => {
  const { r } = setup(t);
  window(r, 100, 0);
  const front = window(r, 101, 100, {
    controlType: 'custom',
    exStyle: 0x20,
    zOrder: 30,
    invalid: [0, 0, 20, 20],
  });
  const middle = window(r, 102, 100, {
    controlType: 'custom',
    exStyle: 0x20,
    zOrder: 20,
    invalid: [0, 0, 20, 20],
  });
  const back = window(r, 103, 100, { controlType: 'custom', zOrder: 10, invalid: [0, 0, 20, 20] });
  window(r, 104, 100, {
    controlType: 'custom',
    visible: false,
    zOrder: 5,
    invalid: [0, 0, 20, 20],
  });
  assert.equal(r.windows.next(0, 15, 15, true).hwnd, 103);
  back.invalid = null;
  assert.equal(r.windows.next(0, 15, 15, true).hwnd, 102);
  middle.invalid = null;
  assert.equal(r.windows.next(0, 15, 15, true).hwnd, 101);
  front.invalid = null;
  assert.equal(r.windows.next(0, 15, 15, true), null);
  front.invalid = [0, 0, 20, 20];
  back.invalid = [0, 0, 20, 20];
  assert.equal(r.windows.next(front.id, 15, 15, true).hwnd, front.id, 'HWND filtering is retained');
  assert.equal(r.windows.next(0, 16, 17, true), null, 'message filtering is retained');
  r.windows.post(front.id, 0x400, 1, 2);
  assert.equal(r.windows.next(0, 0, 0, true).message, 0x400, 'posted messages retain priority');
});
