import { compareWindowOrder, outerWindowSize } from './window-frame.js';
import { DESKTOP_WINDOW } from './win32-gdi.js';
import { currentDisplayMode } from './win32-display.js';
const result = (value, argc) => ({ result: value >>> 0, argc });

function childFromPoint(r, a, extended) {
  const manager = r.windows,
    parent = a(0) >>> 0,
    argc = extended ? 4 : 3;
  const flags = extended ? a(3) >>> 0 : 0;
  if (flags & ~7) return manager.fail(87, argc);
  const desktop = parent === DESKTOP_WINDOW,
    window = manager.windows.get(parent);
  if (!desktop && !window) return manager.fail(1400, argc);
  const bounds = desktop ? currentDisplayMode(r) : window;
  const x = a(1) | 0,
    y = a(2) | 0;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return result(0, argc);
  // This API examines immediate children, including their nonclient border;
  // it does not recurse or send WM_NCHITTEST. POINT is passed by value.
  const children = [...manager.windows.values()]
    .filter((w) => (w.parentId ?? 0) === (desktop ? 0 : parent))
    .sort(compareWindowOrder);
  for (const child of children) {
    if (
      (flags & 1 && !child.visible) ||
      (flags & 2 && child.enabled === false) ||
      (flags & 4 && child.exStyle & 0x20)
    )
      continue;
    const [width, height] = outerWindowSize(child);
    if (x >= child.x && y >= child.y && x < child.x + width && y < child.y + height)
      return result(child.id, argc);
  }
  return result(parent, argc);
}
function topWindow(r, a) {
  const parent = a(0) >>> 0;
  if (parent && parent !== DESKTOP_WINDOW && !r.windows.windows.has(parent))
    return r.windows.fail(1400, 1);
  const candidates = [...r.windows.windows.values()]
    .filter((w) => (w.parentId ?? 0) === (parent === DESKTOP_WINDOW ? 0 : parent))
    .sort(compareWindowOrder);
  return result(candidates[0]?.id ?? 0, 1);
}
function isChild(r, a) {
  const parent = a(0) >>> 0,
    child = a(1) >>> 0;
  if (!r.windows.windows.has(parent) || parent === child) return result(0, 2);
  let window = r.windows.windows.get(child);
  const seen = new Set();
  while (window?.parentId && !seen.has(window.id)) {
    seen.add(window.id);
    if (window.parentId === parent) return result(1, 2);
    window = r.windows.windows.get(window.parentId);
  }
  return result(0, 2);
}
function readRect(r, pointer) {
  if (!pointer) return null;
  r.check(pointer, 16);
  return [0, 4, 8, 12].map((offset) => r.read32(pointer + offset) | 0);
}
const empty = (rect) => !rect || rect[0] >= rect[2] || rect[1] >= rect[3];
function writeRect(r, pointer, rect) {
  r.check(pointer, 16, true);
  rect.forEach((v, i) => r.write32(pointer + i * 4, v));
}
function rectOperation(r, a, operation) {
  const out = a(0),
    first = readRect(r, a(1));
  const argc = operation === 'copy' ? 2 : 3;
  const second = operation === 'copy' ? null : readRect(r, a(2));
  if (!out || !first || (operation !== 'copy' && !second)) return result(0, argc);
  let rect = [...first];
  if (operation === 'copy') {
    writeRect(r, out, rect);
    return result(1, argc);
  }
  if (operation === 'intersect') {
    rect = [
      Math.max(first[0], second[0]),
      Math.max(first[1], second[1]),
      Math.min(first[2], second[2]),
      Math.min(first[3], second[3]),
    ];
    if (empty(rect)) rect = [0, 0, 0, 0];
  } else if (operation === 'union') {
    rect = empty(first)
      ? empty(second)
        ? [0, 0, 0, 0]
        : [...second]
      : empty(second)
        ? [...first]
        : [
            Math.min(first[0], second[0]),
            Math.min(first[1], second[1]),
            Math.max(first[2], second[2]),
            Math.max(first[3], second[3]),
          ];
  } else if (operation === 'subtract') {
    if (empty(first)) rect = [0, 0, 0, 0];
    else {
      const intersection = [
        Math.max(first[0], second[0]),
        Math.max(first[1], second[1]),
        Math.min(first[2], second[2]),
        Math.min(first[3], second[3]),
      ];
      if (!empty(intersection)) {
        const fullWidth = intersection[0] === first[0] && intersection[2] === first[2];
        const fullHeight = intersection[1] === first[1] && intersection[3] === first[3];
        if (fullWidth && fullHeight) rect = [0, 0, 0, 0];
        else if (fullWidth) {
          if (intersection[1] === first[1]) rect[1] = intersection[3];
          else if (intersection[3] === first[3]) rect[3] = intersection[1];
        } else if (fullHeight) {
          if (intersection[0] === first[0]) rect[0] = intersection[2];
          else if (intersection[2] === first[2]) rect[2] = intersection[0];
        }
      }
    }
  }
  writeRect(r, out, rect);
  return result(!empty(rect), argc);
}
export const windowQueryApis = {
  'user32.dll!ChildWindowFromPoint': (r, a) => childFromPoint(r, a, false),
  'user32.dll!ChildWindowFromPointEx': (r, a) => childFromPoint(r, a, true),
  'user32.dll!GetTopWindow': topWindow,
  'user32.dll!IsChild': isChild,
  'user32.dll!CopyRect': (r, a) => rectOperation(r, a, 'copy'),
  'user32.dll!IntersectRect': (r, a) => rectOperation(r, a, 'intersect'),
  'user32.dll!UnionRect': (r, a) => rectOperation(r, a, 'union'),
  'user32.dll!SubtractRect': (r, a) => rectOperation(r, a, 'subtract'),
  'user32.dll!IsRectEmpty': (r, a) => result(empty(readRect(r, a(0))), 1),
  'user32.dll!SetRectEmpty': (r, a) => {
    if (!a(0)) return result(0, 1);
    writeRect(r, a(0), [0, 0, 0, 0]);
    return result(1, 1);
  },
};
