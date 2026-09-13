import {
  colorRefRgb as colorRgb,
  surfaceRgb,
  rgbColorRef,
  paintRect,
  drawLine,
} from './gdi-raster.js';
import {
  DEFAULT_GDI_FONT,
  makeGdiFontDescriptor,
  readGdiText,
  rasterizeGdiText,
  paintGdiText,
} from './gdi-text.js';

const WIDTH = 640;
const HEIGHT = 480;
const DESKTOP_WINDOW = 0x101;
const STOCK_WHITE_BRUSH = 0x11001;
const STOCK_BLACK_BRUSH = 0x11002;
const STOCK_NULL_BRUSH = 0x11003;
const STOCK_LTGRAY_BRUSH = 0x11004;
const STOCK_GRAY_BRUSH = 0x11005;
const STOCK_DKGRAY_BRUSH = 0x11006;
const STOCK_BLACK_PEN = 0x11101;
const STOCK_WHITE_PEN = 0x11102;
const STOCK_NULL_PEN = 0x11103;
const STOCK_SYSTEM_FONT = 0x11104;
const MAX_WINDOW_WIDTH = 1024;
const MAX_WINDOW_HEIGHT = 768;
const MAX_WINDOW_SURFACES = 8;
const MAX_TOTAL_SURFACE_PIXELS = 16 * 1024 * 1024;
const PATCOPY = 0x00f00021;
const BLACKNESS = 0x00000042;
const WHITENESS = 0x00ff0062;
const DSTINVERT = 0x00550009;
const SRCCOPY = 0x00cc0020;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_WINDOW_HANDLE = 1400;
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const CLR_INVALID = 0xffffffff;
const SYSTEM_COLORS = [
  0xc0c0c0, // COLOR_SCROLLBAR
  0x000000, // COLOR_BACKGROUND
  0x6a240a, // COLOR_ACTIVECAPTION
  0x808080, // COLOR_INACTIVECAPTION
  0xc0c0c0, // COLOR_MENU
  0xffffff, // COLOR_WINDOW
  0x000000, // COLOR_WINDOWFRAME
  0x000000, // COLOR_MENUTEXT
  0x000000, // COLOR_WINDOWTEXT
  0xffffff, // COLOR_CAPTIONTEXT
  0xc0c0c0, // COLOR_ACTIVEBORDER
  0xc0c0c0, // COLOR_INACTIVEBORDER
  0x808080, // COLOR_APPWORKSPACE
  0x802000, // COLOR_HIGHLIGHT
  0xffffff, // COLOR_HIGHLIGHTTEXT
  0xc0c0c0, // COLOR_BTNFACE
  0x808080, // COLOR_BTNSHADOW
  0x808080, // COLOR_GRAYTEXT
  0x000000, // COLOR_BTNTEXT
  0xc0c0c0, // COLOR_INACTIVECAPTIONTEXT
  0xffffff, // COLOR_BTNHIGHLIGHT
  0x404040, // COLOR_3DDKSHADOW
  0xe3e3e3, // COLOR_3DLIGHT
  0x000000, // COLOR_INFOTEXT
  0xe1ffff, // COLOR_INFOBK
  0x000000, // reserved
  0xff0000, // COLOR_HOTLIGHT
  0x6a240a, // COLOR_GRADIENTACTIVECAPTION
  0x808080, // COLOR_GRADIENTINACTIVECAPTION
  0x802000, // COLOR_MENUHILIGHT
  0xc0c0c0, // COLOR_MENUBAR
];

const states = new WeakMap();

function success(result = 0, argc = 0) {
  return { result, argc };
}

function failure(runtime, error, result = 0, argc = 0) {
  runtime.lastError = error;
  return success(result, argc);
}

function opaquePixels(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  return pixels;
}

