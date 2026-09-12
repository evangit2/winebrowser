const WIDTH = 640;
const HEIGHT = 480;
const DESKTOP_WINDOW = 0x101;
const STOCK_WHITE_BRUSH = 0x11001;
const STOCK_BLACK_BRUSH = 0x11002;
const STOCK_NULL_BRUSH = 0x11003;
const PATCOPY = 0x00f00021;
const BLACKNESS = 0x00000042;
const WHITENESS = 0x00ff0062;
const DSTINVERT = 0x00550009;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_WINDOW_HANDLE = 1400;
const CLR_INVALID = 0xffffffff;

const states = new WeakMap();

function success(result = 0, argc = 0) {
  return { result, argc };
}

function failure(runtime, error, result = 0, argc = 0) {
  runtime.lastError = error;
  return success(result, argc);
}

function stateFor(runtime) {
  if (!runtime || (typeof runtime !== 'object' && typeof runtime !== 'function'))
    throw new TypeError('GDI APIs require a runtime object');
  let state = states.get(runtime);
  if (!state) {
    const pixels = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    const brushes = new Map([
      [STOCK_WHITE_BRUSH, { kind: 'brush', stock: true, color: 0xffffff }],
      [STOCK_BLACK_BRUSH, { kind: 'brush', stock: true, color: 0x000000 }],
      [STOCK_NULL_BRUSH, { kind: 'brush', stock: true, null: true }],
    ]);
    state = {
      width: WIDTH,
      height: HEIGHT,
      pixels,
      dirty: true,
      brushes,
      dcs: new Map(),
      nextHandle: 0x12000,
    };
    states.set(runtime, state);
  }
  return state;
}

function allocateHandle(runtime, state, argc) {
  if (state.dcs.size + state.brushes.size - 3 >= 4096 || state.nextHandle >= 0x10000000)
    return failure(runtime, ERROR_NOT_ENOUGH_MEMORY, 0, argc);
  const handle = state.nextHandle++ >>> 0;
  return success(handle, argc);
}

function signed(value) {
  return value | 0;
}

