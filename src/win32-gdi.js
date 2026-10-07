import {
  allocateDibStorage,
  releaseDibStorage,
  refreshDibPixels,
  commitDibPixels,
} from './gdi-section.js';
import {
  defaultDibPalette,
  readDibLayout,
  readDibPixel,
  writeDibPixel,
  writeDibColorTable,
} from './gdi-dib.js';
import { iconForHandle } from './win32-icons.js';
import { clipPieces, setClipPieces, subtractClip, intersectClip } from './gdi-clip.js';
import { createRegionApis } from './gdi-region.js';
import { MAX_WINDOW_WIDTH, MAX_WINDOW_HEIGHT } from './window-frame.js';
import { currentDisplayMode, VIRTUAL_DISPLAY_MODES } from './win32-display.js';
import { encodeAnsi, decodeAnsi } from './encoding.js';
import {
  colorRefRgb as colorRgb,
  surfaceRgb,
  rgbColorRef,
  paintRect,
  paintFocusRect,
  drawLine,
  clippedBounds,
  visiblePixel,
  markGdiDirty,
} from './gdi-raster.js';
import {
  DEFAULT_GDI_FONT,
  makeGdiFontDescriptor,
  readGdiText,
  rasterizeGdiText,
  paintGdiText,
} from './gdi-text.js';

