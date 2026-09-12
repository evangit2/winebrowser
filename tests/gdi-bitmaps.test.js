import test from 'node:test';
import assert from 'node:assert/strict';
import { flushGdi, gdiApis } from '../src/win32-gdi.js';

const SRCCOPY = 0x00cc0020;

function makeRuntime({ window = null } = {}) {
  const events = [];
  const runtime = {
    events,
    lastError: 0,
    emit(event) {
      events.push(event);
    },
    check(address, size) {
      if (!Number.isInteger(address) || address < 0 || address + size > 0x1000)
        throw Error('invalid guest pointer');
    },
    read32() {
      return 0;
    },
    write32() {},
    windows: { windows: new Map(window ? [[window.id, window]] : []) },
  };
  call(runtime, 'user32.dll!GetDesktopWindow');
  flushGdi(runtime);
  events.length = 0;
  return runtime;
}

function call(runtime, name, ...args) {
  const handler = gdiApis[name];
  assert.equal(typeof handler, 'function', `missing API ${name}`);
  return handler(runtime, (index) => args[index] >>> 0);
}

test('compatible memory DC bitmaps draw, blit to a window, and flush the changed client frame', () => {
  const runtime = makeRuntime({ window: { id: 0x222, width: 8, height: 6 } });
  const windowDC = call(runtime, 'user32.dll!GetDC', 0x222).result;
  const memoryDC = call(runtime, 'gdi32.dll!CreateCompatibleDC', windowDC).result;
  const bitmap = call(runtime, 'gdi32.dll!CreateCompatibleBitmap', windowDC, 3, 2).result;
  assert.ok(windowDC && memoryDC && bitmap);
  const stockBitmap = call(runtime, 'gdi32.dll!SelectObject', memoryDC, bitmap).result;
  assert.ok(stockBitmap, 'a memory DC begins with a 1-by-1 stock bitmap selected');
  assert.equal(call(runtime, 'gdi32.dll!SetPixel', memoryDC, 0, 0, 0x00030201).result, 0x00030201);
  assert.equal(call(runtime, 'gdi32.dll!SetPixel', memoryDC, 1, 0, 0x00060504).result, 0x00060504);
  assert.equal(call(runtime, 'gdi32.dll!SetPixel', memoryDC, 2, 1, 0x00090807).result, 0x00090807);

  assert.equal(
    call(runtime, 'gdi32.dll!BitBlt', windowDC, 2, 1, 3, 2, memoryDC, 0, 0, SRCCOPY).result,
    1,
  );
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', windowDC, 2, 1).result, 0x00030201);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', windowDC, 3, 1).result, 0x00060504);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', windowDC, 4, 2).result, 0x00090807);

  const frames = runtime.events.filter((event) => event.type === 'frame');
  assert.equal(frames.length, 0, 'memory drawing and BitBlt buffer output until flush');
  flushGdi(runtime);
  const frame = runtime.events.find((event) => event.type === 'frame' && event.windowId === 0x222);
  assert.ok(frame);
  const offset = (1 * frame.width + 2) * 4;
  assert.deepEqual([...frame.pixels.subarray(offset, offset + 4)], [1, 2, 3, 255]);

  assert.equal(call(runtime, 'gdi32.dll!SelectObject', memoryDC, stockBitmap).result, bitmap);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', bitmap).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', memoryDC).result, 1);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', 0x222, windowDC).result, 1);
});

test('BitBlt clips the destination and translates source coordinates; bad source extents do not write', () => {
  const runtime = makeRuntime({ window: { id: 0x223, width: 5, height: 4 } });
  const destinationDC = call(runtime, 'user32.dll!GetDC', 0x223).result;
  const sourceDC = call(runtime, 'gdi32.dll!CreateCompatibleDC', destinationDC).result;
  const bitmap = call(runtime, 'gdi32.dll!CreateCompatibleBitmap', destinationDC, 4, 3).result;
  const defaultBitmap = call(runtime, 'gdi32.dll!SelectObject', sourceDC, bitmap).result;
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 4; x++) call(runtime, 'gdi32.dll!SetPixel', sourceDC, x, y, 1 + x + y * 16);

  assert.equal(
    call(runtime, 'gdi32.dll!BitBlt', destinationDC, -1, 1, 4, 3, sourceDC, 0, 0, SRCCOPY).result,
    1,
  );
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', destinationDC, 0, 1).result, 2);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', destinationDC, 2, 3).result, 36);
  assert.equal(
    call(runtime, 'gdi32.dll!BitBlt', destinationDC, 4, 3, 3, 2, sourceDC, 0, 0, SRCCOPY).result,
    1,
  );
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', destinationDC, 4, 3).result, 1);

  const before = call(runtime, 'gdi32.dll!GetPixel', destinationDC, 4, 0).result;
  assert.equal(
    call(runtime, 'gdi32.dll!BitBlt', destinationDC, 4, 0, 2, 1, sourceDC, 4, 0, SRCCOPY).result,
    0,
  );
  assert.equal(runtime.lastError, 87);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', destinationDC, 4, 0).result, before);

  assert.equal(call(runtime, 'gdi32.dll!SelectObject', sourceDC, defaultBitmap).result, bitmap);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', bitmap).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', sourceDC).result, 1);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', 0x223, destinationDC).result, 1);
});

