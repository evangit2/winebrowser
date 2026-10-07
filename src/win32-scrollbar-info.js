// Original WineBrowser contributors, MIT. Native SCROLLBARINFO queries.
import { scrollbarGeometry } from './scrollbar-geometry.js';
import { frameForWindow } from './window-frame.js';
import { sendWindowMessage } from './win32-window-text.js';

export function writeScrollbarInfo(r, window, pointer, bar, state) {
  if (r.read32(pointer) !== 60) return 0;
  r.check(pointer, 60, true);
  let [x, y] = r.windows.screenPosition(window);
  let width = window.width,
    height = window.height;
  const vertical = bar === 1 || (bar === 2 && !!(window.style & 1));
  if (bar !== 2) {
    const frame = frameForWindow(window);
    x += frame.border;
    y += frame.border + frame.title;
    if (vertical) {
      x += window.exStyle & 0x4000 ? -17 : width;
      width = 17;
    } else {
      y += height;
      height = 17;
    }
  }
  // The native dxyLineButton field contains thumb size. Geometry queries use
  // the committed position even while a thumb track position is pending.
  const g = scrollbarGeometry(
    vertical ? height : width,
    { ...state, tracking: false },
    state.disabled ?? 0,
  );
  [x, y, x + width, y + height, g.thumb, g.top, g.bottom].forEach((v, i) =>
    r.write32(pointer + 4 + i * 4, v),
  );
  const invisible = bar !== 2 && !(window.style & (bar === 0 ? 0x100000 : 0x200000));
  const unavailable = state.min >= state.max - Math.max(0, state.page - 1);
  const flags = [
    (invisible ? 0x8000 : 0) |
      (unavailable ? (invisible ? 0x10000 : 1) : 0) |
      (bar === 2 && window.enabled === false ? 1 : 0),
    state.disabled & 1 ? 1 : 0,
    state.pos === state.min ? 0x8000 : 0,
    0,
    state.pos >= state.max - 1 ? 0x8000 : 0,
    state.disabled & 2 ? 1 : 0,
  ];
  // Wine's native control query reports pressed parts for horizontal controls.
  // Preserve its observed vertical-control behavior rather than inventing flags.
  const tracking = window.scrollTracking;
  if (bar === 2 && !vertical && tracking && r.windows.capture === window.id) {
    const index = new Map([
      [0, 1],
      [1, 5],
      [2, 2],
      [3, 4],
      [5, 3],
    ]).get(tracking.command);
    if (index !== undefined) flags[index] |= 8;
  }
  flags.forEach((v, i) => r.write32(pointer + 36 + i * 4, v));
  // cbSize and the reserved DWORD remain untouched.
  if (bar === 2) r.lastError = 0;
  return 1;
}

export const scrollbarInfoApis = {
  'user32.dll!GetScrollBarInfo': async (r, a) => {
    const hwnd = a(0),
      object = a(1) | 0,
      pointer = a(2);
    if (object === -4)
      return { result: (await sendWindowMessage(r, hwnd, 0xeb, 0, pointer, true)) >>> 0, argc: 3 };
    const window = r.windows.windows.get(hwnd);
    if (!window) return r.windows.fail(1400, 3);
    if (object !== -6 && object !== -5) return { result: 0, argc: 3 };
    if (r.read32(pointer) !== 60) return { result: 0, argc: 3 };
    const key = object === -6 ? 'horizontal' : 'vertical';
    window.scrollInfo ??= {
      horizontal: { min: 0, max: 100, page: 0, pos: 0 },
      vertical: { min: 0, max: 100, page: 0, pos: 0 },
    };
    return {
      result: writeScrollbarInfo(r, window, pointer, object === -6 ? 0 : 1, window.scrollInfo[key]),
      argc: 3,
    };
  },
};