const MAX_DESKTOP_PIXELS = Math.max(
  ...VIRTUAL_DISPLAY_MODES.map((mode) => mode.width * mode.height),
);
export const DESKTOP_WINDOW = 0x101;
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
const STOCK_DEFAULT_PALETTE = 0x10008;
const MAX_WINDOW_SURFACES = 8;
const MAX_CONTROL_SURFACES = 256;
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
    const { width, height } = currentDisplayMode(runtime);
    const pixels = opaquePixels(width, height);
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
    const defaultColors = defaultDibPalette(8);
    state = {
      desktopSurface: { width, height, pixels, dirty: true },
      desktopActive: false,
      brushes,
      pens,
      fonts,
      palettes: new Map([
        [
          STOCK_DEFAULT_PALETTE,
          {
            kind: 'palette',
            stock: true,
            entries: [...defaultColors.slice(0, 10), ...defaultColors.slice(246)].map(
              ([red, green, blue]) => ({ red, green, blue, flags: 0 }),
            ),
          },
        ],
      ]),
      dcs: new Map(),
      bitmaps: new Map(),
      regions: new Map(),
      dibBitmaps: new Set(),
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

function syncDesktopSurface(runtime, state) {
  const { width, height } = currentDisplayMode(runtime),
    old = state.desktopSurface;
  if (width === old.width && height === old.height) return;
  const pixels = opaquePixels(width, height),
    copyWidth = Math.min(width, old.width),
    copyHeight = Math.min(height, old.height);
  for (let y = 0; y < copyHeight; y++)
    pixels.set(
      old.pixels.subarray(y * old.width * 4, (y * old.width + copyWidth) * 4),
      y * width * 4,
    );
  state.desktopSurface = { width, height, pixels, dirty: true };
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
      state.stockBitmapCount +
      state.regions.size +
      state.palettes.size -
      1 >=
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
    refreshDibPixels(runtime, bitmap);
    dc.surface = bitmap;
    return dc;
  }
  if (dc.hwnd === 0 || dc.hwnd === DESKTOP_WINDOW) {
    syncDesktopSurface(runtime, state);
    dc.surface = state.desktopSurface;
  } else {
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
    // Reserve every catalogue mode so changing modes cannot exceed the GDI
    // allocation budget after a smaller desktop allowed more bitmap creation.
    Math.max(MAX_DESKTOP_PIXELS, state.desktopSurface.width * state.desktopSurface.height) +
    [...state.windowSurfaces.values()].reduce(
      (sum, surface) => sum + surface.width * surface.height,
      0,
    ) +
    [...state.bitmaps.values()].reduce((sum, bitmap) => sum + bitmap.width * bitmap.height, 0) +
    [...state.brushes.values()].reduce(
      (sum, brush) => sum + (brush.pattern ? brush.pattern.width * brush.pattern.height : 0),
      0,
    )
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

function getDC(runtime, argument, controlColorCallback = false) {
  const state = stateFor(runtime);
  const hwnd = argument(0) >>> 0;
  if (hwnd === 0 || hwnd === DESKTOP_WINDOW) state.desktopActive = true;
  if (hwnd !== 0 && hwnd !== DESKTOP_WINDOW) {
    const window = runtime.windows?.windows?.get(hwnd);
    if (!window) return failure(runtime, ERROR_INVALID_WINDOW_HANDLE, 0, 1);
    if (
      !state.windowSurfaces.has(hwnd) &&
      !resizeWindowSurface(runtime, hwnd, window.width, window.height)
    )
      return failure(runtime, ERROR_NOT_ENOUGH_MEMORY, 0, 1);
    if (!controlColorCallback) state.windowSurfaces.get(hwnd).publicDrawing = true;
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

// Native color callbacks borrow a DC without promoting their scratch bitmap
// to a persistent public GetDC drawing surface.
export function acquireControlColorDC(runtime, hwnd) {
  return getDC(runtime, () => hwnd, true).result;
}

/** Resize or create the client-area bitmap backing a virtual HWND. */
export function resizeWindowSurface(
  runtime,
  id,
  width,
  height,
  preserveContents = true,
  redraw = true,
) {
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
    width < 0 ||
    height < 0 ||
    width > MAX_WINDOW_WIDTH ||
    height > MAX_WINDOW_HEIGHT
  )
    return false;

  const state = stateFor(runtime);
  const oldSurface = state.windowSurfaces.get(hwnd);
  if (preserveContents && oldSurface?.width === width && oldSurface?.height === height) return true;
  if (!oldSurface) {
    const control = !!window.controlType;
    let count = 0;
    for (const id of state.windowSurfaces.keys())
      if (!!runtime.windows.windows.get(id)?.controlType === control) count++;
    if (count >= (control ? MAX_CONTROL_SURFACES : MAX_WINDOW_SURFACES)) return false;
  }
  const totalPixels =
    totalSurfacePixels(state) -
    (oldSurface ? oldSurface.width * oldSurface.height : 0) +
    width * height;
  if (totalPixels > MAX_TOTAL_SURFACE_PIXELS) return false;

  // Browser controls supply their own default painting. Only guest drawing
  // covers it; untouched pixels must leave native text/input visible.
  const controlOverlay =
    !!window.controlType &&
    window.controlType !== 'custom' &&
    (!window.ownerDraw || window.controlType === 'combobox');
  const pixels = controlOverlay
    ? new Uint8ClampedArray(width * height * 4)
    : opaquePixels(width, height);
  if (oldSurface && preserveContents) {
    const copyWidth = Math.min(width, oldSurface.width);
    const copyHeight = Math.min(height, oldSurface.height);
    for (let y = 0; y < copyHeight; y++) {
      const oldOffset = y * oldSurface.width * 4;
      const newOffset = y * width * 4;
      pixels.set(oldSurface.pixels.subarray(oldOffset, oldOffset + copyWidth * 4), newOffset);
    }
  }
  const surface = {
    width,
    height,
    pixels,
    dirty: !!oldSurface?.dirty || redraw,
    windowId: hwnd,
    controlOverlay,
    publicDrawing: !!oldSurface?.publicDrawing,
  };
  state.windowSurfaces.set(hwnd, surface);
  for (const dc of state.dcs.values()) if (dc.active && dc.hwnd === hwnd) dc.surface = surface;
  return true;
}

/** Default control painting restores browser content in the invalid client rectangle. */
export function clearControlDrawing(runtime, id, rect = null) {
  const surface = states.get(runtime)?.windowSurfaces.get(id >>> 0);
  if (!surface?.controlOverlay || !surface.publicDrawing) return false;
  const [left, top, right, bottom] = rect ?? [0, 0, surface.width, surface.height];
  const x0 = Math.max(0, Math.min(surface.width, left)),
    x1 = Math.max(x0, Math.min(surface.width, right)),
    y0 = Math.max(0, Math.min(surface.height, top)),
    y1 = Math.max(y0, Math.min(surface.height, bottom));
  for (let y = y0; y < y1; y++)
    surface.pixels.fill(0, (y * surface.width + x0) * 4, (y * surface.width + x1) * 4);
  if (x1 > x0 && y1 > y0) surface.dirty = true;
  return true;
}

export function hasControlDrawing(runtime, id) {
  return !!states.get(runtime)?.windowSurfaces.get(id >>> 0)?.publicDrawing;
}

// The browser paints the underlying control. Until its native pixels can be
// read back, source-copy/read operations must reject uncovered pixels rather
// than manufacture black pixels where the visible control shows something else.
function readablePixels(surface, x, y, width, height) {
  if (!surface.controlOverlay) return true;
  for (let row = y; row < y + height; row++)
    for (let col = x; col < x + width; col++)
      if (surface.pixels[(row * surface.width + col) * 4 + 3] !== 255) return false;
  return true;
}

export function releaseControlColorSurface(runtime, id) {
  const surface = states.get(runtime)?.windowSurfaces.get(id >>> 0);
  if (surface && !surface.publicDrawing) destroyWindowSurface(runtime, id);
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
  if (!monochrome && dc?.surface.dib) {
    const original = dc.surface.dib.layout;
    return allocateSectionBitmap(
      runtime,
      state,
      {
        ...original,
        width,
        height,
        signedHeight: original.signedHeight < 0 ? -height : height,
        stride: Math.ceil((width * original.depth) / 32) * 4,
        palette: original.palette.map((color) => color.slice()),
        paletteCache: new Map(),
      },
      dc.surface.dib.header.slice(),
      3,
    );
  }
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

function createPatternBrush(r, a) {
  const state = stateFor(r),
    source = a(0) >>> 0,
    bitmap = state.bitmaps.get(source);
  if (!bitmap) return failure(r, ERROR_INVALID_HANDLE, 0, 1);
  if (bitmap.width * bitmap.height + totalSurfacePixels(state) > MAX_TOTAL_SURFACE_PIXELS)
    return failure(r, ERROR_NOT_ENOUGH_MEMORY, 0, 1);
  refreshDibPixels(r, bitmap);
  const allocated = allocateHandle(r, state, 1);
  if (!allocated.result) return allocated;
  state.brushes.set(allocated.result, {
    kind: 'brush',
    stock: false,
    color: 0,
    pattern: {
      width: bitmap.width,
      height: bitmap.height,
      monochrome: !!bitmap.monochrome,
      pixels: new Uint8ClampedArray(bitmap.pixels),
    },
    sourceBitmap: source,
  });
  return allocated;
}

function createBrushIndirect(r, a) {
  const p = a(0);
  if (!p) return failure(r, ERROR_INVALID_PARAMETER, 0, 1);
  r.check(p, 12);
  const style = r.read32(p),
    color = r.read32(p + 4),
    hatch = r.read32(p + 8);
  if (style === 0) return createSolidBrush(r, () => color);
  if (style === 2) return { ...createHatchBrush(r, (i) => [hatch, color][i]), argc: 1 };
  if (style === 3) return createPatternBrush(r, () => hatch);
  if (style === 1) {
    const state = stateFor(r),
      allocated = allocateHandle(r, state, 1);
    if (allocated.result)
      state.brushes.set(allocated.result, { kind: 'brush', stock: false, null: true });
    return allocated;
  }
  return failure(
    r,
    [5, 6].includes(style) ? ERROR_CALL_NOT_IMPLEMENTED : ERROR_INVALID_PARAMETER,
    0,
    1,
  );
}

function brushOrigin(r, a, set) {
  const argc = set ? 4 : 2,
    dc = getDc(r, stateFor(r), a(0));
  if (!dc) return badDc(r, argc);
  const out = a(set ? 3 : 1);
  if (!set && !out) return failure(r, ERROR_INVALID_PARAMETER, 0, argc);
  if (out) {
    r.check(out, 8, true);
    r.write32(out, dc.brushOriginX ?? 0);
    r.write32(out + 4, dc.brushOriginY ?? 0);
  }
  if (set) {
    dc.brushOriginX = a(1) | 0;
    dc.brushOriginY = a(2) | 0;
  }
  return success(1, argc);
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

// ---------------------------------------------------------------------------
// Text metrics, object queries and the remaining shape/clip primitives. They
// answer from the DC's selected font and the runtime's own rasterizer, so a
// caller that sizes a control from GetTextMetrics gets the same numbers the
// painted glyphs use.
function currentFont(runtime, state, dc) {
  return dc.font ? getFont(state, dc.font) : null;
}
function fontMetrics(runtime, state, dc) {
  const font = currentFont(runtime, state, dc) ?? DEFAULT_GDI_FONT;
  const measured = rasterizeGdiText(runtime, 'Wg', font);
  const height = measured.error ? font.height : Math.max(font.height, measured.mask.height);
  const width = measured.error ? 8 : Math.max(1, Math.round(measured.mask.width / 2));
  return {
    height,
    width,
    ascent: Math.round(height * 0.8),
    descent: height - Math.round(height * 0.8),
  };
}
// GetTextMetricsA/W fills a TEXTMETRIC. Only the fields the runtime can answer
// honestly are set; the rest stay zero, which is what an application reads for
// an unavailable attribute.
function getTextMetrics(runtime, argument, wide) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 2);
  const out = argument(1);
  if (!out) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
  const size = wide ? 60 : 56;
  runtime.check(out, size, true);
  runtime.data.fill(0, out, out + size);
  const { height, width, ascent } = fontMetrics(runtime, state, dc);
  const font = currentFont(runtime, state, dc) ?? DEFAULT_GDI_FONT;
  runtime.write32(out, height); // tmHeight
  runtime.write32(out + 4, ascent); // tmAscent
  runtime.write32(out + 8, height - ascent); // tmDescent
  runtime.write32(out + 20, width); // tmAveCharWidth
  runtime.write32(out + 24, width); // tmMaxCharWidth
  runtime.write32(out + 28, font.weight);
  runtime.write32(out + 36, 96); // tmDigitizedAspectX
  runtime.write32(out + 40, 96); // tmDigitizedAspectY
  // Character coverage uses the browser's fallback font stack. Physical font
  // ranges are not exposed by Canvas; report the ANSI/UTF-16 range we accept.
  const characters = [32, wide ? 0xffff : 255, 63, 32];
  for (let i = 0; i < characters.length; i++)
    if (wide) runtime.view.setUint16(out + 44 + i * 2, characters[i], true);
    else runtime.data[out + 44 + i] = characters[i];
  runtime.data.set(
    [+font.italic, +font.underline, +font.strikeout, font.pitchAndFamily ?? 0, font.charset ?? 1],
    out + (wide ? 52 : 48),
  );
  return success(1, 2);
}
// SDK GetDeviceCaps indices describe the implemented 32-bit CPU raster device.
// Window and memory DCs retain the compatible display's device capabilities;
// their selected surfaces affect clipping and bitmap layout, not HORZRES.
const DEVICE_CAPS = Object.freeze({
  2: 1, // TECHNOLOGY: DT_RASDISPLAY.
  12: 32, // BITSPIXEL: CPU GDI backing pixels remain RGBA8 in every mode.
  14: 1, // PLANES
  16: -1, // NUMBRUSHES: dynamically created brushes.
  18: -1, // NUMPENS: dynamically created pens.
  24: -1, // NUMCOLORS: true color, not a palette device.
  28: 0x89, // CURVECAPS: circles, ellipses and interiors.
  30: 2, // LINECAPS: polylines.
  32: 0x83, // POLYGONALCAPS: polygons, rectangles and interiors (alternate fill).
  36: 3, // CLIPCAPS: rectangular and bounded complex regions.
  38: 0x801, // RASTERCAPS: BITBLT and STRETCHBLT. Compressed DIB transfers remain unfinished.
  40: 36, // ASPECTX: square device pixels, conventional GDI aspect units.
  42: 36, // ASPECTY.
  44: 51, // ASPECTXY: rounded diagonal in the same aspect units.
  88: 96, // LOGPIXELSX
  90: 96, // LOGPIXELSY
  108: 24, // COLORRES: eight significant bits in each RGB channel.
});
function getDeviceCaps(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return failure(runtime, ERROR_INVALID_HANDLE, 0, 2);
  const index = argument(1) | 0;
  const { width, height, frequency } = currentDisplayMode(runtime);
  switch (index) {
    case 4:
      return success(Math.round((width * 25.4) / 96), 2); // HORZSIZE: nominal 96-dpi millimetres.
    case 6:
      return success(Math.round((height * 25.4) / 96), 2); // VERTSIZE.
    case 8:
    case 118:
      return success(width, 2); // HORZRES, DESKTOPHORZRES.
    case 10:
    case 117:
      return success(height, 2); // VERTRES, DESKTOPVERTRES.
    case 116:
      return success(frequency, 2); // VREFRESH.
    default:
      return success(DEVICE_CAPS[index] ?? 0, 2);
  }
}
// Get(Current)Object reports the handle a DC currently has selected.
function getCurrentObject(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return failure(runtime, ERROR_INVALID_HANDLE, 0, 2);
  const kind = argument(1) >>> 0;
  // OBJ_PEN 1, OBJ_BRUSH 2, OBJ_PAL 5, OBJ_FONT 6, OBJ_BITMAP 7.
  if (kind === 1) return success(dc.pen, 2);
  if (kind === 2) return success(dc.brush, 2);
  if (kind === 5) return success(dc.palette ?? STOCK_DEFAULT_PALETTE, 2);
  if (kind === 6) return success(dc.font, 2);
  if (kind === 7) return success(dc.bitmap ?? 0, 2);
  return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
}
// GetObject reports the description of a GDI object. The LOGFONT and
// BITMAP/LOGBITMAP layouts are the ones applications actually query.
function getObject(runtime, argument, wide) {
  const state = stateFor(runtime);
  const handle = argument(0) >>> 0;
  const size = argument(1) | 0;
  const out = argument(2);
  if (size < 0) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  const bitmap = state.bitmaps.get(handle);
  if (bitmap) {
    // PE32 BITMAP is 24 bytes. A DIBSECTION adds its normalized 40-byte
    // header, three masks, section handle and offset (84 bytes total).
    if (!out) return success(24, 3);
    if (size < 24) return success(0, 3);
    const count = bitmap.dib && size >= 84 ? 84 : 24;
    runtime.check(out, count, true);
    runtime.data.fill(0, out, out + count);
    runtime.write32(out + 4, bitmap.width);
    runtime.write32(out + 8, bitmap.height);
    const depth = bitmap.dib?.layout.depth ?? bitmap.depth ?? (bitmap.monochrome ? 1 : 32);
    runtime.write32(
      out + 12,
      bitmap.dib?.layout.stride ?? Math.ceil((bitmap.width * depth) / 16) * 2,
    );
    runtime.view.setUint16(out + 16, 1, true);
    runtime.view.setUint16(out + 18, depth, true);
    if (bitmap.dib) {
      runtime.write32(out + 20, bitmap.dib.bits);
      if (count === 84) {
        runtime.data.set(bitmap.dib.header, out + 24);
        runtime.write32(out + 28, bitmap.width);
        runtime.write32(out + 32, bitmap.height);
        if (bitmap.dib.layout.compression === 3)
          bitmap.dib.layout.masks.forEach((mask, i) => runtime.write32(out + 64 + i * 4, mask));
      }
    }
    return success(count, 3);
  }
  const font = getFont(state, handle);
  const pen = getPen(state, handle);
  const brush = getBrush(state, handle);
  if (!font && !pen && !brush) return failure(runtime, ERROR_INVALID_HANDLE, 0, 3);
  const required = font ? (wide ? 92 : 60) : pen ? 16 : 12;
  if (!out) return success(required, 3);
  // Fonts and brushes permit partial copies. LOGPEN needs the whole structure.
  if (pen && size < required) return success(0, 3);
  const count = Math.min(size, required);
  if (!count) return success(0, 3);
  runtime.check(out, count, true);
  const bytes = new Uint8Array(required);
  const view = new DataView(bytes.buffer);
  if (font) {
    view.setInt32(0, font.requestedHeight ?? -font.height, true);
    view.setInt32(8, font.escapement ?? 0, true);
    view.setInt32(12, font.orientation ?? 0, true);
    view.setInt32(16, font.requestedWeight ?? font.weight, true);
    bytes.set(
      [
        +font.italic,
        +font.underline,
        +font.strikeout,
        font.charset ?? 1,
        font.outPrecision ?? 0,
        font.clipPrecision ?? 0,
        font.quality ?? 0,
        font.pitchAndFamily ?? 0,
      ],
      20,
    );
    const face = (font.requestedFace ?? font.face ?? '').slice(0, 31);
    if (wide) {
      for (let i = 0; i < face.length; i++) view.setUint16(28 + i * 2, face.charCodeAt(i), true);
    } else {
      bytes.set(encodeAnsi(face).bytes.subarray(0, 31), 28);
    }
  } else if (pen) {
    view.setUint32(0, pen.style, true);
    view.setInt32(4, pen.width, true);
    view.setUint32(12, pen.color, true);
  } else {
    view.setUint32(0, brush.null ? 1 : brush.pattern ? 3 : brush.hatch !== undefined ? 2 : 0, true);
    view.setUint32(4, brush.color ?? 0, true);
    view.setUint32(8, brush.sourceBitmap ?? brush.hatch ?? 0, true);
  }
  runtime.data.set(bytes.subarray(0, count), out);
  return success(count, 3);
}
// Set/GetTextAlign control the DC's text alignment flags.
function setTextAlign(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 2, CLR_INVALID);
  const flags = argument(1) >>> 0;
  if (flags & ~0x1f) return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 2);
  const previous = dc.textAlign ?? 0;
  dc.textAlign = flags;
  return success(previous, 2);
}
function getTextAlign(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 1, CLR_INVALID);
  return success(dc.textAlign ?? 0, 1);
}
function setTextCharacterExtra(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 2, CLR_INVALID);
  const extra = argument(1) | 0;
  const previous = dc.charExtra ?? 0;
  dc.charExtra = extra;
  return success(previous, 2);
}
function getTextCharacterExtra(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 1, CLR_INVALID);
  return success(dc.charExtra ?? 0, 1);
}
// GetBkMode / SetMapMode / GetMapMode.
function getBkMode(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 1, CLR_INVALID);
  return success(dc.bkMode ?? 2, 1);
}
function getMapMode(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 1);
  return success(dc.mapMode ?? 1, 1); // MM_TEXT
}
function setMapMode(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return failure(runtime, ERROR_INVALID_HANDLE, 0, 2);
  if ((argument(1) | 0) !== 1) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
  const previous = dc.mapMode ?? 1;
  dc.mapMode = 1;
  return success(previous, 2);
}
// Rectangle(hdc, left, top, right, bottom): a filled, outlined rectangle drawn
// with the DC's brush and pen.
function rectangleShape(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 5);
  const left = signed(argument(1)),
    top = signed(argument(2));
  const right = signed(argument(3)),
    bottom = signed(argument(4));
  fillPolygon(
    dc,
    [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
    ],
    shapeBrush(runtime, state, dc),
  );
  strokePolygon(
    dc,
    [
      [left, top],
      [right, top],
      [right, bottom],
      [left, bottom],
      [left, top],
    ],
    shapePen(runtime, state, dc),
    false,
  );
  return success(1, 5);
}
// Polyline(hdc, points, count): an open run of line segments.
function polyline(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 3);
  const points = readPoints(runtime, argument(1), argument(2) >>> 0);
  if (!points) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  strokePolygon(dc, points, shapePen(runtime, state, dc), false);
  return success(1, 3);
}
// Clip queries and rectangle operations use the DC's actual disjoint pieces,
// including complex clips copied from owned region handles.
function getClipRect(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 2);
  const out = argument(1);
  if (!out) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
  const pieces = intersectClip(clipPieces(dc, dc.surface), [
    0,
    0,
    dc.surface.width,
    dc.surface.height,
  ]);
  const clip = pieces.length
    ? [
        Math.min(...pieces.map((p) => p[0])),
        Math.min(...pieces.map((p) => p[1])),
        Math.max(...pieces.map((p) => p[2])),
        Math.max(...pieces.map((p) => p[3])),
      ]
    : [0, 0, 0, 0];
  runtime.check(out, 16, true);
  clip.forEach((value, i) => runtime.write32(out + i * 4, value));
  return success(pieces.length > 1 ? 3 : pieces.length ? 2 : 1, 2);
}
function intersectClipRect(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 5);
  return success(
    setClipPieces(
      dc,
      intersectClip(
        clipPieces(dc, dc.surface),
        [1, 2, 3, 4].map((i) => signed(argument(i))),
      ),
    ),
    5,
  );
}
function excludeClipRect(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 5);
  const pieces = subtractClip(
    clipPieces(dc, dc.surface),
    [1, 2, 3, 4].map((i) => signed(argument(i))),
  );
  if (pieces.length > 256) return failure(runtime, ERROR_NOT_ENOUGH_MEMORY, 0, 5);
  return success(setClipPieces(dc, pieces), 5);
}