test('BitBlt overlap on one surface behaves like a snapshot copy', () => {
  const runtime = makeRuntime();
  const desktop = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const dc = call(runtime, 'user32.dll!GetDC', desktop).result;
  for (let x = 0; x < 5; x++) call(runtime, 'gdi32.dll!SetPixel', dc, x, 0, x + 1);

  assert.equal(call(runtime, 'gdi32.dll!BitBlt', dc, 1, 0, 4, 1, dc, 0, 0, SRCCOPY).result, 1);
  assert.deepEqual(
    Array.from({ length: 5 }, (_, x) => call(runtime, 'gdi32.dll!GetPixel', dc, x, 0).result),
    [1, 1, 2, 3, 4],
  );
  assert.equal(call(runtime, 'gdi32.dll!BitBlt', dc, 0, 1, 5, 1, dc, 0, 0, SRCCOPY).result, 1);
  assert.deepEqual(
    Array.from({ length: 5 }, (_, x) => call(runtime, 'gdi32.dll!GetPixel', dc, x, 1).result),
    [1, 1, 2, 3, 4],
  );
});

test('monochrome BitBlt conversion uses source background and destination text/background colors', () => {
  const runtime = makeRuntime();
  const screen = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const sourceDC = call(runtime, 'user32.dll!GetDC', screen).result;
  const monoDC = call(runtime, 'gdi32.dll!CreateCompatibleDC', sourceDC).result;
  const monoBitmap = call(runtime, 'gdi32.dll!CreateCompatibleBitmap', monoDC, 3, 1).result;
  const defaultMono = call(runtime, 'gdi32.dll!SelectObject', monoDC, monoBitmap).result;

  assert.equal(call(runtime, 'gdi32.dll!SetBkColor', sourceDC, 0x0000ff00).result, 0x00ffffff);
  assert.equal(call(runtime, 'gdi32.dll!SetBkColor', sourceDC, 0x0000ff00).result, 0x0000ff00);
  assert.equal(call(runtime, 'gdi32.dll!SetTextColor', sourceDC, 0x00aa0000).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!SetBkColor', monoDC, 0x123456).result, 0x00ffffff);
  assert.equal(call(runtime, 'gdi32.dll!SetTextColor', monoDC, 0xfedcba).result, 0);

  call(runtime, 'gdi32.dll!SetPixel', sourceDC, 0, 0, 0x0000ff00); // source background -> mono white
  call(runtime, 'gdi32.dll!SetPixel', sourceDC, 1, 0, 0x000000ff); // non-background -> mono black
  call(runtime, 'gdi32.dll!SetPixel', sourceDC, 2, 0, 0x00ffffff); // also non-background -> mono black
  assert.equal(
    call(runtime, 'gdi32.dll!BitBlt', monoDC, 0, 0, 3, 1, sourceDC, 0, 0, SRCCOPY).result,
    1,
  );
  assert.deepEqual(
    Array.from({ length: 3 }, (_, x) => call(runtime, 'gdi32.dll!GetPixel', monoDC, x, 0).result),
    [0x00ffffff, 0, 0],
  );

  const destinationDC = call(runtime, 'user32.dll!GetDC', screen).result;
  assert.equal(call(runtime, 'gdi32.dll!SetTextColor', destinationDC, 0x000000ff).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!SetBkColor', destinationDC, 0x0000ff00).result, 0x00ffffff);
  assert.equal(
    call(runtime, 'gdi32.dll!BitBlt', destinationDC, 10, 0, 3, 1, monoDC, 0, 0, SRCCOPY).result,
    1,
  );
  assert.deepEqual(
    Array.from(
      { length: 3 },
      (_, x) => call(runtime, 'gdi32.dll!GetPixel', destinationDC, x + 10, 0).result,
    ),
    [0x0000ff00, 0x000000ff, 0x000000ff],
  );

  assert.equal(call(runtime, 'gdi32.dll!SelectObject', monoDC, defaultMono).result, monoBitmap);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', monoBitmap).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', monoDC).result, 1);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', screen, destinationDC).result, 1);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', screen, sourceDC).result, 1);
});

test('SetBkColor and SetTextColor validate handles/colors and retain independent DC attributes', () => {
  const runtime = makeRuntime();
  const desktop = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const display = call(runtime, 'user32.dll!GetDC', desktop).result;
  const memory = call(runtime, 'gdi32.dll!CreateCompatibleDC', display).result;

  assert.equal(call(runtime, 'gdi32.dll!SetBkColor', display, 0x01000000).result, 0xffffffff);
  assert.equal(runtime.lastError, 87);
  assert.equal(call(runtime, 'gdi32.dll!SetTextColor', 0xdead, 0x112233).result, 0xffffffff);
  assert.equal(runtime.lastError, 6);
  assert.equal(call(runtime, 'gdi32.dll!SetBkColor', memory, 0x0000ff00).result, 0x00ffffff);
  assert.equal(call(runtime, 'gdi32.dll!SetTextColor', memory, 0x000000ff).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!SetBkColor', memory, 0x0000ff00).result, 0x0000ff00);
  assert.equal(call(runtime, 'gdi32.dll!SetTextColor', memory, 0x000000ff).result, 0x000000ff);

  const defaultBitmap = call(runtime, 'gdi32.dll!SelectObject', memory, 0x12345678).result;
  assert.equal(defaultBitmap, 0);
  assert.equal(runtime.lastError, 6);
  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', memory).result, 1);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', desktop, display).result, 1);
});

