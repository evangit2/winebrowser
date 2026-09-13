import test from 'node:test';
import assert from 'node:assert/strict';
import { describeGdiFont, gdiApis, flushGdi } from '../src/win32-gdi.js';
import { createCanvasTextRasterizer } from '../src/gdi-text.js';

const call = (runtime, name, ...args) => {
  const handler = gdiApis[name];
  assert.equal(typeof handler, 'function', `missing API ${name}`);
  return handler(runtime, (index) => args[index] >>> 0);
};

function makeRuntime(rasterizer = null) {
  const memory = new Uint8Array(0x4000);
  const view = new DataView(memory.buffer);
  const runtime = {
    memory,
    view,
    lastError: 0,
    events: [],
    emit(event) {
      this.events.push(event);
    },
    check(address, size, write = false) {
      if (!Number.isInteger(address) || address < 0 || size < 0 || address + size > memory.length)
        throw Error('guest range outside memory');
      if (write) return address;
      return address;
    },
    read32(address) {
      this.check(address, 4);
      return view.getUint32(address, true);
    },
    gdiTextRasterizer: rasterizer,
  };
  return runtime;
}

function point(runtime, address, x, y) {
  runtime.view.setInt32(address, x, true);
  runtime.view.setInt32(address + 4, y, true);
}

function framePixel(frame, x, y) {
  const at = (y * frame.width + x) * 4;
  return [...frame.pixels.subarray(at, at + 4)];
}

test('hatch brushes use the six tiled patterns and DC background mode/colors', () => {
  const runtime = makeRuntime();
  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  const hatch = call(runtime, 'gdi32.dll!CreateHatchBrush', 0, 0x000000ff).result;
  assert.ok(hatch);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, hatch).result, 0x11001);
  assert.equal(call(runtime, 'gdi32.dll!SetBkColor', hdc, 0x0000ff00).result, 0xffffff);
  assert.equal(call(runtime, 'gdi32.dll!SetBkMode', hdc, 2).result, 2);
  runtime.view.setInt32(0x100, 0, true);
  runtime.view.setInt32(0x104, 0, true);
  runtime.view.setInt32(0x108, 8, true);
  runtime.view.setInt32(0x10c, 2, true);
  assert.equal(call(runtime, 'user32.dll!FillRect', hdc, 0x100, hatch).result, 1);
  const frame = flushGdi(runtime);
  assert.deepEqual(framePixel(frame, 0, 0), [255, 0, 0, 255], 'horizontal hatch ink');
  assert.deepEqual(framePixel(frame, 1, 0), [255, 0, 0, 255]);
  assert.deepEqual(framePixel(frame, 0, 1), [0, 255, 0, 255], 'opaque hatch background');
  assert.equal(call(runtime, 'gdi32.dll!SetBkMode', hdc, 1).result, 2);
  assert.equal(call(runtime, 'gdi32.dll!CreateHatchBrush', 6, 0).result, 0);
  assert.equal(runtime.lastError, 87);
});

test('solid cosmetic pen, current point output, line endpoint exclusion, and object lifetime', () => {
  const runtime = makeRuntime();
  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  const pen = call(runtime, 'gdi32.dll!CreatePen', 0, 1, 0x000000ff).result;
  assert.ok(pen);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, pen).result, 0x11101);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', pen).result, 0);
  assert.equal(runtime.lastError, 6);
  assert.equal(call(runtime, 'gdi32.dll!MoveToEx', hdc, 1, 2, 0x100).result, 1);
  point(runtime, 0x100, 7, 8);
  assert.equal(call(runtime, 'gdi32.dll!MoveToEx', hdc, 1, 2, 0x100).result, 1);
  assert.deepEqual(
    [runtime.view.getInt32(0x100, true), runtime.view.getInt32(0x104, true)],
    [1, 2],
  );
  assert.equal(call(runtime, 'gdi32.dll!LineTo', hdc, 5, 2).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 1, 2).result, 0xff);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 4, 2).result, 0xff);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', hdc, 5, 2).result, 0);
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, 0x11101).result, pen);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', pen).result, 1);
  assert.equal(call(runtime, 'gdi32.dll!CreatePen', 1, 1, 0).result, 0);
});