// ---------------------------------------------------------------------------
// Font/text palettes and the remaining text-group calls.
// CreateFontIndirectA/W takes a LOGFONT pointer; the descriptor builder reads
// the same fourteen fields, so the pointer is expanded into the argument shape
// the shared path already validates.
function createFontIndirect(runtime, argument, wide) {
  const pointer = argument(0) >>> 0;
  if (!pointer) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
  runtime.check(pointer, wide ? 92 : 60);
  const read = (offset) => runtime.read32(pointer + offset) | 0;
  const face = pointer + 28;
  const args = [
    read(0),
    read(4),
    read(8),
    read(12),
    read(16),
    ...Array.from({ length: 8 }, (_, i) => runtime.data[pointer + 20 + i]),
    face,
  ];
  return { ...createFont(runtime, (index) => args[index] ?? 0, wide), argc: 1 };
}
// CreateBitmap(Width, Height, Planes, BitCount, Bits): an in-memory bitmap. The
// runtime only models the 1/4/8/24/32-bit colour layouts it can rasterize.
// CreateDIBitmap converts the caller's BITMAPINFO and DIB rows into a display
// bitmap. Unlike CreateBitmap, indexed DIB colours come from its actual palette.
function allocateSectionBitmap(r, state, layout, header, argc) {
  if (layout.width * layout.height + totalSurfacePixels(state) > MAX_TOTAL_SURFACE_PIXELS)
    return failure(r, ERROR_NOT_ENOUGH_MEMORY, 0, argc);
  const allocated = allocateHandle(r, state, argc);
  if (!allocated.result) return allocated;
  const dib = allocateDibStorage(r, layout);
  if (!dib) return failure(r, ERROR_NOT_ENOUGH_MEMORY, 0, argc);
  dib.header = header;
  const bitmap = {
    kind: 'bitmap',
    stock: false,
    width: layout.width,
    height: layout.height,
    monochrome: false,
    pixels: opaquePixels(layout.width, layout.height),
    dirty: false,
    selectedBy: null,
    dib,
  };
  state.bitmaps.set(allocated.result, bitmap);
  state.dibBitmaps.add(bitmap);
  return allocated;
}
function createDIBSection(r, a) {
  const state = stateFor(r),
    usage = a(2) >>> 0,
    output = a(3) >>> 0;
  if (output) {
    r.check(output, 4, true);
    r.write32(output, 0);
  }
  if (a(4)) return failure(r, ERROR_CALL_NOT_IMPLEMENTED, 0, 6);
  const dc = a(0) ? getDc(r, state, a(0)) : null;
  if ((a(0) && !dc) || (usage === 1 && !dc)) return badDc(r, 6);
  const layout = readDibLayout(r, a(1), usage, { paletteEntries: dc && dibPalette(state, dc) });
  if (!layout) return failure(r, ERROR_INVALID_PARAMETER, 0, 6);
  const header = new Uint8Array(40),
    view = new DataView(header.buffer);
  if (!layout.core) header.set(r.data.subarray(a(1), a(1) + 40));
  view.setUint32(0, 40, true);
  view.setInt32(4, layout.width, true);
  view.setInt32(8, layout.height, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, layout.depth, true);
  view.setUint32(16, layout.compression, true);
  view.setUint32(32, layout.palette.length, true);
  const result = allocateSectionBitmap(r, state, layout, header, 6);
  if (result.result && output) r.write32(output, state.bitmaps.get(result.result).dib.bits);
  return result;
}
function dibColorTable(r, a, set) {
  const dc = getDc(r, stateFor(r), a(0));
  if (!dc) return badDc(r, 4);
  const dib = dc.surface.dib;
  if (!dib || dib.layout.depth > 8) return success(0, 4);
  const start = a(1) >>> 0,
    count = Math.min(a(2) >>> 0, dib.layout.palette.length - start);
  if (count <= 0) return success(0, 4);
  const pointer = a(3) >>> 0;
  if (!pointer) return failure(r, ERROR_INVALID_PARAMETER, 0, 4);
  r.check(pointer, count * 4, !set);
  for (let i = 0; i < count; i++) {
    const at = pointer + i * 4;
    if (set) dib.layout.palette[start + i] = [r.data[at + 2], r.data[at + 1], r.data[at]];
    else r.data.set([...dib.layout.palette[start + i].slice().reverse(), 0], at);
  }
  if (set) {
    dib.layout.paletteCache.clear();
    for (let row = 0; row < dib.layout.height; row++) dib.dirtyRows.add(row);
  }
  return success(count, 4);
}