function stateFor(runtime) {
  if (!runtime || (typeof runtime !== 'object' && typeof runtime !== 'function'))
    throw new TypeError('GDI APIs require a runtime object');
  let state = states.get(runtime);
  if (!state) {
    const pixels = opaquePixels(WIDTH, HEIGHT);
    const brushes = new Map([
      [STOCK_WHITE_BRUSH, { kind: 'brush', stock: true, color: 0xffffff }],
      [STOCK_BLACK_BRUSH, { kind: 'brush', stock: true, color: 0x000000 }],
      [STOCK_NULL_BRUSH, { kind: 'brush', stock: true, null: true }],
      [STOCK_LTGRAY_BRUSH, { kind: 'brush', stock: true, color: 0x00c0c0c0 }],
      [STOCK_GRAY_BRUSH, { kind: 'brush', stock: true, color: 0x00808080 }],
      [STOCK_DKGRAY_BRUSH, { kind: 'brush', stock: true, color: 0x00404040 }],
    ]);
    const pens = new Map([
      [STOCK_BLACK_PEN, { kind: 'pen', stock: true, color: 0, width: 1, style: 0 }],
      [STOCK_WHITE_PEN, { kind: 'pen', stock: true, color: 0xffffff, width: 1, style: 0 }],
      [STOCK_NULL_PEN, { kind: 'pen', stock: true, color: 0, width: 1, style: 5 }],
    ]);
    const fonts = new Map([[STOCK_SYSTEM_FONT, { ...DEFAULT_GDI_FONT, stock: true }]]);
    for (let index = 0; index < SYSTEM_COLORS.length; index++)
      brushes.set(index + 1, {
        kind: 'brush',
        stock: true,
        color: SYSTEM_COLORS[index],
        systemColor: index,
      });
    state = {
      desktopSurface: { width: WIDTH, height: HEIGHT, pixels, dirty: true },
      desktopActive: false,
      brushes,
      pens,
      fonts,
      dcs: new Map(),
      bitmaps: new Map(),
      windowSurfaces: new Map(),
      stockBrushCount: brushes.size,
      stockBitmapCount: 0,
      stockPenCount: pens.size,
      stockFontCount: fonts.size,
      nextHandle: 0x12000,
    };
    states.set(runtime, state);
  }
  return state;
}

function allocateHandle(runtime, state, argc) {
  if (
    state.dcs.size +
      state.brushes.size -
      state.stockBrushCount +
      state.pens.size -
      state.stockPenCount +
      state.fonts.size -
      state.stockFontCount +
      state.bitmaps.size -
      state.stockBitmapCount >=
      4096 ||
    state.nextHandle >= 0x10000000
  )
    return failure(runtime, ERROR_NOT_ENOUGH_MEMORY, 0, argc);
  const handle = state.nextHandle++ >>> 0;
  return success(handle, argc);
}

function signed(value) {
  return value | 0;
}

function getDc(runtime, state, handle) {
  const dc = state.dcs.get(handle >>> 0);
  if (!dc?.active) return null;
  if (dc.kind === 'memory-dc') {
    const bitmap = state.bitmaps.get(dc.bitmap);
    if (!bitmap) return null;
    dc.surface = bitmap;
    return dc;
  }
  if (dc.hwnd === 0 || dc.hwnd === DESKTOP_WINDOW) dc.surface = state.desktopSurface;
  else {
    const window = runtime.windows?.windows?.get(dc.hwnd);
    const surface = state.windowSurfaces.get(dc.hwnd);
    if (!window || !surface) return null;
    dc.surface = surface;
  }
  return dc;
}

function getBrush(state, handle) {
  return state.brushes.get(handle >>> 0) ?? null;
}

function getPen(state, handle) {
  return state.pens.get(handle >>> 0) ?? null;
}

function getFont(state, handle) {
  return state.fonts.get(handle >>> 0) ?? null;
}

function totalSurfacePixels(state) {
  return (
    state.desktopSurface.width * state.desktopSurface.height +
    [...state.windowSurfaces.values()].reduce(
      (sum, surface) => sum + surface.width * surface.height,
      0,
    ) +
    [...state.bitmaps.values()].reduce((sum, bitmap) => sum + bitmap.width * bitmap.height, 0)
  );
}

function badDc(runtime, argc, invalidResult = 0) {
  return failure(runtime, ERROR_INVALID_HANDLE, invalidResult, argc);
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
  stateFor(runtime).desktopActive = true;
  return success(DESKTOP_WINDOW);
}

