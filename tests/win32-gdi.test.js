import test from 'node:test';
import assert from 'node:assert/strict';
import { gdiApis, flushGdi } from '../src/win32-gdi.js';

const api = (name) => gdiApis[name];

function makeRuntime(flushInitial = true) {
  const memory = new Uint8Array(0x1000);
  const view = new DataView(memory.buffer);
  const events = [];
  const runtime = {
    memory,
    view,
    events,
    lastError: 0,
    emit: (event) => events.push(event),
    check(address, size) {
      if (!Number.isInteger(address) || address < 0 || address + size > memory.length)
        throw Error('guest pointer outside memory');
    },
    read32(address) {
      this.check(address, 4);
      return view.getUint32(address, true);
    },
    write32(address, value) {
      this.check(address, 4);
      view.setUint32(address, value >>> 0, true);
    },
  };
  if (flushInitial) {
    api('user32.dll!GetDesktopWindow')(runtime, () => 0);
    flushGdi(runtime);
    events.length = 0;
  }
  return runtime;
}

function call(runtime, name, ...args) {
  const handler = api(name);
  assert.equal(typeof handler, 'function', `missing API ${name}`);
  return handler(runtime, (index) => args[index] >>> 0);
}

function rect(runtime, address, left, top, right, bottom) {
  runtime.view.setInt32(address, left, true);
  runtime.view.setInt32(address + 4, top, true);
  runtime.view.setInt32(address + 8, right, true);
  runtime.view.setInt32(address + 12, bottom, true);
}

function framePixel(frame, x, y) {
  const offset = (y * frame.width + x) * 4;
  return [...frame.pixels.subarray(offset, offset + 4)];
}

test('new runtime receives an opaque black desktop frame at flush', () => {
  const runtime = makeRuntime(false);
  assert.equal(runtime.events.length, 0);
  call(runtime, 'user32.dll!GetDesktopWindow');
  const frame = flushGdi(runtime);
  assert.equal(runtime.events.length, 1);
  assert.equal(frame.type, 'frame');
  assert.deepEqual(framePixel(frame, 0, 0), [0, 0, 0, 255]);
  assert.equal(flushGdi(runtime), null);
});

test('desktop DC, FillRect, COLORREF conversion, clipping, and flush output', () => {
  const runtime = makeRuntime();
  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  const brush = call(runtime, 'gdi32.dll!CreateSolidBrush', 0x00030201).result;
  rect(runtime, 0x100, -2, -1, 2, 2);

  assert.deepEqual(call(runtime, 'user32.dll!FillRect', hdc, 0x100, brush), {
    result: 1,
    argc: 3,
  });
  assert.equal(runtime.events.length, 0, 'drawing remains buffered until flush');
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 0, 0).result, 0x00030201);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 1, 1).result, 0x00030201);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 2, 1).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 1, 2).result, 0);

  const frame = flushGdi(runtime);
  assert.equal(runtime.events.length, 1);
  assert.equal(frame, runtime.events[0]);
  assert.equal(frame.type, 'frame');
  assert.equal(frame.width, 640);
  assert.equal(frame.height, 480);
  assert.ok(frame.pixels instanceof Uint8ClampedArray);
  assert.deepEqual(framePixel(frame, 0, 0), [1, 2, 3, 255]);
  assert.deepEqual(framePixel(frame, 2, 1), [0, 0, 0, 255]);
  assert.equal(flushGdi(runtime), null, 'unchanged frames are not emitted repeatedly');
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', hwnd, hdc).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', brush).result, 1);
});

test('PatBlt raster operations and SetPixel/GetPixel update RGB framebuffer pixels', () => {
  const runtime = makeRuntime();
  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  const redBrush = call(runtime, 'gdi32.dll!CreateSolidBrush', 0xff).result;
  const oldBrush = call(runtime, 'gdi32.dll!SelectObject', hdc, redBrush).result;
  assert.equal(oldBrush, call(runtime, 'gdi32.dll!GetStockObject', 0).result);

  assert.equal(call(runtime, 'gdi32.dll!PatBlt', hdc, 0, 0, 2, 1, 0x00f00021).result, 1); // PATCOPY
  assert.equal(call(runtime, 'gdi32.dll!PatBlt', hdc, 2, 0, 1, 1, 0x00000042).result, 1); // BLACKNESS
  assert.equal(call(runtime, 'gdi32.dll!PatBlt', hdc, 3, 0, 1, 1, 0x00ff0062).result, 1); // WHITENESS
  assert.equal(call(runtime, 'gdi32.dll!PatBlt', hdc, 3, 0, 1, 1, 0x00550009).result, 1); // DSTINVERT
  assert.equal(call(runtime, 'gdi32.dll!SetPixel', hdc, 4, 0, 0x00abcdef).result, 0x00abcdef);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 4, 0).result, 0x00abcdef);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 0, 0).result, 0x000000ff);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 2, 0).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 3, 0).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, -1, 0).result, 0xffffffff);

  const frame = flushGdi(runtime);
  assert.deepEqual(framePixel(frame, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(framePixel(frame, 2, 0), [0, 0, 0, 255]);
  assert.deepEqual(framePixel(frame, 3, 0), [0, 0, 0, 255]);
  assert.deepEqual(framePixel(frame, 4, 0), [0xef, 0xcd, 0xab, 255]);

  const nullBrush = call(runtime, 'gdi32.dll!GetStockObject', 5).result;
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, nullBrush).result, redBrush);
  const before = call(runtime, 'gdi32.dll!GetPixel', hdc, 5, 0).result;
  assert.equal(call(runtime, 'gdi32.dll!PatBlt', hdc, 5, 0, 1, 1, 0x00f00021).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 5, 0).result, before);
});