function createDIBitmap(r, a) {
  const state = stateFor(r),
    header = a(1),
    flags = a(2),
    bits = a(3),
    info = a(4),
    usage = a(5);
  if (a(0) && !getDc(r, state, a(0))) return badDc(r, 6);
  if (!header || flags & ~4 || usage !== 0) return failure(r, ERROR_INVALID_PARAMETER, 0, 6);
  r.check(header, 12);
  const size = r.read32(header),
    core = size === 12;
  if (!core && size < 40) return failure(r, ERROR_INVALID_PARAMETER, 0, 6);
  r.check(header, core ? 12 : 40);
  const width = core ? r.view.getUint16(header + 4, true) : r.read32(header + 4) | 0;
  const signedHeight = core ? r.view.getUint16(header + 6, true) : r.read32(header + 8) | 0;
  const height = Math.abs(signedHeight),
    planes = r.view.getUint16(header + (core ? 8 : 12), true),
    depth = r.view.getUint16(header + (core ? 10 : 14), true);
  const compression = core ? 0 : r.read32(header + 16);
  if (
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    planes !== 1 ||
    ![1, 4, 8, 16, 24, 32].includes(depth) ||
    ![0, 3].includes(compression) ||
    (compression === 3 && ![16, 32].includes(depth))
  )
    return failure(r, ERROR_INVALID_PARAMETER, 0, 6);
  if (width * height + totalSurfacePixels(state) > MAX_TOTAL_SURFACE_PIXELS)
    return failure(r, ERROR_NOT_ENOUGH_MEMORY, 0, 6);
  const pixels = opaquePixels(width, height);
  if (flags & 4) {
    if (!bits || !info) return failure(r, ERROR_INVALID_PARAMETER, 0, 6);
    r.check(info, core ? 12 : 40);
    const stride = Math.ceil((width * depth) / 32) * 4;
    r.check(bits, stride * height);
    let palette = [],
      masks = depth === 16 ? [0x7c00, 0x3e0, 0x1f] : [0xff0000, 0xff00, 0xff];
    if (depth <= 8) {
      const count = core ? 1 << depth : r.read32(info + 32) || 1 << depth;
      if (count > 1 << depth) return failure(r, ERROR_INVALID_PARAMETER, 0, 6);
      const start = info + (core ? 12 : r.read32(info)),
        entry = core ? 3 : 4;
      r.check(start, count * entry);
      for (let i = 0; i < count; i++)
        palette.push([
          r.data[start + i * entry + 2],
          r.data[start + i * entry + 1],
          r.data[start + i * entry],
        ]);
    }
    if (compression === 3) {
      const at = info + 40;
      r.check(at, 12);
      masks = [0, 4, 8].map((n) => r.read32(at + n));
      if (
        masks.some((m) => {
          if (!m || (depth === 16 && m > 0xffff)) return true;
          const low = (m & -m) >>> 0,
            shifted = (m >>> 0) / low;
          return (shifted & (shifted + 1)) !== 0;
        }) ||
        masks[0] & masks[1] ||
        masks[0] & masks[2] ||
        masks[1] & masks[2]
      )
        return failure(r, ERROR_INVALID_PARAMETER, 0, 6);
    }
    const channel = (v, mask) => {
      const low = mask & -mask,
        maximum = (mask >>> 0) / (low >>> 0);
      return Math.round(((((v & mask) >>> 0) / (low >>> 0)) * 255) / maximum);
    };
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const row = bits + (signedHeight < 0 ? y : height - 1 - y) * stride;
        let rgb;
        if (depth <= 8) {
          const index =
            depth === 8
              ? r.data[row + x]
              : depth === 4
                ? (r.data[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15
                : (r.data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
          rgb = palette[index];
          if (!rgb) return failure(r, ERROR_INVALID_PARAMETER, 0, 6);
        } else if (depth === 24)
          rgb = [r.data[row + x * 3 + 2], r.data[row + x * 3 + 1], r.data[row + x * 3]];
        else {
          const v =
            depth === 16
              ? r.view.getUint16(row + x * 2, true)
              : r.view.getUint32(row + x * 4, true);
          rgb = masks.map((mask) => channel(v, mask));
        }
        pixels.set([...rgb, 255], (y * width + x) * 4);
      }
  }
  const allocated = allocateHandle(r, state, 6);
  if (!allocated.result) return allocated;
  state.bitmaps.set(allocated.result, {
    kind: 'bitmap',
    stock: false,
    width,
    height,
    monochrome: depth === 1,
    pixels,
    dirty: false,
  });
  return allocated;
}

async function enumFontFamilies(r, a, wide) {
  const state = stateFor(r),
    dc = getDc(r, state, a(0));
  if (!dc) return badDc(r, 5);
  const pointer = a(1),
    proc = a(2);
  if (!pointer || !proc || a(4)) return failure(r, ERROR_INVALID_PARAMETER, 0, 5);
  const logSize = wide ? 92 : 60;
  r.check(pointer, logSize);
  const face = wide ? r.wideString(pointer + 28) : r.string(pointer + 28),
    charset = r.data[pointer + 23];
  if (![0, 1].includes(charset)) return success(1, 5);
  // Logical device fonts use the same browser CSS stack as TextOut. This is
  // the virtual display's font set, without pretending to expose host font files.
  const families = new Map([
    ['Arial', 'sans-serif'],
    ['Times New Roman', 'serif'],
    ['Courier New', 'monospace'],
  ]);
  for (const font of state.fonts.values())
    if (font.face !== 'sans-serif') families.set(font.face, font.face);
  const chosen = face
    ? [...families].filter(([name]) => name.toLowerCase() === face.toLowerCase())
    : [...families];
  let last = 1;
  for (const [name, family] of chosen) {
    const font = { ...DEFAULT_GDI_FONT, face: name, css: `16px ${JSON.stringify(family)}` };
    const measured = rasterizeGdiText(r, 'W', font);
    if (measured.error) return failure(r, ERROR_CALL_NOT_IMPLEMENTED, 0, 5);
    const enumSize = wide ? 348 : 188,
      tmSize = wide ? 60 : 56,
      record = r.allocate(enumSize + tmSize),
      tm = record + enumSize;
    try {
      r.write32(record, -16);
      r.write32(record + 16, 400);
      r.data[record + 23] = 0;
      const put = (at, text, count) => {
        for (let i = 0; i < Math.min(text.length, count - 1); i++)
          r.guestMemory.write(at + i * (wide ? 2 : 1), text.charCodeAt(i), wide ? 2 : 1);
      };
      put(record + 28, name, 32);
      put(record + logSize, name, 64);
      put(record + logSize + (wide ? 128 : 64), 'Regular', 32);
      put(record + logSize + (wide ? 192 : 96), 'Western', 32);
      const ascent = measured.mask.ascent ?? 12,
        width = Math.max(1, measured.mask.width);
      [16, ascent, 16 - ascent, 0, 0, width, width, 400, 0, 96, 96].forEach((v, i) =>
        r.write32(tm + i * 4, v),
      );
      if (wide) {
        [32, 255, 63, 32].forEach((v, i) => r.view.setUint16(tm + 44 + i * 2, v, true));
        r.data[tm + 55] = family === 'monospace' ? 0x30 : 0x21;
        r.data[tm + 56] = 0;
      } else {
        r.data.set([32, 255, 63, 32, 0, 0, 0, family === 'monospace' ? 0x30 : 0x21, 0], tm + 44);
      }
      last = await r.callGuest(proc, [record, tm, 2, a(3)]); // DEVICE_FONTTYPE
      if (!last) break;
    } finally {
      r.free(record);
    }
  }
  return success(last, 5);
}

function createBitmap(runtime, argument) {
  const state = stateFor(runtime);
  const width = signed(argument(0));
  const height = signed(argument(1));
  const planes = argument(2) >>> 0;
  const bitCount = argument(3) >>> 0;
  const bits = argument(4) >>> 0;
  if (width < 1 || height < 1 || width > 4096 || height > 4096 || planes !== 1)
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 5);
  if (![1, 4, 8, 24, 32].includes(bitCount)) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 5);
  if (width * height + totalSurfacePixels(state) > MAX_TOTAL_SURFACE_PIXELS)
    return failure(runtime, ERROR_NOT_ENOUGH_MEMORY, 0, 5);
  const pixels = opaquePixels(width, height);
  if (bits) {
    // Caller-supplied DDB bits use top-down, WORD-aligned rows.
    try {
      copyBitmapRows(runtime, bits, width, height, bitCount, pixels);
    } catch {
      return failure(runtime, ERROR_INVALID_PARAMETER, 0, 5);
    }
  }
  const allocated = allocateHandle(runtime, state, 5);
  if (!allocated.result) return allocated;
  state.bitmaps.set(allocated.result, {
    kind: 'bitmap',
    stock: false,
    width,
    height,
    monochrome: bitCount === 1,
    depth: bitCount,
    pixels,
    dirty: false,
  });
  return allocated;
}
function copyBitmapRows(runtime, source, width, height, bitCount, pixels) {
  // CreateBitmap receives device-dependent bitmap bits: top-down scanlines
  // aligned to WORDs. DIB APIs separately retain their DWORD-aligned layout.
  const stride = Math.ceil((width * bitCount) / 16) * 2;
  runtime.check(source, stride * height);
  for (let y = 0; y < height; y++) {
    const row = source + y * stride;
    for (let x = 0; x < width; x++) {
      let rgb = [0, 0, 0];
      if (bitCount === 32) {
        const at = row + x * 4;
        rgb = [runtime.data[at + 2], runtime.data[at + 1], runtime.data[at]];
      } else if (bitCount === 24) {
        const at = row + x * 3;
        rgb = [runtime.data[at + 2], runtime.data[at + 1], runtime.data[at]];
      } else if (bitCount === 8) {
        const grey = runtime.data[row + x];
        rgb = [grey, grey, grey];
      } else if (bitCount === 4) {
        const byte = runtime.data[row + (x >> 1)];
        const grey = x & 1 ? (byte & 0x0f) * 17 : (byte >> 4) * 17;
        rgb = [grey, grey, grey];
      } else {
        const byte = runtime.data[row + (x >> 3)];
        const grey = byte & (0x80 >> (x & 7)) ? 255 : 0;
        rgb = [grey, grey, grey];
      }
      const offset = (y * width + x) * 4;
      pixels[offset] = rgb[0];
      pixels[offset + 1] = rgb[1];
      pixels[offset + 2] = rgb[2];
      pixels[offset + 3] = 255;
    }
  }
}
// Measure each character separately. The float APIs retain Canvas's fractional
// advances and ink bounds. Integer APIs round to device pixels. All use four
// stdcall arguments, including ABC queries with three fields per character.
function charWidths(runtime, argument, wide, floatOut, abc = false) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 4);
  const first = argument(1) >>> 0;
  const last = argument(2) >>> 0;
  const out = argument(3);
  if (last < first || last > (wide ? 0xffff : 255) || !out)
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 4);
  const font = currentFont(runtime, state, dc) ?? DEFAULT_GDI_FONT;
  const count = last - first + 1;
  const fields = abc ? 3 : 1;
  runtime.check(out, count * fields * 4, true);
  const values = new Float64Array(count * fields);
  for (let i = 0; i < count; i++) {
    const code = first + i;
    const text = wide ? String.fromCharCode(code) : decodeAnsi(Uint8Array.of(code));
    const measured = rasterizeGdiText(runtime, text, font);
    if (measured.error)
      return failure(
        runtime,
        measured.error === 'backend' ? ERROR_CALL_NOT_IMPLEMENTED : ERROR_INVALID_PARAMETER,
        0,
        4,
      );
    const mask = measured.mask;
    const advance = mask.advance ?? mask.width;
    if (!abc) values[i] = floatOut ? advance : Math.round(advance);
    else {
      if (!Number.isFinite(mask.left) || !Number.isFinite(mask.inkWidth) || mask.inkWidth < 0)
        return failure(runtime, ERROR_CALL_NOT_IMPLEMENTED, 0, 4);
      const left = floatOut ? mask.left : Math.round(mask.left);
      const ink = floatOut ? mask.inkWidth : Math.round(mask.inkWidth);
      values.set([left, ink, (floatOut ? advance : Math.round(advance)) - left - ink], i * 3);
    }
  }
  // Validate/measure the complete range before writing so failures cannot
  // expose a partially initialized caller buffer.
  for (let i = 0; i < values.length; i++)
    if (floatOut) runtime.view.setFloat32(out + i * 4, values[i], true);
    else runtime.write32(out + i * 4, values[i]);
  return success(1, 4);
}
// ExtTextOutA/W(HDC, X, Y, Options, RECT *, String, Count, Spacing) is TextOut
// plus an opaque/transparent rectangle and an optional per-character spacing
// array. The runtime paints the text and applies the documented background
// rule; a spacing array is applied by widening each glyph's advance.
function extTextOut(runtime, argument, wide) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 8);
  const x = signed(argument(1));
  const y = signed(argument(2));
  const options = argument(3) >>> 0;
  if (options & ~(0x2 | 0x4 | 0x10 | 0x10000))
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 8);
  const rectPointer = argument(4);
  const spacing = argument(7);
  let text;
  try {
    text = readGdiText(runtime, argument(5), signed(argument(6)), wide);
  } catch {
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 8);
  }
  const font = currentFont(runtime, state, dc) ?? DEFAULT_GDI_FONT;
  // ETO_OPAQUE (0x2) fills the supplied rectangle with the background colour
  // before the text; ETO_CLIPPED (0x4) is a hint the DC clip already enforces.
  if (options & 0x2 && rectPointer) {
    const rect = [0, 4, 8, 12].map((i) => runtime.read32(rectPointer + i) | 0);
    paintRect(
      dc.surface,
      rect[0],
      rect[1],
      rect[2],
      rect[3],
      { color: dc.backgroundColor, null: false },
      'copy',
      dc,
    );
  }
  let textDc = dc;
  if (options & 4 && rectPointer) {
    textDc = { ...dc };
    setClipPieces(
      textDc,
      intersectClip(
        clipPieces(dc, dc.surface),
        [0, 4, 8, 12].map((i) => runtime.read32(rectPointer + i) | 0),
      ),
    );
  }
  const measured = rasterizeGdiText(runtime, text, font);
  if (measured.error === 'backend') return failure(runtime, ERROR_CALL_NOT_IMPLEMENTED, 0, 8);
  if (measured.error) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 8);
  if (!spacing) {
    paintGdiText(dc.surface, textDc, x, y, measured.mask, font);
    return success(1, 8);
  }
  // A spacing array positions each glyph independently; paint them one at a
  // time at their accumulated offsets.
  runtime.check(spacing, text.length * 4);
  let cursor = x;
  for (let i = 0; i < text.length; i++) {
    const glyph = rasterizeGdiText(runtime, text[i], font);
    if (!glyph.error) paintGdiText(dc.surface, textDc, cursor, y, glyph.mask, font);
    cursor += runtime.read32(spacing + i * 4) | 0 || measured.mask.width / text.length;
  }
  return success(1, 8);
}
// Both APIs take HDC first, then HBITMAP. A scan offset counts from the
// bottom of the described image, including top-down partial buffers (the
// latter begin at height - start - count). This matches Wine's native tests.
function dibPalette(state, dc) {
  return state.palettes
    ?.get(dc.palette ?? STOCK_DEFAULT_PALETTE)
    ?.entries.map((entry) => [entry.red, entry.green, entry.blue]);
}
function setDIBits(r, a) {
  const state = stateFor(r),
    dc = getDc(r, state, a(0));
  if (!dc) return badDc(r, 7);
  const bitmap = state.bitmaps.get(a(1) >>> 0);
  if (!bitmap) return failure(r, ERROR_INVALID_HANDLE, 0, 7);
  refreshDibPixels(r, bitmap);
  const start = a(2) >>> 0,
    lines = a(3) >>> 0,
    bits = a(4),
    usage = a(6) >>> 0;
  if (!bits) return failure(r, ERROR_INVALID_PARAMETER, 0, 7);
  const layout = readDibLayout(r, a(5), usage, { paletteEntries: dibPalette(state, dc) });
  if (!layout) return failure(r, ERROR_INVALID_PARAMETER, 0, 7);
  if (!lines || start >= layout.height) return success(0, 7);
  const count = layout.signedHeight < 0 ? lines : Math.min(lines, layout.height - start);
  if (count > 4096) return failure(r, ERROR_INVALID_PARAMETER, 0, 7);
  r.check(bits, layout.stride * count);
  const width = Math.min(bitmap.width, layout.width);
  // Stage decoded rows before modifying the object. Padding and unused
  // source columns are ignored; callers retain ownership of the input bits.
  const changes = [];
  for (let row = 0; row < count; row++) {
    const y =
      layout.signedHeight < 0
        ? layout.height - count - start + row
        : layout.height - 1 - start - row;
    if (y < 0 || y >= bitmap.height) continue;
    const pixels = new Uint8ClampedArray(width * 4);
    for (let x = 0; x < width; x++) {
      let rgb = readDibPixel(r, layout, bits + row * layout.stride, x);
      if (!rgb) return failure(r, ERROR_INVALID_PARAMETER, 0, 7);
      if (bitmap.monochrome) {
        const value = rgb.reduce((sum, channel) => sum + channel, 0) >= 3 * 128 ? 255 : 0;
        rgb = [value, value, value];
      }
      pixels.set([...rgb, 255], x * 4);
    }
    changes.push([y, pixels]);
  }
  for (const [y, pixels] of changes) bitmap.pixels.set(pixels, y * bitmap.width * 4);
  for (const [y] of changes) markGdiDirty(bitmap, 0, y, width, y + 1);
  return success(count, 7);
}
function getDIBits(r, a) {
  const state = stateFor(r),
    dc = getDc(r, state, a(0));
  if (!dc) return badDc(r, 7);
  const bitmap = state.bitmaps.get(a(1) >>> 0);
  if (!bitmap) return failure(r, ERROR_INVALID_HANDLE, 0, 7);
  refreshDibPixels(r, bitmap);
  const start = a(2) >>> 0,
    lines = a(3) >>> 0,
    bits = a(4),
    info = a(5),
    usage = a(6) >>> 0;
  if (!info || usage > 1) return failure(r, ERROR_INVALID_PARAMETER, 0, 7);
  r.check(info, 12, true);
  const size = r.read32(info),
    core = size === 12;
  if (![12, 40, 52, 56, 108, 124].includes(size)) return failure(r, ERROR_INVALID_PARAMETER, 0, 7);
  r.check(info, size, true);
  if (!r.view.getUint16(info + (core ? 10 : 14), true) && (!bits || !lines)) {
    const depth = bitmap.dib?.layout.depth ?? (bitmap.monochrome ? 1 : 32);
    if (core) {
      r.view.setUint16(info + 4, bitmap.width, true);
      r.view.setUint16(info + 6, bitmap.height, true);
      r.view.setUint16(info + 8, 1, true);
      r.view.setUint16(info + 10, depth, true);
    } else {
      r.write32(info + 4, bitmap.width);
      r.write32(info + 8, bitmap.height);
      r.view.setUint16(info + 12, 1, true);
      r.view.setUint16(info + 14, depth, true);
      r.write32(info + 16, bitmap.dib?.layout.compression ?? 0);
      r.write32(info + 20, Math.ceil((bitmap.width * depth) / 32) * 4 * bitmap.height);
      for (const offset of [24, 28, 32, 36]) r.write32(info + offset, 0);
    }
    return success(1, 7);
  }
  const layout = readDibLayout(r, info, usage, {
    output: true,
    paletteEntries: dibPalette(state, dc),
  });
  if (!layout) return failure(r, ERROR_INVALID_PARAMETER, 0, 7);
  if (bitmap.dib && layout.depth === bitmap.dib.layout.depth) {
    if (layout.depth <= 8 && usage === 0) layout.palette = bitmap.dib.layout.palette;
    if (layout.compression === 3) layout.masks = bitmap.dib.layout.masks;
  }
  if (!bits || !lines || start >= layout.height) {
    writeDibColorTable(r, layout, usage);
    return success(1, 7);
  }
  const count = Math.min(lines, layout.height - start);
  r.check(bits, layout.stride * count, true);
  r.data.fill(0, bits, bits + layout.stride * count);
  for (let row = 0; row < count; row++) {
    const y =
      layout.signedHeight < 0
        ? layout.height - count - start + row
        : layout.height - 1 - start - row;
    if (y < 0 || y >= bitmap.height) continue;
    for (let x = 0; x < Math.min(layout.width, bitmap.width); x++) {
      const at = (y * bitmap.width + x) * 4;
      writeDibPixel(r, layout, bits + row * layout.stride, x, bitmap.pixels.subarray(at, at + 3));
    }
  }
  writeDibColorTable(r, layout, usage);
  return success(count, 7);
}