test('CreateFontA/W descriptors and TextOut use an injected real-rasterizer boundary', () => {
  const seen = [];
  const runtime = makeRuntime({
    rasterize(text, font) {
      seen.push({ text, css: font.css });
      return { width: 2, height: 2, alpha: new Uint8Array([255, 0, 0, 128]) };
    },
  });
  runtime.memory.set(new TextEncoder().encode('Arial\0'), 0x200);
  const font = call(
    runtime,
    'gdi32.dll!CreateFontA',
    12,
    0,
    0,
    0,
    700,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0x200,
  ).result;
  assert.ok(font);
  const descriptor = describeGdiFont(runtime, font);
  assert.equal(descriptor.face, 'Arial');
  assert.equal(descriptor.height, 12);
  assert.match(descriptor.css, /700 12px/);
  descriptor.css = 'mutated';
  assert.notEqual(describeGdiFont(runtime, font).css, 'mutated', 'descriptor is cloned');

  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, font).result, 0x11104);
  assert.equal(call(runtime, 'gdi32.dll!SetBkMode', hdc, 1).result, 2);
  call(runtime, 'gdi32.dll!SetTextColor', hdc, 0x000000ff);
  runtime.memory.set([0x41, 0x42], 0x240);
  assert.equal(call(runtime, 'gdi32.dll!TextOutA', hdc, 3, 4, 0x240, 2).result, 1);
  assert.deepEqual(seen, [{ text: 'AB', css: '700 12px "Arial"' }]);
  let frame = flushGdi(runtime);
  assert.deepEqual(framePixel(frame, 3, 4), [255, 0, 0, 255]);
  assert.deepEqual(
    framePixel(frame, 4, 4),
    [0, 0, 0, 255],
    'transparent mask leaves surface intact',
  );
  assert.deepEqual(framePixel(frame, 4, 5), [128, 0, 0, 255], 'glyph antialias is composited');

  runtime.view.setUint16(0x260, 0x03a9, true);
  assert.equal(call(runtime, 'gdi32.dll!TextOutW', hdc, 0, 0, 0x260, 1).result, 1);
  assert.equal(seen.at(-1).text, 'Ω');
  assert.equal(
    call(runtime, 'gdi32.dll!DeleteObject', font).result,
    0,
    'selected font stays alive',
  );
  assert.equal(call(runtime, 'gdi32.dll!SelectObject', hdc, 0x11104).result, font);
  assert.equal(call(runtime, 'gdi32.dll!DeleteObject', font).result, 1);
});

test('TextOut rejects absent backend, invalid text ranges, and unsupported font transforms', () => {
  const runtime = makeRuntime();
  const hwnd = call(runtime, 'user32.dll!GetDesktopWindow').result;
  const hdc = call(runtime, 'user32.dll!GetDC', hwnd).result;
  assert.equal(call(runtime, 'gdi32.dll!TextOutA', hdc, 0, 0, 0x3fff, 2).result, 0);
  assert.equal(runtime.lastError, 87);
  assert.equal(call(runtime, 'gdi32.dll!TextOutA', hdc, 0, 0, 0, 1).result, 0);
  assert.equal(runtime.lastError, 87);
  assert.equal(call(runtime, 'gdi32.dll!TextOutA', hdc, 0, 0, 0, 0).result, 0);
  assert.equal(runtime.lastError, 120, 'valid text fails explicitly without Canvas backend');
  runtime.memory.set(new TextEncoder().encode('A\0'), 0x200);
  assert.equal(
    call(runtime, 'gdi32.dll!CreateFontA', 12, 0, 900, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, 0x200)
      .result,
    0,
    'rotated text is not silently approximated',
  );
});

test('GetDC does not create an invisible GDI surface for DOM-backed child controls', () => {
  const runtime = makeRuntime();
  runtime.windows = {
    windows: new Map([[0x222, { id: 0x222, controlType: 'edit', width: 80, height: 20 }]]),
  };
  assert.equal(call(runtime, 'user32.dll!GetDC', 0x222).result, 0);
  assert.equal(runtime.lastError, 120);
});

test('canvas text backend reuses bounded surfaces and keys cached masks by CSS font and height', () => {
  let canvases = 0;
  let drawCalls = 0;
  class TestCanvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      canvases++;
    }
    getContext() {
      const canvas = this;
      return {
        font: '',
        textBaseline: '',
        fillStyle: '',
        measureText(text) {
          return { width: text.length * 2, actualBoundingBoxAscent: 5 };
        },
        clearRect() {},
        fillText() {
          drawCalls++;
        },
        getImageData() {
          return { data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255) };
        },
      };
    }
  }
  const backend = createCanvasTextRasterizer(TestCanvas);
  const regular = { css: '12px Arial', height: 12 };
  const first = backend.rasterize('score', regular);
  assert.equal(canvases, 2, 'measure and glyph canvases are created once');
  assert.equal(
    backend.rasterize('score', regular),
    first,
    'identical raster requests reuse the mask',
  );
  assert.equal(drawCalls, 1);
  backend.rasterize('score', { css: 'bold 12px Arial', height: 12 });
  backend.rasterize('score', { css: '12px Arial', height: 13 });
  assert.equal(drawCalls, 3, 'the cache key includes complete CSS font and requested height');
  assert.equal(canvases, 2, 'text updates reuse the two worker-local canvases');
});