function getDC(runtime, argument) {
  const state = stateFor(runtime);
  const hwnd = argument(0) >>> 0;
  if (hwnd === 0 || hwnd === DESKTOP_WINDOW) state.desktopActive = true;
  if (hwnd !== 0 && hwnd !== DESKTOP_WINDOW) {
    const window = runtime.windows?.windows?.get(hwnd);
    if (!window) return failure(runtime, ERROR_INVALID_WINDOW_HANDLE, 0, 1);
    if (window.controlType) return failure(runtime, ERROR_CALL_NOT_IMPLEMENTED, 0, 1);
    if (
      !state.windowSurfaces.has(hwnd) &&
      !resizeWindowSurface(runtime, hwnd, window.width, window.height)
    )
      return failure(runtime, ERROR_NOT_ENOUGH_MEMORY, 0, 1);
  }
  const allocated = allocateHandle(runtime, state, 1);
  if (!allocated.result) return allocated;
  const handle = allocated.result;
  state.dcs.set(handle, {
    kind: 'display-dc',
    hwnd,
    active: true,
    brush: STOCK_WHITE_BRUSH,
    pen: STOCK_BLACK_PEN,
    font: STOCK_SYSTEM_FONT,
    textColor: 0,
    backgroundColor: 0xffffff,
    bkMode: 2,
    currentPoint: { x: 0, y: 0 },
  });
  return allocated;
}

/** Resize or create the client-area bitmap backing a virtual HWND. */
export function resizeWindowSurface(runtime, id, width, height) {
  const hwnd = id >>> 0;
  const window = runtime?.windows?.windows?.get(hwnd);
  if (
    !Number.isInteger(id) ||
    id < 1 ||
    id > 0xffffffff ||
    hwnd === 0 ||
    hwnd === DESKTOP_WINDOW ||
    !window ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_WINDOW_WIDTH ||
    height > MAX_WINDOW_HEIGHT
  )
    return false;

  const state = stateFor(runtime);
  const oldSurface = state.windowSurfaces.get(hwnd);
  if (oldSurface?.width === width && oldSurface?.height === height) return true;
  if (!oldSurface && state.windowSurfaces.size >= MAX_WINDOW_SURFACES) return false;
  const totalPixels =
    totalSurfacePixels(state) -
    (oldSurface ? oldSurface.width * oldSurface.height : 0) +
    width * height;
  if (totalPixels > MAX_TOTAL_SURFACE_PIXELS) return false;

  const pixels = opaquePixels(width, height);
  if (oldSurface) {
    const copyWidth = Math.min(width, oldSurface.width);
    const copyHeight = Math.min(height, oldSurface.height);
    for (let y = 0; y < copyHeight; y++) {
      const oldOffset = y * oldSurface.width * 4;
      const newOffset = y * width * 4;
      pixels.set(oldSurface.pixels.subarray(oldOffset, oldOffset + copyWidth * 4), newOffset);
    }
  }
  const surface = { width, height, pixels, dirty: true, windowId: hwnd };
  state.windowSurfaces.set(hwnd, surface);
  for (const dc of state.dcs.values()) if (dc.active && dc.hwnd === hwnd) dc.surface = surface;
  return true;
}

/** Release a guest HWND's framebuffer and any DCs acquired from that window. */
export function destroyWindowSurface(runtime, id) {
  const hwnd = id >>> 0;
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || hwnd === DESKTOP_WINDOW) return false;
  const state = states.get(runtime);
  if (!state?.windowSurfaces.has(hwnd)) return false;
  state.windowSurfaces.delete(hwnd);
  for (const [handle, dc] of state.dcs) if (dc.hwnd === hwnd) state.dcs.delete(handle);
  return true;
}

function releaseDC(runtime, argument) {
  const state = stateFor(runtime);
  const hwnd = argument(0) >>> 0;
  const handle = argument(1) >>> 0;
  const dc = getDc(runtime, state, handle);
  if (!dc || dc.kind !== 'display-dc' || dc.hwnd !== hwnd)
    return failure(runtime, ERROR_INVALID_HANDLE, 0, 2);
  dc.active = false;
  state.dcs.delete(handle);
  return success(1, 2);
}