// ---------------------------------------------------------------------------
// Palettes. The virtual display is a true-colour device, so a palette never
// changes the pixels — but applications still create, select and query one, and
// refusing the calls breaks their setup. The object records the entries it was
// given so SetPaletteEntries/GetPaletteEntries round-trip honestly.
function createPalette(runtime, argument) {
  const state = stateFor(runtime);
  const pointer = argument(0) >>> 0;
  if (!pointer) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
  runtime.check(pointer, 8);
  const version = runtime.guestMemory.read(pointer, 2);
  const count = runtime.guestMemory.read(pointer + 2, 2);
  if (version !== 0x300 || count > 256) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
  runtime.check(pointer + 4, count * 4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = pointer + 4 + i * 4;
    entries.push({
      red: runtime.data[at],
      green: runtime.data[at + 1],
      blue: runtime.data[at + 2],
      flags: 0,
    });
  }
  const allocated = allocateHandle(runtime, state, 1);
  if (!allocated.result) return allocated;
  state.palettes ??= new Map();
  state.palettes.set(allocated.result, { kind: 'palette', stock: false, entries });
  return allocated;
}
function selectPalette(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 3, 0);
  const palette = state.palettes?.get(argument(1) >>> 0);
  if (!palette) return failure(runtime, ERROR_INVALID_HANDLE, 0, 3);
  const previous = dc.palette ?? STOCK_DEFAULT_PALETTE;
  dc.palette = argument(1) >>> 0;
  dc.paletteForced = !!argument(2);
  // Selecting a palette on a true-colour DC does not realize it.
  return success(previous, 3);
}
// RealizePalette reports how many palette entries the device mapped. A
// true-colour device maps none of them, and Windows reports 0 in that case.
function realizePalette(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 1, 0);
  return success(0, 1);
}
function updateColors(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 1, 0);
  return success(0, 1);
}
function setPaletteEntries(runtime, argument) {
  const state = stateFor(runtime);
  const palette = state.palettes?.get(argument(0) >>> 0);
  if (!palette) return failure(runtime, ERROR_INVALID_HANDLE, 0, 4);
  if (palette.stock) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 4);
  const first = argument(1) >>> 0;
  const count = argument(2) >>> 0;
  const pointer = argument(3);
  if (!pointer || first + count > palette.entries.length || count > 256)
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 4);
  runtime.check(pointer, count * 4);
  for (let i = 0; i < count; i++) {
    const at = pointer + i * 4;
    palette.entries[first + i] = {
      red: runtime.data[at],
      green: runtime.data[at + 1],
      blue: runtime.data[at + 2],
      flags: 0,
    };
  }
  return success(count, 4);
}
function getPaletteEntries(runtime, argument) {
  const state = stateFor(runtime);
  const palette = state.palettes?.get(argument(0) >>> 0);
  if (!palette) return failure(runtime, ERROR_INVALID_HANDLE, 0, 4);
  const first = argument(1) >>> 0;
  const count = argument(2) >>> 0;
  const pointer = argument(3);
  if (first + count > palette.entries.length)
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 4);
  if (!pointer) return success(palette.entries.length, 4);
  runtime.check(pointer, count * 4, true);
  for (let i = 0; i < count; i++) {
    const entry = palette.entries[first + i];
    const at = pointer + i * 4;
    runtime.data[at] = entry.red;
    runtime.data[at + 1] = entry.green;
    runtime.data[at + 2] = entry.blue;
    runtime.data[at + 3] = 0;
  }
  return success(count, 4);
}
// UnrealizeObject and UpdateColors are true-colour no-ops that report success.
function unrealizeObject(runtime, argument) {
  const state = stateFor(runtime);
  const handle = argument(0) >>> 0;
  if (!state.palettes?.has(handle) && !getBrush(state, handle) && !getPen(state, handle))
    return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  return success(1, 1);
}
// TranslateCharsetInfo maps a character set to a code page, or the reverse. The
// runtime only ever advertises the ANSI and OEM pages it actually implements.
function translateCharsetInfo(runtime, argument) {
  const source = argument(0);
  const out = argument(1);
  const flags = argument(2) >>> 0;
  if (!out) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  runtime.check(out, 16, true);
  runtime.data.fill(0, out, out + 16);
  // DEFAULT_CHARSET (1) and ANSI_CHARSET (0) both map to CP1252; OEM_CHARSET
  // (255) maps to CP437.
  const charset = flags === 1 ? (source ? runtime.read32(source) : 1) : 1;
  runtime.write32(out, charset === 255 ? 437 : 1252);
  runtime.write32(out + 4, 0);
  runtime.write32(out + 8, 0);
  runtime.write32(out + 12, charset);
  return success(1, 3);
}

// GetOutlineTextMetricsA/W fills an OUTLINETEXTMETRIC. The runtime's fonts are
// not vector faces with an outline to query, so it reports the device-space
// text metrics in the structure's OTM_SIZE header and leaves the outline
// records zero rather than inventing control points.
function getOutlineTextMetrics(runtime, argument, wide) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 2);
  const size = argument(1) | 0;
  const out = argument(2);
  // The OTM header on i386 begins with UINT otmSize followed by TEXTMETRIC
  // (56 or 60 bytes) and the rest of the outline records.
  const needed = 4 + (wide ? 60 : 56) + 20 * 4;
  if (!out) return success(needed, 2);
  if (size < needed) return failure(runtime, ERROR_INSUFFICIENT_BUFFER, 0, 2);
  runtime.check(out, needed, true);
  runtime.data.fill(0, out, out + needed);
  runtime.write32(out, needed);
  const metrics = out + 4;
  const { height, width, ascent } = fontMetrics(runtime, state, dc);
  runtime.write32(metrics, height);
  runtime.write32(metrics + 4, ascent);
  runtime.write32(metrics + 8, height - ascent);
  runtime.write32(metrics + 20, width);
  runtime.write32(metrics + 24, width);
  runtime.write32(metrics + 28, 700);
  runtime.data[metrics + 40] = 0x31;
  return success(needed, 2);
}
// GetCharacterPlacementW computes glyph placement for a string under the
// selected font. The runtime lays text out linearly, so the placement is the
// accumulated advance per character, which is exact for the monospaced faces
// these calls are used with.
function getCharacterPlacement(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 6);
  const pointer = argument(1) >>> 0;
  const count = argument(2) | 0;
  const maxExtent = argument(3) | 0;
  const results = argument(4);
  const flags = argument(5) >>> 0;
  if (count < 0 || count > 0x10000) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 6);
  if (results) {
    runtime.check(results, 28, true);
    runtime.data.fill(0, results, results + 28);
  }
  let text = '';
  try {
    text = readGdiText(runtime, pointer, count, true);
  } catch {
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 6);
  }
  const font = currentFont(runtime, state, dc) ?? DEFAULT_GDI_FONT;
  const measured = rasterizeGdiText(runtime, text, font);
  const width = measured.error ? text.length * 8 : measured.mask.width;
  const height = measured.error ? font.height : Math.max(font.height, measured.mask.height);
  if (results) {
    // GCP_RESULTSW: lStructSize, lpOutString, lpOrder, lpDx, lpCaretPos,
    // lpClass, lpGlyphs, nGlyphs, nMaxFit.
    runtime.write32(results, 28);
    runtime.write32(
      results + 24,
      maxExtent > 0 && width > maxExtent ? text.length - 1 : text.length,
    );
  }
  return success((height << 16) | (width & 0xffff), 6);
  void flags;
}

// DrawIconEx(HDC, X, Y, HICON, Cx, Cy, Istep, HbrFlickerFree, DiFlags) paints a
// decoded icon at the requested size. The runtime's icon objects carry RGBA
// pixels, so this is a straightforward scaled blit; the flicker brush and the
// animation step only matter for an animated cursor, which the desktop draws
// itself.
function drawIconEx(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 9);
  const x = signed(argument(1));
  const y = signed(argument(2));
  const icon = iconForHandle(runtime, argument(3) >>> 0);
  if (!icon) return failure(runtime, ERROR_INVALID_HANDLE, 0, 9);
  const flags = argument(8) >>> 0;
  if (flags & ~0xf) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 9);
  // DI_NORMAL (0x3) draws the image; DI_MASK/DI_IMAGE select one channel.
  const drawMaskOnly = flags & 0x1 && !(flags & 0x2);
  const width = Math.max(1, argument(4) ? Math.abs(signed(argument(4))) : icon.width);
  const height = Math.max(1, argument(5) ? Math.abs(signed(argument(5))) : icon.height);
  const surface = dc.surface;
  for (let py = 0; py < height; py++) {
    const sy = Math.min(icon.height - 1, Math.floor((py * icon.height) / height));
    for (let px = 0; px < width; px++) {
      const sx = Math.min(icon.width - 1, Math.floor((px * icon.width) / width));
      const source = (sy * icon.width + sx) * 4;
      const alpha = icon.pixels[source + 3];
      const targetX = x + px,
        targetY = y + py;
      if (!visiblePixel(surface, dc, targetX, targetY)) continue;
      const offset = (targetY * surface.width + targetX) * 4;
      if (drawMaskOnly) {
        surface.pixels[offset] = 0;
        surface.pixels[offset + 1] = 0;
        surface.pixels[offset + 2] = 0;
        surface.pixels[offset + 3] = 255;
        continue;
      }
      // An icon pixel is composited over whatever the surface already holds,
      // which is what makes a transparent icon background work.
      const a = alpha / 255;
      surface.pixels[offset] = Math.round(
        icon.pixels[source] * a + surface.pixels[offset] * (1 - a),
      );
      surface.pixels[offset + 1] = Math.round(
        icon.pixels[source + 1] * a + surface.pixels[offset + 1] * (1 - a),
      );
      surface.pixels[offset + 2] = Math.round(
        icon.pixels[source + 2] * a + surface.pixels[offset + 2] * (1 - a),
      );
      surface.pixels[offset + 3] = 255;
    }
  }
  markGdiDirty(surface, x, y, x + width, y + height);
  return success(1, 9);
}

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
    [15, STOCK_DEFAULT_PALETTE],
  ]);
  const handle = handles.get(index) ?? 0;
  if (!handle) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 1);
  stateFor(runtime);
  return success(handle, 1);
}

// Each level owns a snapshot of the DC attributes, never its framebuffer.
// Positive RestoreDC ids and negative relative levels both discard that level
// and all younger saves. Saved selections keep objects alive until discarded.
function getDcAttribute(runtime, a, key) {
  const dc = getDc(runtime, stateFor(runtime), a(0));
  return dc
    ? success(dc[key], 1)
    : failure(runtime, ERROR_INVALID_HANDLE, key === 'bkMode' ? 0 : 0xffffffff, 1);
}
function saveDC(runtime, a) {
  const state = stateFor(runtime),
    dc = getDc(runtime, state, a(0));
  if (!dc) return badDc(runtime, 1);
  const stack = (dc.savedStates ??= []);
  if (stack.length >= 256) return failure(runtime, ERROR_NOT_ENOUGH_MEMORY, 0, 1);
  const { savedStates, surface, ...attributes } = dc;
  stack.push({
    ...attributes,
    currentPoint: { ...dc.currentPoint },
    clip: dc.clip?.slice(),
    clipRects: dc.clipRects?.map((rect) => rect.slice()),
  });
  return success(stack.length, 1);
}
function restoreDC(runtime, a) {
  const state = stateFor(runtime),
    dc = getDc(runtime, state, a(0));
  if (!dc) return badDc(runtime, 2);
  const stack = dc.savedStates ?? [],
    level = a(1) | 0;
  const index = level < 0 ? stack.length + level : level - 1;
  if (!level || index < 0 || index >= stack.length)
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
  const snapshot = stack[index];
  const previousBitmap = state.bitmaps.get(dc.bitmap);
  if (previousBitmap && !previousBitmap.stock) previousBitmap.selectedBy = null;
  for (const key of Object.keys(dc)) if (!['surface', 'savedStates'].includes(key)) delete dc[key];
  Object.assign(dc, snapshot);
  stack.splice(index);
  if (dc.kind === 'memory-dc') {
    const bitmap = state.bitmaps.get(dc.bitmap);
    bitmap.selectedBy = a(0);
    dc.surface = bitmap;
  }
  return success(1, 2);
}
function savedSelection(state, handle, key, except = null) {
  for (const dc of state.dcs.values())
    if (dc.active && dc !== except && dc.savedStates?.some((saved) => saved[key] === handle))
      return true;
  return false;
}