test('validates desktop handles, released DCs, stock objects, and brush lifetime', () => {
  const runtime = makeRuntime();
  assert.equal(call(runtime, 'user32.dll!GetDC', 0x999).result, 0);
  assert.equal(runtime.lastError, 1400);

  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  const brush = call(runtime, 'gdi32.dll!CreateSolidBrush', 0x112233).result;
  assert.notEqual(brush, 0);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, brush).result, 0x11001);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', brush).result, 0);
  assert.equal(runtime.lastError, 6, 'a selected brush cannot be deleted');

  const black = call(runtime, 'gdi32.dll!GetStockObject', 4).result;
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', black).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, black).result, brush);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', brush).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, brush).result, 0);
  assert.equal(runtime.lastError, 6, 'deleted handles cannot be selected again');

  assert.equal(call(runtime, 'user32.dll!ReleaseDC', 0x999, hdc).result, 0);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', hwnd, hdc).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 0, 0).result, 0xffffffff);
  assert.equal(runtime.lastError, 6);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', hwnd, hdc).result, 0);
  assert.notEqual(
    call(runtime, 'gdi32.dll!GetStockObject', 7).result,
    0,
    'BLACK_PEN is stock index 7',
  );
  assert.equal(call(runtime, 'gdi32.dll!GetStockObject', 9).result, 0);
  assert.equal(runtime.lastError, 87);
});

test('rejects invalid rectangle pointers, inverted bounds, negative PatBlt extents, and unknown ROPs', () => {
  const runtime = makeRuntime();
  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  const brush = call(runtime, 'gdi32.dll!GetStockObject', 0).result;
  assert.equal(call(runtime, 'user32.dll!FillRect', hdc, 0xff1, brush).result, 0);
  assert.equal(runtime.lastError, 87);

  rect(runtime, 0x100, 2, 0, 1, 1);
  assert.equal(call(runtime, 'user32.dll!FillRect', hdc, 0x100, brush).result, 0);
  assert.equal(runtime.lastError, 87);
  assert.equal(call(runtime, 'gdi32.dll!PatBlt', hdc, 0, 0, -1, 1, 0x00f00021).result, 0);
  assert.equal(runtime.lastError, 87);
  assert.throws(
    () => call(runtime, 'gdi32.dll!PatBlt', hdc, 0, 0, 1, 1, 0x12345678),
    /Unsupported PatBlt raster operation/,
  );
  assert.equal(flushGdi(runtime), null, 'invalid operations do not dirty the framebuffer');
});

test('bounds live DC/brush handles, recovers freed capacity and rejects palette COLORREF forms', () => {
  const runtime = makeRuntime();
  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  const brushes = [];
  for (let i = 0; i < 4095; i++)
    brushes.push(call(runtime, 'gdi32.dll!CreateSolidBrush', i).result);
  assert.equal(
    new Set(brushes).size,
    brushes.length,
    'DC and brush handles use one unique sequence',
  );
  assert.equal(call(runtime, 'gdi32.dll!CreateSolidBrush', 0).result, 0);
  assert.equal(runtime.lastError, 8);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', brushes[0]).result, 1);
  const replacement = call(runtime, 'gdi32.dll!CreateSolidBrush', 0).result;
  assert.ok(replacement, 'deleting an object recovers live handle capacity');
  assert.ok(!brushes.includes(replacement), 'released handles never alias newly allocated objects');

  assert.equal(call(runtime, 'gdi32.dll!CreateSolidBrush', 0x01000000).result, 0);
  assert.equal(runtime.lastError, 87);
  assert.equal(call(runtime, 'gdi32.dll!SetPixel', hdc, 0, 0, 0x020000ff).result, 0xffffffff);
  assert.equal(runtime.lastError, 87);
});