function createCompatibleDC(runtime, argument) {
  const state = stateFor(runtime);
  const sourceHandle = argument(0) >>> 0;
  if (sourceHandle && !getDc(runtime, state, sourceHandle))
    return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  const dcAllocated = allocateHandle(runtime, state, 1);
  if (!dcAllocated.result) return dcAllocated;
  const bitmapAllocated = allocateHandle(runtime, state, 1);
  if (!bitmapAllocated.result) return bitmapAllocated;

  const dcHandle = dcAllocated.result;
  const bitmapHandle = bitmapAllocated.result;
  const bitmap = {
    kind: 'bitmap',
    stock: true,
    width: 1,
    height: 1,
    monochrome: true,
    pixels: opaquePixels(1, 1),
    dirty: false,
    selectedBy: dcHandle,
  };
  state.bitmaps.set(bitmapHandle, bitmap);
  state.stockBitmapCount++;
  state.dcs.set(dcHandle, {
    kind: 'memory-dc',
    active: true,
    brush: STOCK_WHITE_BRUSH,
    pen: STOCK_BLACK_PEN,
    font: STOCK_SYSTEM_FONT,
    textColor: 0,
    backgroundColor: 0xffffff,
    bkMode: 2,
    currentPoint: { x: 0, y: 0 },
    bitmap: bitmapHandle,
    defaultBitmap: bitmapHandle,
    surface: bitmap,
  });
  return dcAllocated;
}

function createCompatibleBitmap(runtime, argument) {
  const state = stateFor(runtime);
  const dcHandle = argument(0) >>> 0;
  let width = signed(argument(1));
  let height = signed(argument(2));
  if (width < 0 || height < 0) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  if (!dcHandle && width && height) return failure(runtime, ERROR_INVALID_HANDLE, 0, 3);
  const dc = dcHandle ? getDc(runtime, state, dcHandle) : null;
  if (dcHandle && !dc) return failure(runtime, ERROR_INVALID_HANDLE, 0, 3);
  let monochrome = !!dc && dc.kind === 'memory-dc' && !!dc.surface.monochrome;
  if (width === 0 || height === 0) {
    width = 1;
    height = 1;
    monochrome = true;
  }
  if (width > 4096 || height > 4096) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  if (width * height + totalSurfacePixels(state) > MAX_TOTAL_SURFACE_PIXELS)
    return failure(runtime, ERROR_NOT_ENOUGH_MEMORY, 0, 3);
  const allocated = allocateHandle(runtime, state, 3);
  if (!allocated.result) return allocated;
  state.bitmaps.set(allocated.result, {
    kind: 'bitmap',
    stock: false,
    width,
    height,
    monochrome,
    pixels: opaquePixels(width, height),
    dirty: false,
    selectedBy: null,
  });
  return allocated;
}

function deleteDC(runtime, argument) {
  const state = stateFor(runtime);
  const handle = argument(0) >>> 0;
  const dc = getDc(runtime, state, handle);
  if (!dc || dc.kind !== 'memory-dc') return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  const selected = state.bitmaps.get(dc.bitmap);
  if (selected && !selected.stock) selected.selectedBy = null;
  state.bitmaps.delete(dc.defaultBitmap);
  state.stockBitmapCount--;
  state.dcs.delete(handle);
  return success(1, 1);
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

function createHatchBrush(runtime, argument) {
  const state = stateFor(runtime);
  const hatch = argument(0) >>> 0;
  const color = argument(1) >>> 0;
  if (hatch > 5 || color & 0xff000000) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
  const allocated = allocateHandle(runtime, state, 2);
  if (!allocated.result) return allocated;
  state.brushes.set(allocated.result, { kind: 'brush', stock: false, hatch, color });
  return allocated;
}

function createPen(runtime, argument) {
  const state = stateFor(runtime);
  const style = argument(0) >>> 0;
  const width = signed(argument(1));
  const color = argument(2) >>> 0;
  if (style !== 0 || width < 0 || width > 1 || color & 0xff000000)
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  const allocated = allocateHandle(runtime, state, 3);
  if (!allocated.result) return allocated;
  state.pens.set(allocated.result, { kind: 'pen', stock: false, style, width, color });
  return allocated;
}

function setBkMode(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 2);
  const mode = argument(1) >>> 0;
  if (mode !== 1 && mode !== 2) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
  const previous = dc.bkMode;
  dc.bkMode = mode;
  return success(previous, 2);
}