function selectObject(runtime, argument) {
  const state = stateFor(runtime);
  const dcHandle = argument(0) >>> 0;
  const dc = getDc(runtime, state, dcHandle);
  if (!dc) return badDc(runtime, 2);
  const objectHandle = argument(1) >>> 0;
  const region = state.regions.get(objectHandle);
  if (region) return success(setClipPieces(dc, region.pieces), 2);
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
  if (
    (bitmap.selectedBy && bitmap.selectedBy !== dcHandle) ||
    savedSelection(state, objectHandle, 'bitmap', dc)
  )
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
  if (state.regions.delete(handle)) return success(1, 1);
  const palette = state.palettes.get(handle);
  if (palette) {
    if (palette.stock) return success(1, 1);
    if (
      [...state.dcs.values()].some(
        (dc) => dc.active && (dc.palette === handle || savedSelection(state, handle, 'palette')),
      )
    )
      return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
    state.palettes.delete(handle);
    return success(1, 1);
  }
  const brush = getBrush(state, handle);
  if (brush) {
    if (brush.stock) return success(1, 1);
    for (const dc of state.dcs.values())
      if (
        dc.active &&
        (dc.brush === handle || dc.savedStates?.some((saved) => saved.brush === handle))
      )
        return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
    state.brushes.delete(handle);
    return success(1, 1);
  }
  const pen = getPen(state, handle);
  if (pen) {
    if (pen.stock) return success(1, 1);
    for (const dc of state.dcs.values())
      if (dc.active && (dc.pen === handle || dc.savedStates?.some((saved) => saved.pen === handle)))
        return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
    state.pens.delete(handle);
    return success(1, 1);
  }
  const font = getFont(state, handle);
  if (font) {
    if (font.stock) return success(1, 1);
    for (const dc of state.dcs.values())
      if (
        dc.active &&
        (dc.font === handle || dc.savedStates?.some((saved) => saved.font === handle))
      )
        return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
    state.fonts.delete(handle);
    return success(1, 1);
  }
  const bitmap = state.bitmaps.get(handle);
  if (!bitmap) return failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  if (bitmap.stock || bitmap.selectedBy || savedSelection(state, handle, 'bitmap'))
    return bitmap.stock ? success(1, 1) : failure(runtime, ERROR_INVALID_HANDLE, 0, 1);
  if (bitmap.dib) {
    releaseDibStorage(runtime, bitmap.dib);
    state.dibBitmaps.delete(bitmap);
  }
  state.bitmaps.delete(handle);
  return success(1, 1);
}

// Filled/stroked shapes built on the same raster primitives as FillRect and
// LineTo. A shape is drawn with the DC's selected brush and pen: the brush fills
// the interior and the pen outlines it, exactly as GDI documents.
function shapePen(runtime, state, dc) {
  const pen = getPen(state, dc.pen);
  return pen ?? null;
}
function shapeBrush(runtime, state, dc) {
  const brush = getBrush(state, dc.brush);
  return brush ?? null;
}
// Scan-converts an implicitly closed polygon using the even-odd rule, which is
// what GDI's Polygon and Ellipse both use for a single convex outline.
function fillPolygon(dc, points, brush) {
  if (!points.length || !brush || brush.null) return false;
  let minY = Infinity,
    maxY = -Infinity;
  for (const [, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(dc.surface.height - 1, Math.ceil(maxY));
  let changed = false;
  for (let y = minY; y <= maxY; y++) {
    const crossings = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if (y1 === y2) continue;
      if (y >= Math.min(y1, y2) && y < Math.max(y1, y2)) {
        const t = (y - y1) / (y2 - y1);
        crossings.push(x1 + t * (x2 - x1));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      if (
        paintRect(
          dc.surface,
          Math.round(crossings[i]),
          y,
          Math.round(crossings[i + 1]) + 1,
          y + 1,
          brush,
          'copy',
          dc,
        )
      )
        changed = true;
    }
  }
  return changed;
}
function strokePolygon(dc, points, pen, close) {
  if (!pen || pen.style === 5 || points.length < 2) return false;
  let changed = false;
  for (let i = 0; i + 1 < points.length; i++)
    if (
      drawLine(dc.surface, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], pen, dc)
    )
      changed = true;
  if (close && points.length > 2)
    if (
      drawLine(dc.surface, points.at(-1)[0], points.at(-1)[1], points[0][0], points[0][1], pen, dc)
    )
      changed = true;
  return changed;
}
// Reads an array of POINT values from guest memory with a bounded count.
function readPoints(runtime, pointer, count) {
  if (!pointer || !count || count > 1024) return null;
  runtime.check(pointer, count * 8);
  return Array.from({ length: count }, (_, i) => [
    signed(runtime.read32(pointer + i * 8)),
    signed(runtime.read32(pointer + i * 8 + 4)),
  ]);
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

// Brush frames preserve selections and use the DC's copied clips/origins.
function frameRect(runtime, argument) {
  const state = stateFor(runtime),
    dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 3);
  const rect = argument(1) && readRect(runtime, argument(1));
  if (!rect) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  const [left, top, right, bottom] = rect;
  if (right <= left || bottom <= top) return success(0, 3);
  const brush = getBrush(state, argument(2));
  if (!brush) return failure(runtime, ERROR_INVALID_HANDLE, 0, 3);
  paintRect(dc.surface, left, top, left + 1, bottom, brush, 'copy', dc);
  paintRect(dc.surface, right - 1, top, right, bottom, brush, 'copy', dc);
  paintRect(dc.surface, left, top, right, top + 1, brush, 'copy', dc);
  paintRect(dc.surface, left, bottom - 1, right, bottom, brush, 'copy', dc);
  return success(1, 3);
}

function drawFocusRect(runtime, argument) {
  const state = stateFor(runtime),
    dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 2);
  const rect = argument(1) && readRect(runtime, argument(1));
  if (!rect) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
  if (paintFocusRect(dc.surface, ...rect, dc) === null)
    return failure(runtime, ERROR_CALL_NOT_IMPLEMENTED, 0, 2);
  return success(1, 2);
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

function stretchBlt(r, a) {
  const state = stateFor(r),
    dst = getDc(r, state, a(0)),
    src = getDc(r, state, a(5));
  if (!dst || !src) return failure(r, ERROR_INVALID_HANDLE, 0, 11);
  const x = a(1) | 0,
    y = a(2) | 0,
    w = a(3) | 0,
    h = a(4) | 0,
    sx = a(6) | 0,
    sy = a(7) | 0,
    sw = a(8) | 0,
    sh = a(9) | 0;
  if (a(10) !== SRCCOPY) throw Error('Unsupported StretchBlt raster operation');
  if (w < 0 || h < 0 || sw < 0 || sh < 0) return failure(r, ERROR_INVALID_PARAMETER, 0, 11);
  if (!w || !h || !sw || !sh) return success(1, 11);
  if (
    w > 4096 ||
    h > 4096 ||
    sw > 4096 ||
    sh > 4096 ||
    sx < 0 ||
    sy < 0 ||
    sx + sw > src.surface.width ||
    sy + sh > src.surface.height
  )
    return failure(r, ERROR_INVALID_PARAMETER, 0, 11);
  if (!readablePixels(src.surface, sx, sy, sw, sh))
    return failure(r, ERROR_CALL_NOT_IMPLEMENTED, 0, 11);
  const source = src.surface.pixels.slice();
  const [left, top, right, bottom] = clippedBounds(dst.surface, x, y, x + w, y + h, dst);
  for (let dy = top; dy < bottom; dy++)
    for (let dx = left; dx < right; dx++) {
      if (!visiblePixel(dst.surface, dst, dx, dy)) continue;
      const ix = sx + Math.floor(((dx - x) * sw) / w),
        iy = sy + Math.floor(((dy - y) * sh) / h),
        p = (iy * src.surface.width + ix) * 4,
        q = (dy * dst.surface.width + dx) * 4;
      let rgb = [...source.subarray(p, p + 3)];
      if (src.surface.monochrome && !dst.surface.monochrome)
        rgb = colorRgb(rgb[0] === 0 ? dst.textColor : dst.backgroundColor);
      else if (!src.surface.monochrome && dst.surface.monochrome)
        rgb = Array(3).fill(rgbColorRef(rgb) === src.backgroundColor ? 255 : 0);
      dst.surface.pixels.set(rgb, q);
      dst.surface.pixels[q + 3] = 255;
    }
  markGdiDirty(dst.surface, left, top, right, bottom);
  return success(1, 11);
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
  const [left, top, right, bottom] = clippedBounds(
    destination.surface,
    x,
    y,
    x + width,
    y + height,
    destination,
  );
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

  if (!readablePixels(source.surface, sx, sy, copyWidth, copyHeight))
    return failure(runtime, ERROR_CALL_NOT_IMPLEMENTED, 0, 9);
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
      if (!visiblePixel(destination.surface, destination, left + column, top + row)) continue;
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
  if (changed) markGdiDirty(destination.surface, left, top, right, bottom);
  return success(1, 9);
}

function setPixel(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 4, CLR_INVALID);
  const surface = dc.surface;
  const x = signed(argument(1)),
    y = signed(argument(2));
  if (!visiblePixel(surface, dc, x, y))
    return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 4);
  const color = argument(3) >>> 0;
  if (color & 0xff000000) return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 4);
  const rgb = surfaceRgb(surface, colorRgb(color));
  const offset = (y * surface.width + x) * 4;
  const pixels = surface.pixels;
  if (
    pixels[offset] !== rgb[0] ||
    pixels[offset + 1] !== rgb[1] ||
    pixels[offset + 2] !== rgb[2] ||
    pixels[offset + 3] !== 255
  )
    markGdiDirty(surface, x, y, x + 1, y + 1);
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
  if (!visiblePixel(surface, dc, x, y))
    return failure(runtime, ERROR_INVALID_PARAMETER, CLR_INVALID, 3);
  if (!readablePixels(surface, x, y, 1, 1))
    return failure(runtime, ERROR_CALL_NOT_IMPLEMENTED, CLR_INVALID, 3);
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
  drawLine(dc.surface, originalX, originalY, x1, y1, pen, dc);
  return success(1, 3);
}

// GetTextExtentPoint32A/W reports the width and height the selected font needs
// for a string, which layout code uses to size controls and centre text. The
// rasterizer measures through the same canvas the glyphs come from, so the
// reported extent matches what TextOut actually paints.
function getTextExtentPoint32(runtime, argument, wide) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 4);
  let text;
  try {
    text = readGdiText(runtime, argument(1), signed(argument(2)), wide);
  } catch {
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 4);
  }
  const font = dc.font ? getFont(state, dc.font) : null;
  if (dc.font && !font) return failure(runtime, ERROR_INVALID_HANDLE, 0, 4);
  const descriptor = font ?? DEFAULT_GDI_FONT;
  const measured = rasterizeGdiText(runtime, text, descriptor);
  // An empty string still reports the font's line height, which lay-out code
  // relies on for an empty edit control.
  const width = measured.error ? text.length * 8 : measured.mask.width;
  const height = measured.error
    ? descriptor.height
    : Math.max(descriptor.height, measured.mask.height);
  const out = argument(3);
  if (!out) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 4);
  runtime.check(out, 8, true);
  runtime.write32(out, width);
  runtime.write32(out + 4, height);
  return success(1, 4);
}
// GetTextExtentPointA/W and GetTextExtentExPointA/W share the measurement above;
// the "Ex" form additionally reports how many characters fit in a width.
function getTextExtentExPoint(runtime, argument, wide) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 7);
  let text;
  try {
    text = readGdiText(runtime, argument(1), signed(argument(2)), wide);
  } catch {
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, 7);
  }
  const font = dc.font ? getFont(state, dc.font) : null;
  if (dc.font && !font) return failure(runtime, ERROR_INVALID_HANDLE, 0, 7);
  const descriptor = font ?? DEFAULT_GDI_FONT;
  const measured = rasterizeGdiText(runtime, text, descriptor);
  const width = measured.error ? text.length * 8 : measured.mask.width;
  const height = measured.error
    ? descriptor.height
    : Math.max(descriptor.height, measured.mask.height);
  const maxExtent = argument(3) | 0;
  const fitCount = argument(4);
  const extents = argument(5);
  const sizeOut = argument(6);
  let fits = text.length;
  if (maxExtent > 0 && width > maxExtent) {
    // Approximate the per-character advance uniformly: the canvas mask reports
    // the total, and a uniform split is exact for the monospaced fonts these
    // extent queries are used with.
    const per = text.length ? width / text.length : 0;
    fits = per > 0 ? Math.min(text.length, Math.floor(maxExtent / per)) : 0;
  }
  if (fitCount) {
    runtime.check(fitCount, 4, true);
    runtime.write32(fitCount, fits);
  }
  if (extents) {
    runtime.check(extents, text.length * 4, true);
    const per = text.length ? width / text.length : 0;
    for (let i = 0; i < text.length; i++)
      runtime.write32(extents + i * 4, Math.round(per * (i + 1)));
  }
  if (sizeOut) {
    runtime.check(sizeOut, 8, true);
    runtime.write32(sizeOut, width);
    runtime.write32(sizeOut + 4, height);
  }
  return success(1, 7);
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