function colorRgb(color) {
  const value = color >>> 0;
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

function rgbColorRef(rgb) {
  return ((rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
}

function getDc(state, handle) {
  const dc = state.dcs.get(handle >>> 0);
  return dc?.active ? dc : null;
}

function getBrush(state, handle) {
  return state.brushes.get(handle >>> 0) ?? null;
}

function badDc(runtime, argc, invalidResult = 0) {
  return failure(runtime, ERROR_INVALID_HANDLE, invalidResult, argc);
}

function bounds(left, top, right, bottom, state) {
  return [
    Math.max(0, Math.min(state.width, left)),
    Math.max(0, Math.min(state.height, top)),
    Math.max(0, Math.min(state.width, right)),
    Math.max(0, Math.min(state.height, bottom)),
  ];
}

function paintRect(state, left, top, right, bottom, brush, operation = 'copy') {
  if (brush?.null && operation === 'copy') return false;
  const [x1, y1, x2, y2] = bounds(left, top, right, bottom, state);
  if (x1 >= x2 || y1 >= y2) return false;
  const rgb = brush ? colorRgb(brush.color ?? 0) : [0, 0, 0];
  const pixels = state.pixels;
  let changed = false;
  for (let y = y1; y < y2; y++) {
    let offset = (y * state.width + x1) * 4;
    for (let x = x1; x < x2; x++, offset += 4) {
      let r = rgb[0],
        g = rgb[1],
        b = rgb[2];
      if (operation === 'invert') {
        r = 255 - pixels[offset];
        g = 255 - pixels[offset + 1];
        b = 255 - pixels[offset + 2];
      }
      if (
        pixels[offset] !== r ||
        pixels[offset + 1] !== g ||
        pixels[offset + 2] !== b ||
        pixels[offset + 3] !== 255
      )
        changed = true;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }
  if (changed) state.dirty = true;
  return changed;
}

function readRect(runtime, address) {
  try {
    runtime.check(address, 16);
    return [
      signed(runtime.read32(address)),
      signed(runtime.read32(address + 4)),
      signed(runtime.read32(address + 8)),
      signed(runtime.read32(address + 12)),
    ];
  } catch {
    return null;
  }
}

function getDesktopWindow(runtime) {
  stateFor(runtime);
  return success(DESKTOP_WINDOW);
}

function getDC(runtime, argument) {
  const state = stateFor(runtime);
  const hwnd = argument(0) >>> 0;
  if (hwnd !== 0 && hwnd !== DESKTOP_WINDOW)
    return failure(runtime, ERROR_INVALID_WINDOW_HANDLE, 0, 1);
  const allocated = allocateHandle(runtime, state, 1);
  if (!allocated.result) return allocated;
  const handle = allocated.result;
  state.dcs.set(handle, { kind: 'dc', hwnd, active: true, brush: STOCK_WHITE_BRUSH });
  return allocated;
}

function releaseDC(runtime, argument) {
  const state = stateFor(runtime);
  const hwnd = argument(0) >>> 0;
  const handle = argument(1) >>> 0;
  const dc = getDc(state, handle);
  if (!dc || dc.hwnd !== hwnd) return failure(runtime, ERROR_INVALID_HANDLE, 0, 2);
  dc.active = false;
  state.dcs.delete(handle);
  return success(1, 2);
}

function createSolidBrush(runtime, argument) {
  const state = stateFor(runtime);
  const color = argument(0) >>> 0;
  // PALETTERGB/PALETTEINDEX values use a nonzero high byte; this framebuffer
  // supports literal RGB COLORREF values only.
  if (color & 0xff000000) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
  const allocated = allocateHandle(runtime, state, 1);
  if (!allocated.result) return allocated;
  state.brushes.set(allocated.result, { kind: 'brush', stock: false, color });
  return allocated;
}

function getStockObject(runtime, argument) {
  const index = argument(0) >>> 0;
  const handle =
    index === 0
      ? STOCK_WHITE_BRUSH
      : index === 4
        ? STOCK_BLACK_BRUSH
        : index === 5
          ? STOCK_NULL_BRUSH
          : 0;
  if (!handle) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
  stateFor(runtime);
  return success(handle, 1);
}

function selectObject(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(state, argument(0));
  if (!dc) return badDc(runtime, 2);
  const object = getBrush(state, argument(1));
  if (!object) return failure(runtime, ERROR_INVALID_HANDLE, 0, 2);
  const previous = dc.brush;
  dc.brush = argument(1) >>> 0;
  return success(previous, 2);
}

function deleteObject(runtime, argument) {
  const state = stateFor(runtime);
  const handle = argument(0) >>> 0;
  const brush = getBrush(state, handle);
  if (!brush) return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  if (brush.stock) return success(1, 1);
  for (const dc of state.dcs.values())
    if (dc.active && dc.brush === handle) return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  state.brushes.delete(handle);
  return success(1, 1);
}

function fillRect(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(state, argument(0));
  if (!dc) return badDc(runtime, 3);
  const rect = readRect(runtime, argument(1));
  if (!rect) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  const brush = getBrush(state, argument(2));
  if (!brush) return failure(runtime, ERROR_INVALID_HANDLE, 0, 3);
  const [left, top, right, bottom] = rect;
  if (right < left || bottom < top) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  paintRect(state, left, top, right, bottom, brush);
  // FillRect includes left/top and excludes right/bottom edges.
  return success(1, 3);
}

function patBlt(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(state, argument(0));
  if (!dc) return badDc(runtime, 6);
  const x = signed(argument(1));
  const y = signed(argument(2));
  const width = signed(argument(3));
  const height = signed(argument(4));
  const rop = argument(5) >>> 0;
  if (width < 0 || height < 0) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 6);
  let brush = null,
    operation = 'copy';
  if (rop === PATCOPY) {
    brush = getBrush(state, dc.brush);
    if (!brush) return failure(runtime, ERROR_INVALID_HANDLE, 0, 6);
  } else if (rop === BLACKNESS) brush = { color: 0 };
  else if (rop === WHITENESS) brush = { color: 0xffffff };
  else if (rop === DSTINVERT) operation = 'invert';
  else throw Error(`Unsupported PatBlt raster operation 0x${rop.toString(16)}`);
  paintRect(state, x, y, x + width, y + height, brush, operation);
  return success(1, 6);
}

function setPixel(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(state, argument(0));
  if (!dc) return badDc(runtime, 4, CLR_INVALID);
  const x = signed(argument(1)),
    y = signed(argument(2));
  if (x < 0 || y < 0 || x >= state.width || y >= state.height)
    return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 4);
  const color = argument(3) >>> 0;
  if (color & 0xff000000) return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 4);
  const rgb = colorRgb(color);
  const offset = (y * state.width + x) * 4;
  const pixels = state.pixels;
  if (pixels[offset] !== rgb[0] || pixels[offset + 1] !== rgb[1] || pixels[offset + 2] !== rgb[2])
    state.dirty = true;
  pixels[offset] = rgb[0];
  pixels[offset + 1] = rgb[1];
  pixels[offset + 2] = rgb[2];
  pixels[offset + 3] = 255;
  return success(rgbColorRef(rgb), 4);
}

function getPixel(runtime, argument) {
  const state = stateFor(runtime);
  if (!getDc(state, argument(0))) return badDc(runtime, 3, CLR_INVALID);
  const x = signed(argument(1)),
    y = signed(argument(2));
  if (x < 0 || y < 0 || x >= state.width || y >= state.height)
    return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 3);
  const offset = (y * state.width + x) * 4;
  return success(rgbColorRef(state.pixels.subarray(offset, offset + 3)), 3);
}

export const gdiApis = {
  'user32.dll!GetDesktopWindow': getDesktopWindow,
  'user32.dll!GetDC': getDC,
  'user32.dll!ReleaseDC': releaseDC,
  'user32.dll!FillRect': fillRect,
  'gdi32.dll!CreateSolidBrush': createSolidBrush,
  'gdi32.dll!GetStockObject': getStockObject,
  'gdi32.dll!SelectObject': selectObject,
  'gdi32.dll!DeleteObject': deleteObject,
  'gdi32.dll!PatBlt': patBlt,
  'gdi32.dll!SetPixel': setPixel,
  'gdi32.dll!GetPixel': getPixel,
};

/** Emit one copied RGBA frame when drawing changed the virtual desktop. */
export function flushGdi(runtime) {
  const state = states.get(runtime);
  if (!state?.dirty) return null;
  const frame = {
    type: 'frame',
    width: state.width,
    height: state.height,
    pixels: new Uint8ClampedArray(state.pixels),
  };
  state.dirty = false;
  runtime.emit?.(frame);
  return frame;
}