/**
 * Build the supported logical-font subset. The browser font mapper may
 * substitute the requested face, and Canvas metrics/rasterization are device
 * dependent. Width, escapement/orientation, nondefault precisions, and
 * nondefault pitch/family are rejected rather than approximated silently.
 */
function createFont(runtime, argument, wide) {
  const state = stateFor(runtime);
  let descriptor;
  try {
    descriptor = makeGdiFontDescriptor(runtime, argument, wide);
  } catch {
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 14);
  }
  const allocated = allocateHandle(runtime, state, 14);
  if (!allocated.result) return allocated;
  state.fonts.set(allocated.result, { ...descriptor, stock: false });
  return allocated;
}

function setDcColor(runtime, argument, property) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 2, CLR_INVALID);
  const color = argument(1) >>> 0;
  if (color & 0xff000000) return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 2);
  const previous = dc[property];
  dc[property] = color;
  return success(previous, 2);
}

function setBkColor(runtime, argument) {
  return setDcColor(runtime, argument, 'backgroundColor');
}

function setTextColor(runtime, argument) {
  return setDcColor(runtime, argument, 'textColor');
}

function getStockObject(runtime, argument) {
  const index = argument(0) >>> 0;
  const handles = new Map([
    [0, STOCK_WHITE_BRUSH],
    [1, STOCK_LTGRAY_BRUSH],
    [2, STOCK_GRAY_BRUSH],
    [3, STOCK_DKGRAY_BRUSH],
    [4, STOCK_BLACK_BRUSH],
    [5, STOCK_NULL_BRUSH],
    [6, STOCK_WHITE_PEN],
    [7, STOCK_BLACK_PEN],
    [8, STOCK_NULL_PEN],
    [13, STOCK_SYSTEM_FONT],
  ]);
  const handle = handles.get(index) ?? 0;
  if (!handle) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
  stateFor(runtime);
  return success(handle, 1);
}

function selectObject(runtime, argument) {
  const state = stateFor(runtime);
  const dcHandle = argument(0) >>> 0;
  const dc = getDc(runtime, state, dcHandle);
  if (!dc) return badDc(runtime, 2);
  const objectHandle = argument(1) >>> 0;
  const brush = getBrush(state, objectHandle);
  if (brush) {
    const previous = dc.brush;
    dc.brush = objectHandle;
    return success(previous, 2);
  }
  const pen = getPen(state, objectHandle);
  if (pen) {
    const previous = dc.pen;
    dc.pen = objectHandle;
    return success(previous, 2);
  }
  const font = getFont(state, objectHandle);
  if (font) {
    const previous = dc.font;
    dc.font = objectHandle;
    return success(previous, 2);
  }
  const bitmap = state.bitmaps.get(objectHandle);
  if (!bitmap || dc.kind !== 'memory-dc') return failure(runtime, ERROR_INVALID_HANDLE, 0, 2);
  if (bitmap.selectedBy && bitmap.selectedBy !== dcHandle)
    return failure(runtime, ERROR_INVALID_HANDLE, 0, 2);
  const previous = dc.bitmap;
  const previousBitmap = state.bitmaps.get(previous);
  if (previousBitmap && !previousBitmap.stock) previousBitmap.selectedBy = null;
  bitmap.selectedBy = dcHandle;
  dc.bitmap = objectHandle;
  dc.surface = bitmap;
  return success(previous, 2);
}