// DrawText/DrawTextEx: lay a string out inside a client rectangle using the
// same font rasterizer as TextOut. Straightforward formatting flags are acted
// on; a flag whose effect is not modeled makes the call fail instead of
// silently mis-formatting the text.
const DT_CENTER = 0x1,
  DT_RIGHT = 0x2,
  DT_VCENTER = 0x4,
  DT_BOTTOM = 0x8,
  DT_WORDBREAK = 0x10,
  DT_SINGLELINE = 0x20,
  DT_EXPANDTABS = 0x40,
  DT_TABSTOP = 0x80,
  DT_NOCLIP = 0x100,
  DT_CALCRECT = 0x400,
  DT_NOPREFIX = 0x800,
  DT_INTERNAL = 0x1000,
  DT_EDITCONTROL = 0x2000,
  DT_PATH_ELLIPSIS = 0x4000,
  DT_END_ELLIPSIS = 0x8000,
  DT_MODIFYSTRING = 0x10000,
  DT_RTLREADING = 0x20000,
  DT_WORD_ELLIPSIS = 0x40000,
  DT_NOFULLWIDTHCHARBREAK = 0x80000,
  DT_HIDEPREFIX = 0x100000,
  DT_PREFIXONLY = 0x200000;
const DT_MODELED =
  DT_CENTER |
  DT_RIGHT |
  DT_VCENTER |
  DT_BOTTOM |
  DT_WORDBREAK |
  DT_SINGLELINE |
  DT_EXPANDTABS |
  DT_NOCLIP |
  DT_CALCRECT |
  DT_NOPREFIX |
  DT_END_ELLIPSIS |
  DT_PATH_ELLIPSIS |
  DT_MODIFYSTRING |
  DT_RTLREADING |
  DT_WORD_ELLIPSIS |
  DT_NOFULLWIDTHCHARBREAK |
  DT_HIDEPREFIX |
  DT_PREFIXONLY |
  DT_INTERNAL |
  DT_EDITCONTROL;

function drawText(runtime, argument, wide, extended) {
  const argc = extended ? 6 : 5;
  const dcHandle = argument(0),
    textPointer = argument(1),
    count = signed(argument(2)),
    rectPointer = argument(3),
    flags = argument(4) >>> 0;
  if (!dcHandle || !textPointer || !rectPointer || flags & ~DT_MODELED)
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, argc);
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, dcHandle);
  if (!dc) return failure(runtime, ERROR_INVALID_HANDLE, 0, argc);
  runtime.check(rectPointer, 16, true);
  const rect = {
    left: signed(runtime.read32(rectPointer)),
    top: signed(runtime.read32(rectPointer + 4)),
    right: signed(runtime.read32(rectPointer + 8)),
    bottom: signed(runtime.read32(rectPointer + 12)),
  };
  let text;
  try {
    if (count < 0) text = wide ? runtime.wideString(textPointer) : runtime.string(textPointer);
    else {
      text = '';
      for (let i = 0; i < count; i++) {
        const code = wide
          ? runtime.guestMemory.read(textPointer + i * 2, 2)
          : runtime.guestMemory.read(textPointer + i, 1);
        if (!code) break;
        text += String.fromCharCode(code);
      }
    }
  } catch {
    return failure(runtime, ERROR_INVALID_PARAMETER, 0, argc);
  }
  if (!(flags & DT_NOPREFIX)) text = text.replace(/&/g, '');
  if (flags & DT_EXPANDTABS) text = text.replace(/\t/g, '        ');
  const font = dc.font ? getFont(state, dc.font) : null;
  if (dc.font && !font) return failure(runtime, ERROR_INVALID_HANDLE, 0, argc);
  const descriptor = font ?? DEFAULT_GDI_FONT;
  let measureError;
  const measureWidth = (value) => {
    const measured = rasterizeGdiText(runtime, value, descriptor);
    if (measured.error) measureError = measured.error;
    return measured.mask?.width ?? 0;
  };
  const width = Math.max(0, rect.right - rect.left),
    height = Math.max(0, rect.bottom - rect.top);
  const lineHeight = descriptor.height + (descriptor.externalLeading ?? 0);
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  const wrapped = [];
  if (flags & DT_SINGLELINE) wrapped.push(lines.join(' '));
  else
    for (const line of lines) {
      if (!(flags & DT_WORDBREAK) || !width || !line.trim()) {
        wrapped.push(line);
        continue;
      }
      let current = '';
      for (const word of line.split(/(\s+)/)) {
        const candidate = current + word;
        if (current && measureWidth(candidate) > width) {
          wrapped.push(current.replace(/\s+$/, ''));
          current = word.replace(/^\s+/, '');
        } else current = candidate;
      }
      wrapped.push(current.replace(/\s+$/, ''));
    }
  if (flags & DT_CALCRECT) {
    let maxWidth = 0;
    for (const line of wrapped) maxWidth = Math.max(maxWidth, measureWidth(line));
    if (measureError)
      return failure(
        runtime,
        measureError === 'backend' ? ERROR_CALL_NOT_IMPLEMENTED : ERROR_INVALID_PARAMETER,
        0,
        argc,
      );
    runtime.write32(rectPointer + 8, rect.left + maxWidth);
    runtime.write32(rectPointer + 12, rect.top + wrapped.length * lineHeight);
    return success(wrapped.length * lineHeight, argc);
  }
  let y = rect.top;
  if (flags & DT_VCENTER && flags & DT_SINGLELINE)
    y = rect.top + Math.max(0, (height - lineHeight) >> 1);
  else if (flags & DT_BOTTOM && flags & DT_SINGLELINE)
    y = rect.top + Math.max(0, height - lineHeight);
  let textDc = dc;
  if (!(flags & 0x100)) {
    textDc = { ...dc };
    setClipPieces(
      textDc,
      intersectClip(clipPieces(dc, dc.surface), [rect.left, rect.top, rect.right, rect.bottom]),
    );
  }
  let painted = 0;
  for (const line of wrapped) {
    const lineWidth = measureWidth(line);
    let x = rect.left;
    if (flags & DT_CENTER) x = rect.left + Math.max(0, (width - lineWidth) >> 1);
    else if (flags & DT_RIGHT) x = rect.left + Math.max(0, width - lineWidth);
    const result = rasterizeGdiText(runtime, line, descriptor);
    if (result.error === 'backend') return failure(runtime, ERROR_CALL_NOT_IMPLEMENTED, 0, argc);
    if (result.error) return failure(runtime, ERROR_INVALID_PARAMETER, 0, argc);
    paintGdiText(dc.surface, textDc, x, y, result.mask, descriptor);
    y += lineHeight;
    painted++;
  }
  // DrawText returns the height of the drawn text; DT_CALCRECT already returned.
  return success(painted * lineHeight, argc);
}

/** Copy bitmap pixels before a common control releases its source object. */
export function describeGdiBitmap(runtime, handle) {
  const bitmap = states.get(runtime)?.bitmaps.get(handle >>> 0);
  if (bitmap) refreshDibPixels(runtime, bitmap);
  return bitmap
    ? { width: bitmap.width, height: bitmap.height, pixels: new Uint8ClampedArray(bitmap.pixels) }
    : null;
}
/** Clone a control's background brush without taking native ownership. */
export function describeGdiBrush(runtime, handle) {
  const brush = states.get(runtime)?.brushes.get(handle >>> 0);
  return brush
    ? {
        ...brush,
        ...(brush.pattern
          ? { pattern: { ...brush.pattern, pixels: new Uint8ClampedArray(brush.pattern.pixels) } }
          : {}),
      }
    : null;
}
/** A read-only, cloned descriptor for DOM control font propagation. */
export function describeGdiFont(runtime, handle) {
  if (handle >>> 0 === 0) return { ...DEFAULT_GDI_FONT };
  const font = states.get(runtime)?.fonts.get(handle >>> 0);
  return font ? { ...font } : null;
}

/** Control layout uses the same selected-font metrics as GetTextMetrics. */
export function measureGdiFont(runtime, handle = 0) {
  const state = stateFor(runtime);
  if (handle && !getFont(state, handle)) return null;
  return fontMetrics(runtime, state, { font: handle || STOCK_SYSTEM_FONT });
}

// Printing calls may validate/store an abort procedure on existing display or
// memory DCs. This accessor never creates GDI state for an invalid handle.
export function activeGdiDC(runtime, handle) {
  const state = states.get(runtime);
  return state ? getDc(runtime, state, handle) : null;
}

/** WGL needs the live window owning a display DC, never a memory bitmap DC. */
export function describeDisplayDC(runtime, handle) {
  const state = states.get(runtime);
  const dc = state && getDc(runtime, state, handle);
  if (!dc || dc.kind !== 'display-dc' || !dc.hwnd) return null;
  const window = runtime.windows?.windows?.get(dc.hwnd);
  return window ? { windowId: dc.hwnd, width: window.width, height: window.height } : null;
}

// Ellipse(hdc, left, top, right, bottom): the bounding box is exclusive of the
// right/bottom edge, and the outline is drawn with the selected pen.
function ellipse(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 5);
  const left = signed(argument(1)),
    top = signed(argument(2));
  const right = signed(argument(3)),
    bottom = signed(argument(4));
  if (right < left || bottom < top) return success(1, 5);
  const rx = (right - left) / 2,
    ry = (bottom - top) / 2;
  const cx = (left + right) / 2,
    cy = (top + bottom) / 2;
  // Sample the perimeter finely enough that neighbouring samples are adjacent.
  const steps = Math.max(24, Math.min(2048, Math.ceil((rx + ry) * 4) + 8));
  const points = Array.from({ length: steps }, (_, i) => {
    const angle = (i / steps) * Math.PI * 2;
    return [Math.round(cx + rx * Math.cos(angle)), Math.round(cy + ry * Math.sin(angle))];
  });
  fillPolygon(dc, points, shapeBrush(runtime, state, dc));
  strokePolygon(dc, [...points, points[0]], shapePen(runtime, state, dc), false);
  return success(1, 5);
}
// Polygon(hdc, points, count): an implicitly closed shape filled with the
// current brush and stroked with the current pen.
function polygon(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 3);
  const points = readPoints(runtime, argument(1), argument(2) >>> 0);
  if (!points) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 3);
  if (points.length >= 3) {
    fillPolygon(dc, points, shapeBrush(runtime, state, dc));
    strokePolygon(dc, [...points, points[0]], shapePen(runtime, state, dc), false);
  }
  return success(1, 3);
}
// Arc(hdc, left, top, right, bottom, xr1, yr1, xr2, yr2): the ellipse arc
// between the two radial endpoints, stroked only (GDI never fills an arc).
function arc(runtime, argument) {
  const state = stateFor(runtime);
  const dc = getDc(runtime, state, argument(0));
  if (!dc) return badDc(runtime, 9);
  const pen = shapePen(runtime, state, dc);
  const left = signed(argument(1)),
    top = signed(argument(2));
  const right = signed(argument(3)),
    bottom = signed(argument(4));
  const rx = (right - left) / 2,
    ry = (bottom - top) / 2;
  const cx = (left + right) / 2,
    cy = (top + bottom) / 2;
  if (rx <= 0 || ry <= 0 || !pen || pen.style === 5) return success(1, 9);
  const angleOf = (x, y) => Math.atan2(signed(y) - cy, signed(x) - cx);
  const start = angleOf(argument(5), argument(6));
  const end = angleOf(argument(7), argument(8));
  let sweep = end - start;
  // GDI arcs run counter-clockwise from the start ray to the end ray.
  while (sweep <= 0) sweep += Math.PI * 2;
  const steps = Math.max(8, Math.min(2048, Math.ceil(((rx + ry) * sweep) / 4) + 4));
  const points = Array.from({ length: steps + 1 }, (_, i) => {
    const angle = start + (sweep * i) / steps;
    return [Math.round(cx + rx * Math.cos(angle)), Math.round(cy + ry * Math.sin(angle))];
  });
  strokePolygon(dc, points, pen, false);
  return success(1, 9);
}