test('bitmap and memory DC handles enforce type, selection, and deletion lifetime rules', () => {
  const runtime = makeRuntime();
  const screen = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const displayDC = call(runtime, 'user32.dll!GetDC', screen).result;
  const firstDC = call(runtime, 'gdi32.dll!CreateCompatibleDC', displayDC).result;
  const secondDC = call(runtime, 'gdi32.dll!CreateCompatibleDC', 0).result;
  const bitmap = call(runtime, 'gdi32.dll!CreateCompatibleBitmap', displayDC, 2, 2).result;
  const defaultBitmap = call(runtime, 'gdi32.dll!SelectObject', firstDC, bitmap).result;

  assert.equal(call(runtime, 'gdi32.dll!SelectObject', firstDC, defaultBitmap).result, bitmap);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', secondDC, defaultBitmap).result, 0);
  assert.equal(runtime.lastError, 6, 'another DC cannot steal the selected stock bitmap');
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', defaultBitmap).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!SetPixel', firstDC, 0, 0, 0x112233).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', firstDC, 0, 0).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', firstDC, bitmap).result, defaultBitmap);

  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', bitmap).result, 0);
  assert.equal(runtime.lastError, 6, 'a bitmap selected into a DC cannot be deleted');
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', secondDC, bitmap).result, 0);
  assert.equal(runtime.lastError, 6, 'one bitmap cannot be selected into two DCs');
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', displayDC, bitmap).result, 0);
  assert.equal(runtime.lastError, 6, 'bitmaps cannot be selected into display DCs');
  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', displayDC).result, 0);
  assert.equal(runtime.lastError, 6, 'DeleteDC applies to memory DCs only');
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', 0, firstDC).result, 0);
  assert.equal(runtime.lastError, 6, 'ReleaseDC does not dispose memory DCs');

  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', firstDC).result, 1);
  assert.equal(
    call(runtime, 'gdi32.dll!DeleteObject', bitmap).result,
    1,
    'deleting the DC deselects its bitmap',
  );
  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', firstDC).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', secondDC, defaultBitmap).result, 0);
  assert.equal(runtime.lastError, 6, 'the former DC stock bitmap dies with its DC');

  const monoDefault = call(runtime, 'gdi32.dll!SelectObject', secondDC, 0x12345678).result;
  assert.equal(monoDefault, 0);
  assert.equal(runtime.lastError, 6);
  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', secondDC).result, 1);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', screen, displayDC).result, 1);
});

test('compatible bitmap dimensions and unsupported BitBlt raster operations fail explicitly', () => {
  const runtime = makeRuntime();
  const screen = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const dc = call(runtime, 'user32.dll!GetDC', screen).result;
  assert.equal(call(runtime, 'gdi32.dll!CreateCompatibleBitmap', 0, 2, 2).result, 0);
  assert.equal(runtime.lastError, 6, 'CreateCompatibleBitmap requires an existing HDC');
  assert.equal(call(runtime, 'gdi32.dll!CreateCompatibleBitmap', dc, -1, 4).result, 0);
  assert.equal(runtime.lastError, 87);
  assert.equal(call(runtime, 'gdi32.dll!CreateCompatibleBitmap', 0xdead, 2, 2).result, 0);
  assert.equal(runtime.lastError, 6);
  const memoryDC = call(runtime, 'gdi32.dll!CreateCompatibleDC', dc).result;
  const monoBitmap = call(runtime, 'gdi32.dll!CreateCompatibleBitmap', dc, 0, 8).result;
  assert.ok(monoBitmap);
  const defaultBitmap = call(runtime, 'gdi32.dll!SelectObject', memoryDC, monoBitmap).result;
  assert.equal(call(runtime, 'gdi32.dll!SetPixel', memoryDC, 0, 0, 0x123456).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', memoryDC, 0, 0).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!SetPixel', memoryDC, 1, 0, 0x123456).result, 0xffffffff);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', memoryDC, defaultBitmap).result, monoBitmap);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', monoBitmap).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!DeleteDC', memoryDC).result, 1);
  assert.throws(
    () => call(runtime, 'gdi32.dll!BitBlt', dc, 0, 0, 1, 1, dc, 0, 0, 0x12345678),
    /Unsupported BitBlt raster operation/,
  );
  assert.equal(call(runtime, 'gdi32.dll!BitBlt', dc, 0, 0, -1, 1, dc, 0, 0, SRCCOPY).result, 0);
  assert.equal(runtime.lastError, 87);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', screen, dc).result, 1);
});