function deleteObject(runtime, argument) {
  const state = stateFor(runtime);
  const handle = argument(0) >>> 0;
  const brush = getBrush(state, handle);
  if (brush) {
    if (brush.stock) return success(1, 1);
    for (const dc of state.dcs.values())
      if (dc.active && dc.brush === handle) return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
    state.brushes.delete(handle);
    return success(1, 1);
  }
  const pen = getPen(state, handle);
  if (pen) {
    if (pen.stock) return success(1, 1);
    for (const dc of state.dcs.values())
      if (dc.active && dc.pen === handle) return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
    state.pens.delete(handle);
    return success(1, 1);
  }
  const font = getFont(state, handle);
  if (font) {
    if (font.stock) return success(1, 1);
    for (const dc of state.dcs.values())
      if (dc.active && dc.font === handle) return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
    state.fonts.delete(handle);
    return success(1, 1);
  }
  const bitmap = state.bitmaps.get(handle);
  if (!bitmap) return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  if (bitmap.stock || bitmap.selectedBy)
    return bitmap.stock ? success(1, 1) : failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  state.bitmaps.delete(handle);
  return success(1, 1);
}

function fillRect(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 3);
  const rect = readRect(runtime, argument(1));
  if (!rect) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  const brush = getBrush(state, argument(2));
  if (!brush) return failure(runtime, ERROR_INVALID_HANDLE, 0, 3);
  const [left, top, right, bottom] = rect;
  if (right < left || bottom < top) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  paintRect(dc.surface, left, top, right, bottom, brush, 'copy', dc);
  // FillRect includes left/top and excludes right/bottom edges.
  return success(1, 3);
}

function patBlt(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
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
  paintRect(dc.surface, x, y, x + width, y + height, brush, operation, dc);
  return success(1, 6);
}

function bitBlt(runtime, argument) {
  const state = stateFor(runtime);
  const destination = getDc(runtime, state, argument(0));
  if (!destination) return badDc(runtime, 9);
  const source = getDc(runtime, state, argument(5));
  if (!source) return failure(runtime, ERROR_INVALID_HANDLE, 0, 9);
  const x = signed(argument(1));
  const y = signed(argument(2));
  const width = signed(argument(3));
  const height = signed(argument(4));
  const sourceX = signed(argument(6));
  const sourceY = signed(argument(7));
  const rop = argument(8) >>> 0;
  if (rop !== SRCCOPY) throw Error(`Unsupported BitBlt raster operation 0x${rop.toString(16)}`);
  if (width < 0 || height < 0) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 9);
  if (!width || !height) return success(1, 9);

  // BitBlt clips against the destination DC. The source rectangle is translated
  // by exactly the clipped amount and must remain inside its selected bitmap.
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(destination.surface.width, x + width);
  const bottom = Math.min(destination.surface.height, y + height);
  if (left >= right || top >= bottom) return success(1, 9);
  const copyWidth = right - left;
  const copyHeight = bottom - top;
  const sx = sourceX + left - x;
  const sy = sourceY + top - y;
  if (
    sx < 0 ||
    sy < 0 ||
    sx + copyWidth > source.surface.width ||
    sy + copyHeight > source.surface.height
  )
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 9);

  const sourcePixels = source.surface.pixels;
  const destinationPixels = destination.surface.pixels;
  const sameSurface = source.surface === destination.surface;
  const snapshot = sameSurface ? new Uint8ClampedArray(copyWidth * copyHeight * 4) : null;
  if (snapshot) {
    for (let row = 0; row < copyHeight; row++) {
      const start = ((sy + row) * source.surface.width + sx) * 4;
      snapshot.set(sourcePixels.subarray(start, start + copyWidth * 4), row * copyWidth * 4);
    }
  }
  let changed = false;
  for (let row = 0; row < copyHeight; row++) {
    const sourceStart = ((sy + row) * source.surface.width + sx) * 4;
    const destinationStart = ((top + row) * destination.surface.width + left) * 4;
    for (let column = 0; column < copyWidth; column++) {
      const sourceOffset = snapshot ? (row * copyWidth + column) * 4 : sourceStart + column * 4;
      const destinationOffset = destinationStart + column * 4;
      const sourceRgb = [
        snapshot ? snapshot[sourceOffset] : sourcePixels[sourceOffset],
        snapshot ? snapshot[sourceOffset + 1] : sourcePixels[sourceOffset + 1],
        snapshot ? snapshot[sourceOffset + 2] : sourcePixels[sourceOffset + 2],
      ];
      let red = sourceRgb[0];
      let green = sourceRgb[1];
      let blue = sourceRgb[2];
      if (source.surface.monochrome && !destination.surface.monochrome) {
        const color = sourceRgb[0] === 0 ? destination.textColor : destination.backgroundColor;
        [red, green, blue] = colorRgb(color);
      } else if (!source.surface.monochrome && destination.surface.monochrome) {
        const white = rgbColorRef(sourceRgb) === source.backgroundColor;
        red = green = blue = white ? 255 : 0;
      }
      if (
        destinationPixels[destinationOffset] !== red ||
        destinationPixels[destinationOffset + 1] !== green ||
        destinationPixels[destinationOffset + 2] !== blue ||
        destinationPixels[destinationOffset + 3] !== 255
      )
        changed = true;
      destinationPixels[destinationOffset] = red;
      destinationPixels[destinationOffset + 1] = green;
      destinationPixels[destinationOffset + 2] = blue;
      destinationPixels[destinationOffset + 3] = 255;
    }
  }
  if (changed) destination.surface.dirty = true;
  return success(1, 9);
}

