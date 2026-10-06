import { currentDisplayMode } from './win32-display.js';
import { outerWindowSize } from './window-frame.js';
import { encodeAnsi } from './encoding.js';
import { activeGdiDC, DESKTOP_WINDOW } from './win32-gdi.js';

export const VIRTUAL_MONITOR = 0x10001;
export const VIRTUAL_MONITOR_DEVICE = '\\\\.\\DISPLAY1';
export function virtualWorkArea(r) {
  const { width, height } = currentDisplayMode(r);
  return [0, 0, width, height];
}
const result = (value, argc) => ({ result: value | 0, argc });
const fail = (r, error, argc) => {
  r.lastError = error;
  return result(0, argc);
};

// One process-local monitor shares the USER32/D3D display mode. An offscreen
// point/rectangle needs an explicit primary/nearest fallback to select it.
function monitorForRect(r, rectangle, flags) {
  let [left, top, right, bottom] = rectangle;
  if (right <= left || bottom <= top) {
    right = left + 1;
    bottom = top + 1;
  }
  const [, , width, height] = virtualWorkArea(r);
  return (left < width && right > 0 && top < height && bottom > 0) || flags & 3
    ? VIRTUAL_MONITOR
    : 0;
}

function getMonitorInfo(r, a, wide) {
  const out = a(1) >>> 0;
  if (!out) return fail(r, 87, 2);
  const size = r.read32(out),
    extendedSize = wide ? 104 : 72;
  if (size !== 40 && size !== extendedSize) return fail(r, 87, 2);
  if (a(0) >>> 0 !== VIRTUAL_MONITOR) return fail(r, 1461, 2);
  r.check(out, size, true);
  const area = virtualWorkArea(r);
  // Keep cbSize and every byte past the requested structure untouched.
  for (const offset of [4, 20]) area.forEach((v, i) => r.write32(out + offset + i * 4, v));
  r.write32(out + 36, 1); // MONITORINFOF_PRIMARY.
  if (size === extendedSize) {
    r.data.fill(0, out + 40, out + size);
    if (wide) {
      for (let i = 0; i < VIRTUAL_MONITOR_DEVICE.length; i++)
        r.view.setUint16(out + 40 + i * 2, VIRTUAL_MONITOR_DEVICE.charCodeAt(i), true);
    } else r.data.set(encodeAnsi(VIRTUAL_MONITOR_DEVICE).bytes, out + 40);
  }
  return result(1, 2);
}

function monitorFromWindow(r, a) {
  const w = r.windows.windows.get(a(0) >>> 0),
    flags = a(1) >>> 0;
  if (!w) return result(flags & 3 ? VIRTUAL_MONITOR : 0, 2);
  const minimized = [2, 6, 7, 11].includes(w.showCmd);
  let position;
  if (minimized && w.normalRectangle) {
    const [x, y, width, height] = w.normalRectangle;
    position = [x, y, x + width, y + height];
  } else {
    const [x, y] = r.windows.screenPosition(w),
      [width, height] = outerWindowSize(w);
    position = [x, y, x + width, y + height];
  }
  return result(monitorForRect(r, position, flags), 2);
}

function intersect(a, b) {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

async function enumDisplayMonitors(r, a) {
  const hdc = a(0) >>> 0,
    clip = a(1) >>> 0,
    callback = a(2) >>> 0,
    data = a(3) >>> 0;
  if (!callback) return fail(r, 87, 4);
  let area = virtualWorkArea(r);
  if (hdc) {
    const dc = activeGdiDC(r, hdc);
    if (!dc) return fail(r, 6, 4);
    // Existing DCs use MM_TEXT client coordinates. Wine enumerates against the
    // bounding clip box, even for a complex region, offset by the DC origin.
    let origin = [0, 0];
    if (dc.kind === 'display-dc' && dc.hwnd && dc.hwnd !== DESKTOP_WINDOW) {
      const w = r.windows.windows.get(dc.hwnd);
      if (!w) return fail(r, 6, 4);
      origin = r.windows.clientPosition(w);
    }
    area = area.map((v, i) => v - origin[i % 2]);
    area = intersect(area, dc.clip ?? [0, 0, dc.surface.width, dc.surface.height]);
  }
  if (clip) {
    r.check(clip, 16);
    area = intersect(
      area,
      [0, 4, 8, 12].map((offset) => r.read32(clip + offset) | 0),
    );
  }
  if (area[2] <= area[0] || area[3] <= area[1]) return result(1, 4);
  const pointer = r.allocate(16);
  try {
    area.forEach((v, i) => r.write32(pointer + i * 4, v));
    return result((await r.callGuest(callback, [VIRTUAL_MONITOR, hdc, pointer, data])) ? 1 : 0, 4);
  } finally {
    r.free(pointer);
  }
}

export const monitorApis = {
  'user32.dll!EnumDisplayMonitors': enumDisplayMonitors,
  'user32.dll!GetMonitorInfoA': (r, a) => getMonitorInfo(r, a, false),
  'user32.dll!GetMonitorInfoW': (r, a) => getMonitorInfo(r, a, true),
  'user32.dll!MonitorFromWindow': monitorFromWindow,
  'user32.dll!MonitorFromPoint': (r, a) => {
    const x = a(0) | 0,
      y = a(1) | 0;
    return result(monitorForRect(r, [x, y, x + 1, y + 1], a(2) >>> 0), 3);
  },
  'user32.dll!MonitorFromRect': (r, a) => {
    const p = a(0) >>> 0;
    if (!p) return fail(r, 87, 2);
    r.check(p, 16);
    return result(
      monitorForRect(
        r,
        [0, 4, 8, 12].map((o) => r.read32(p + o) | 0),
        a(1) >>> 0,
      ),
      2,
    );
  },
};