export const gdiApis = {
  'gdi32.dll!CreateBrushIndirect': createBrushIndirect,
  'gdi32.dll!CreatePatternBrush': createPatternBrush,
  'gdi32.dll!SetBrushOrgEx': (r, a) => brushOrigin(r, a, true),
  'gdi32.dll!GetBrushOrgEx': (r, a) => brushOrigin(r, a, false),
  ...createRegionApis({ stateFor, getDc, getBrush, readRect, allocateHandle, success, failure }),
  'gdi32.dll!GetObjectType': (r, a) => {
    const state = stateFor(r),
      handle = a(0) >>> 0,
      dc = state.dcs.get(handle);
    if (dc?.active) return success(dc.kind === 'memory-dc' ? 10 : 3, 1);
    for (const [table, kind] of [
      [state.pens, 1],
      [state.brushes, 2],
      [state.palettes, 5],
      [state.fonts, 6],
      [state.bitmaps, 7],
      [state.regions, 8],
    ])
      if (table.has(handle)) return success(kind, 1);
    return failure(r, ERROR_INVALID_HANDLE, 0, 1);
  },
  'user32.dll!DrawIconEx': drawIconEx,
  'user32.dll!GetDesktopWindow': getDesktopWindow,
  'user32.dll!GetDC': getDC,
  'user32.dll!ReleaseDC': releaseDC,
  'user32.dll!FillRect': fillRect,
  'user32.dll!FrameRect': frameRect,
  'user32.dll!DrawFocusRect': drawFocusRect,
  'user32.dll!GetSysColor': getSysColor,
  'user32.dll!GetSysColorBrush': getSysColorBrush,
  'gdi32.dll!CreateSolidBrush': createSolidBrush,
  'gdi32.dll!CreateHatchBrush': createHatchBrush,
  'gdi32.dll!CreatePen': createPen,
  'gdi32.dll!CreateFont': (runtime, argument) => createFont(runtime, argument, false),
  'gdi32.dll!CreateFontA': (runtime, argument) => createFont(runtime, argument, false),
  'gdi32.dll!CreateFontIndirectA': (runtime, argument) =>
    createFontIndirect(runtime, argument, false),
  'gdi32.dll!CreateFontIndirectW': (runtime, argument) =>
    createFontIndirect(runtime, argument, true),
  'gdi32.dll!CreateBitmap': createBitmap,
  'gdi32.dll!CreatePalette': createPalette,
  'gdi32.dll!GetOutlineTextMetricsA': (runtime, argument) =>
    getOutlineTextMetrics(runtime, argument, false),
  'gdi32.dll!GetOutlineTextMetricsW': (runtime, argument) =>
    getOutlineTextMetrics(runtime, argument, true),
  'gdi32.dll!GetCharacterPlacementW': getCharacterPlacement,
  'gdi32.dll!GetCharacterPlacementA': getCharacterPlacement,
  'gdi32.dll!SelectPalette': selectPalette,
  'gdi32.dll!RealizePalette': realizePalette,
  'gdi32.dll!UpdateColors': updateColors,
  'gdi32.dll!SetPaletteEntries': setPaletteEntries,
  'gdi32.dll!GetPaletteEntries': getPaletteEntries,
  'gdi32.dll!UnrealizeObject': unrealizeObject,
  'gdi32.dll!TranslateCharsetInfo': translateCharsetInfo,
  'gdi32.dll!ExtTextOutA': (runtime, argument) => extTextOut(runtime, argument, false),
  'gdi32.dll!ExtTextOutW': (runtime, argument) => extTextOut(runtime, argument, true),
  'gdi32.dll!GetCharWidth32A': (runtime, argument) => charWidths(runtime, argument, false, false),
  'gdi32.dll!GetCharWidth32W': (runtime, argument) => charWidths(runtime, argument, true, false),
  'gdi32.dll!GetCharWidthA': (runtime, argument) => charWidths(runtime, argument, false, false),
  'gdi32.dll!GetCharWidthW': (runtime, argument) => charWidths(runtime, argument, true, false),
  'gdi32.dll!GetCharABCWidthsFloatA': (runtime, argument) =>
    charWidths(runtime, argument, false, true, true),
  'gdi32.dll!GetCharABCWidthsFloatW': (runtime, argument) =>
    charWidths(runtime, argument, true, true, true),
  'gdi32.dll!GetCharABCWidthsA': (runtime, argument) =>
    charWidths(runtime, argument, false, false, true),
  'gdi32.dll!GetCharABCWidthsW': (runtime, argument) =>
    charWidths(runtime, argument, true, false, true),
  'gdi32.dll!GetCharWidthFloatA': (runtime, argument) => charWidths(runtime, argument, false, true),
  'gdi32.dll!GetCharWidthFloatW': (runtime, argument) => charWidths(runtime, argument, true, true),
  'gdi32.dll!GetDIBits': getDIBits,
  'gdi32.dll!SetDIBits': setDIBits,
  'gdi32.dll!CreateDIBSection': createDIBSection,
  'gdi32.dll!GetDIBColorTable': (r, a) => dibColorTable(r, a, false),
  'gdi32.dll!SetDIBColorTable': (r, a) => dibColorTable(r, a, true),
  'gdi32.dll!GdiFlush': () => success(1, 0),
  'gdi32.dll!CreateDIBitmap': createDIBitmap,
  'gdi32.dll!EnumFontFamiliesExA': (r, a) => enumFontFamilies(r, a, false),
  'gdi32.dll!EnumFontFamiliesExW': (r, a) => enumFontFamilies(r, a, true),
  'gdi32.dll!CreateFontW': (runtime, argument) => createFont(runtime, argument, true),
  'user32.dll!DrawTextA': (runtime, argument) => drawText(runtime, argument, false, false),
  'user32.dll!DrawTextW': (runtime, argument) => drawText(runtime, argument, true, false),
  'user32.dll!DrawTextExA': (runtime, argument) => drawText(runtime, argument, false, true),
  'user32.dll!DrawTextExW': (runtime, argument) => drawText(runtime, argument, true, true),
  'gdi32.dll!TextOut': (runtime, argument) => textOut(runtime, argument, false),
  'gdi32.dll!TextOutA': (runtime, argument) => textOut(runtime, argument, false),
  'gdi32.dll!TextOutW': (runtime, argument) => textOut(runtime, argument, true),
  'gdi32.dll!GetTextExtentPoint32A': (runtime, argument) =>
    getTextExtentPoint32(runtime, argument, false),
  'gdi32.dll!GetTextExtentPoint32W': (runtime, argument) =>
    getTextExtentPoint32(runtime, argument, true),
  'gdi32.dll!GetTextExtentPointA': (runtime, argument) =>
    getTextExtentPoint32(runtime, argument, false),
  'gdi32.dll!GetTextExtentPointW': (runtime, argument) =>
    getTextExtentPoint32(runtime, argument, true),
  'gdi32.dll!GetTextExtentExPointA': (runtime, argument) =>
    getTextExtentExPoint(runtime, argument, false),
  'gdi32.dll!GetTextExtentExPointW': (runtime, argument) =>
    getTextExtentExPoint(runtime, argument, true),
  // Text layout direction: (Get/Set)Layout share one DC flag. RIGHT_TO_LEFT
  // reverses the mirroring the desktop applies to a run of text.
  'gdi32.dll!GetLayout': (runtime, argument) => {
    const state = stateFor(runtime);
    const dc = getDc(runtime, state, argument(0));
    if (!dc) return badDc(runtime, 1);
    return success(dc.layout ?? 0, 1);
  },
  'gdi32.dll!SetLayout': (runtime, argument) => {
    const state = stateFor(runtime);
    const dc = getDc(runtime, state, argument(0));
    if (!dc) return badDc(runtime, 2);
    const value = argument(1) >>> 0;
    if (value & ~1) return failure(runtime, ERROR_INVALID_PARAMETER, 0, 2);
    const previous = dc.layout ?? 0;
    dc.layout = value;
    return success(previous, 2);
  },
  'gdi32.dll!GetBkMode': getBkMode,
  'gdi32.dll!GetMapMode': getMapMode,
  'gdi32.dll!SetMapMode': setMapMode,
  'gdi32.dll!GetTextMetricsA': (runtime, argument) => getTextMetrics(runtime, argument, false),
  'gdi32.dll!GetTextMetricsW': (runtime, argument) => getTextMetrics(runtime, argument, true),
  'gdi32.dll!GetDeviceCaps': getDeviceCaps,
  'gdi32.dll!GetCurrentObject': getCurrentObject,
  'gdi32.dll!GetObjectA': (runtime, argument) => getObject(runtime, argument, false),
  'gdi32.dll!GetObjectW': (runtime, argument) => getObject(runtime, argument, true),
  'gdi32.dll!SetTextAlign': setTextAlign,
  'gdi32.dll!GetTextAlign': getTextAlign,
  'gdi32.dll!SetTextCharacterExtra': setTextCharacterExtra,
  'gdi32.dll!GetTextCharacterExtra': getTextCharacterExtra,
  'gdi32.dll!Rectangle': rectangleShape,
  'gdi32.dll!Polyline': polyline,
  'gdi32.dll!GetClipBox': getClipRect,
  'gdi32.dll!IntersectClipRect': intersectClipRect,
  'gdi32.dll!ExcludeClipRect': excludeClipRect,
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
  'gdi32.dll!SaveDC': saveDC,
  'gdi32.dll!GetCurrentPositionEx': (r, a) => {
    const dc = getDc(r, stateFor(r), a(0));
    if (!dc) return badDc(r, 2);
    r.check(a(1), 8, true);
    r.write32(a(1), dc.currentPoint.x);
    r.write32(a(1) + 4, dc.currentPoint.y);
    return success(1, 2);
  },
  'gdi32.dll!GetTextColor': (r, a) => getDcAttribute(r, a, 'textColor'),
  'gdi32.dll!GetBkColor': (r, a) => getDcAttribute(r, a, 'backgroundColor'),
  'gdi32.dll!GetBkMode': (r, a) => getDcAttribute(r, a, 'bkMode'),
  'gdi32.dll!RestoreDC': restoreDC,
  'gdi32.dll!PatBlt': patBlt,
  'gdi32.dll!BitBlt': bitBlt,
  'gdi32.dll!StretchBlt': stretchBlt,
  'gdi32.dll!Ellipse': ellipse,
  'gdi32.dll!Polygon': polygon,
  'gdi32.dll!Arc': arc,
  'gdi32.dll!SetPixel': setPixel,
  'gdi32.dll!GetPixel': getPixel,
};

// GDI raster calls are synchronous; finish shared-storage writes at each API
// boundary, including callbacks nested inside asynchronous font enumeration.
for (const [name, handler] of Object.entries(gdiApis)) {
  gdiApis[name] = (r, a) => {
    const finish = (response) => {
      const state = states.get(r);
      if (state) for (const bitmap of state.dibBitmaps) commitDibPixels(r, bitmap);
      if (name === 'gdi32.dll!SetPixel' && response.result !== CLR_INVALID) {
        const dc = state && getDc(r, state, a(0));
        if (dc?.surface.dib) response.result = getPixel(r, (i) => a(i)).result;
      }
      return response;
    };
    const result = handler(r, a);
    return result?.then ? result.then(finish) : finish(result);
  };
}

/** Emit copied RGBA frames for the desktop and dirty guest client areas. */
export function flushGdi(runtime) {
  const state = states.get(runtime);
  if (!state) return null;
  if (state.desktopActive) syncDesktopSurface(runtime, state);
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
    if (!surface.width || !surface.height) {
      surface.dirty = false;
      continue;
    }
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