function setPixel(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 4, CLR_INVALID);
  const surface = dc.surface;
  const x = signed(argument(1)),
    y = signed(argument(2));
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height)
    return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 4);
  const color = argument(3) >>> 0;
  if (color & 0xff000000) return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 4);
  const rgb = surfaceRgb(surface, colorRgb(color));
  const offset = (y * surface.width + x) * 4;
  const pixels = surface.pixels;
  if (pixels[offset] !== rgb[0] || pixels[offset + 1] !== rgb[1] || pixels[offset + 2] !== rgb[2])
    surface.dirty = true;
  pixels[offset] = rgb[0];
  pixels[offset + 1] = rgb[1];
  pixels[offset + 2] = rgb[2];
  pixels[offset + 3] = 255;
  return success(rgbColorRef(rgb), 4);
}

function getPixel(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 3, CLR_INVALID);
  const surface = dc.surface;
  const x = signed(argument(1)),
    y = signed(argument(2));
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height)
    return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 3);
  const offset = (y * surface.width + x) * 4;
  return success(rgbColorRef(surface.pixels.subarray(offset, offset + 3)), 3);
}

function getSysColor(runtime, argument) {
  const index = argument(0) >>> 0;
  return index < SYSTEM_COLORS.length
    ? success(SYSTEM_COLORS[index], 1)
    : failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
}

function getSysColorBrush(runtime, argument) {
  const index = argument(0) >>> 0;
  if (index >= SYSTEM_COLORS.length) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
  stateFor(runtime);
  return success(index + 1, 1);
}

function moveToEx(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 4);
  const x = signed(argument(1));
  const y = signed(argument(2));
  const previous = argument(3) >>> 0;
  if (previous) {
    try {
      runtime.check(previous, 8, true);
    } catch {
      return failure(runtime, ERROR_INVALID_PARAMETER, 0, 4);
    }
  }
  if (previous) {
    runtime.view.setInt32(previous, dc.currentPoint.x, true);
    runtime.view.setInt32(previous + 4, dc.currentPoint.y, true);
  }
  dc.currentPoint = { x, y };
  return success(1, 4);
}

function lineTo(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 3);
  const x1 = signed(argument(1));
  const y1 = signed(argument(2));
  const { x: originalX, y: originalY } = dc.currentPoint;
  dc.currentPoint = { x: x1, y: y1 };
  const pen = getPen(state, dc.pen);
  if (!pen) return failure(runtime, ERROR_INVALID_HANDLE, 0, 3);
  drawLine(dc.surface, originalX, originalY, x1, y1, pen);
  return success(1, 3);
}

function textOut(runtime, argument, wide) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 5);
  const x = signed(argument(1)),
    y = signed(argument(2));
  const pointer = argument(3) >>> 0,
    count = signed(argument(4));
  let text, mask;
  try {
    text = readGdiText(runtime, pointer, count, wide);
  } catch {
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 5);
  }
  const font = dc.font ? getFont(state, dc.font) : null;
  if (dc.font && !font) return failure(runtime, ERROR_INVALID_HANDLE, 0, 5);
  const descriptor = font ?? DEFAULT_GDI_FONT;
  const result = rasterizeGdiText(runtime, text, descriptor);
  if (result.error === 'backend') return failure(runtime, ERROR_CALL_NOT_IMPLEMENTED, 0, 5);
  if (result.error) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 5);
  mask = result.mask;
  paintGdiText(dc.surface, dc, x, y, mask, descriptor);
  return success(1, 5);
}

/** A read-only, cloned descriptor for DOM control font propagation. */
export function describeGdiFont(runtime, handle) {
  if (handle >>> 0 === 0) return { ...DEFAULT_GDI_FONT };
  const font = states.get(runtime)?.fonts.get(handle >>> 0);
  return font ? { ...font } : null;
}

export const gdiApis = {
  'user32.dll!GetDesktopWindow': getDesktopWindow,
  'user32.dll!GetDC': getDC,
  'user32.dll!ReleaseDC': releaseDC,
  'user32.dll!FillRect': fillRect,
  'user32.dll!GetSysColor': getSysColor,
  'user32.dll!GetSysColorBrush': getSysColorBrush,
  'gdi32.dll!CreateSolidBrush': createSolidBrush,
  'gdi32.dll!CreateHatchBrush': createHatchBrush,
  'gdi32.dll!CreatePen': createPen,
  'gdi32.dll!CreateFont': (runtime, argument) => createFont(runtime, argument, false),
  'gdi32.dll!CreateFontA': (runtime, argument) => createFont(runtime, argument, false),
  'gdi32.dll!CreateFontW': (runtime, argument) => createFont(runtime, argument, true),
  'gdi32.dll!TextOut': (runtime, argument) => textOut(runtime, argument, false),
  'gdi32.dll!TextOutA': (runtime, argument) => textOut(runtime, argument, false),
  'gdi32.dll!TextOutW': (runtime, argument) => textOut(runtime, argument, true),
  'gdi32.dll!SetBkMode': setBkMode,
  'gdi32.dll!MoveToEx': moveToEx,
  'gdi32.dll!LineTo': lineTo,
  'gdi32.dll!SetBkColor': setBkColor,
  'gdi32.dll!SetTextColor': setTextColor,
  'gdi32.dll!CreateCompatibleDC': createCompatibleDC,
  'gdi32.dll!CreateCompatibleBitmap': createCompatibleBitmap,
  'gdi32.dll!DeleteDC': deleteDC,
  'gdi32.dll!GetStockObject': getStockObject,
  'gdi32.dll!SelectObject': selectObject,
  'gdi32.dll!DeleteObject': deleteObject,
  'gdi32.dll!PatBlt': patBlt,
  'gdi32.dll!BitBlt': bitBlt,
  'gdi32.dll!SetPixel': setPixel,
  'gdi32.dll!GetPixel': getPixel,
};

/** Emit copied RGBA frames for the desktop and dirty guest client areas. */
export function flushGdi(runtime) {
  const state = states.get(runtime);
  if (!state) return null;
  const desktop = state.desktopSurface;
  const frames = [];
  if (state.desktopActive && desktop.dirty) {
    frames.push({
      type: 'frame',
      width: desktop.width,
      height: desktop.height,
      pixels: new Uint8ClampedArray(desktop.pixels),
    });
    desktop.dirty = false;
  }
  for (const surface of state.windowSurfaces.values()) {
    if (!surface.dirty) continue;
    frames.push({
      type: 'frame',
      windowId: surface.windowId,
      width: surface.width,
      height: surface.height,
      pixels: new Uint8ClampedArray(surface.pixels),
    });
    surface.dirty = false;
  }
  for (const frame of frames) runtime.emit?.(frame);
  return frames[0] ?? null;
}
