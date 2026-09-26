import { frameForWindow, compareWindowOrder } from './window-frame.js';
import { resizeWindowSurface } from './win32-gdi.js';

const S = {
  NOSIZE: 1,
  NOMOVE: 2,
  NOZORDER: 4,
  NOREDRAW: 8,
  NOACTIVATE: 16,
  FRAMECHANGED: 32,
  SHOW: 64,
  HIDE: 128,
  NOCOPYBITS: 256,
  NOSENDCHANGING: 1024,
  NOCLIENTSIZE: 2048,
  NOCLIENTMOVE: 4096,
};
const PUBLIC_FLAGS = 0x67ff;
const result = (value) => ({ result: value, argc: 7 });

function validAfter(m, w, after, flags) {
  if (flags & S.NOZORDER || [0, 1, 0xffffffff, 0xfffffffe].includes(after)) return true;
  return m.windows.get(after)?.parentId === w.parentId;
}

function place(m, w, after) {
  if (after === w.id || (after === 0xfffffffe && !w.topmost)) return false;
  const siblings = [...m.windows.values()]
    .filter((s) => s !== w && s.parentId === w.parentId)
    .sort(compareWindowOrder);
  const before = [...m.windows.values()]
    .filter((s) => s.parentId === w.parentId)
    .sort(compareWindowOrder)
    .map((s) => s.id);
  const wasTopmost = !!w.topmost;
  if (after === 1 || after === 0xfffffffe) w.topmost = false;
  if (after === 0xffffffff && !w.parentId) w.topmost = true;
  let index;
  if (after === 1) index = siblings.length;
  else if ([0, 0xffffffff, 0xfffffffe].includes(after)) {
    index = w.topmost ? 0 : siblings.findIndex((s) => !s.topmost);
    if (index < 0) index = siblings.length;
  } else {
    index = siblings.findIndex((s) => s.id === after) + 1;
    if (!siblings[index - 1].topmost) w.topmost = false;
    else if (siblings[index]?.topmost && !w.parentId) w.topmost = true;
  }
  w.exStyle = ((w.exStyle & ~8) | (w.topmost ? 8 : 0)) >>> 0;
  siblings.splice(index, 0, w);
  const changed = wasTopmost !== !!w.topmost || siblings.some((s, i) => s.id !== before[i]);
  if (changed)
    for (const sibling of siblings.toReversed()) {
      sibling.zOrder = m.nextZOrder++;
      if (sibling.presented)
        m.runtime.emit({
          type: 'window-stack',
          windowId: sibling.id,
          zOrder: sibling.zOrder,
          topmost: sibling.topmost,
        });
    }
  return changed;
}

export async function setWindowPos(r, a) {
  const m = r.windows,
    hwnd = a(0) >>> 0,
    w = m.windows.get(hwnd);
  if (!w) return m.fail(1400, 7);
  let after = a(1) >>> 0,
    flags = a(6) >>> 0;
  if (flags & ~PUBLIC_FLAGS) return m.fail(87, 7);
  if (!validAfter(m, w, after, flags)) return m.fail(1400, 7);
  const p = r.allocate(80),
    nc = p + 28;
  const writePos = (x, y, cx, cy) =>
    [hwnd, after, x, y, cx, cy, flags].forEach((v, i) => r.write32(p + i * 4, v));
  try {
    const initialFrame = frameForWindow(w);
    writePos(
      flags & S.NOMOVE ? w.x : a(2) | 0,
      flags & S.NOMOVE ? w.y : a(3) | 0,
      flags & S.NOSIZE ? w.width + 2 * initialFrame.border : a(4) | 0,
      flags & S.NOSIZE ? w.height + 2 * initialFrame.border + initialFrame.title : a(5) | 0,
    );
    if (!(flags & S.NOSENDCHANGING)) await m.send(hwnd, 0x46, 0, p);
    if (!m.windows.has(hwnd)) return m.fail(1400, 7);
    after = r.read32(p + 4);
    flags = r.read32(p + 24);
    if (flags & ~PUBLIC_FLAGS) return m.fail(87, 7);
    if (!validAfter(m, w, after, flags)) return m.fail(1400, 7);
    const frame = frameForWindow(w),
      oldX = w.x,
      oldY = w.y,
      oldWidth = w.width,
      oldHeight = w.height;
    const oldOuterWidth = oldWidth + 2 * frame.border,
      oldOuterHeight = oldHeight + 2 * frame.border + frame.title;
    const x = flags & S.NOMOVE ? oldX : r.read32(p + 8) | 0,
      y = flags & S.NOMOVE ? oldY : r.read32(p + 12) | 0;
    const cx = flags & S.NOSIZE ? oldOuterWidth : r.read32(p + 16) | 0,
      cy = flags & S.NOSIZE ? oldOuterHeight : r.read32(p + 20) | 0;
    const width = cx - 2 * frame.border,
      height = cy - 2 * frame.border - frame.title;
    if (
      width < 1 ||
      height < 1 ||
      width > 1024 ||
      height > 768 ||
      Math.abs(x) > 32767 ||
      Math.abs(y) > 32767
    )
      return m.fail(87, 7);
    const moved = x !== oldX || y !== oldY,
      sized = width !== oldWidth || height !== oldHeight;
    if (!moved) flags |= S.NOMOVE;
    if (!sized) flags |= S.NOSIZE;
    if (after === 1 && !(flags & S.NOZORDER)) flags |= S.NOACTIVATE;
    writePos(x, y, cx, cy);
    let discardContents = !!(flags & S.NOCOPYBITS);
    if (sized || flags & S.FRAMECHANGED) {
      const values = [
        x,
        y,
        x + cx,
        y + cy,
        oldX,
        oldY,
        oldX + oldOuterWidth,
        oldY + oldOuterHeight,
        oldX + frame.border,
        oldY + frame.border + frame.title,
        oldX + oldOuterWidth - frame.border,
        oldY + oldOuterHeight - frame.border,
        p,
      ];
      values.forEach((value, i) => r.write32(nc + i * 4, value));
      const validRects = (await m.send(hwnd, 0x83, 1, nc)) >>> 0;
      if (validRects & ~0x300) throw Error('Custom nonclient valid rectangles are unsupported');
      discardContents ||= !!(
        (validRects & 0x100 && width !== oldWidth) ||
        (validRects & 0x200 && height !== oldHeight)
      );
      if (!m.windows.has(hwnd)) return m.fail(1400, 7);
      const actual = [0, 4, 8, 12].map((i) => r.read32(nc + i) | 0),
        expected = [
          x + frame.border,
          y + frame.border + frame.title,
          x + cx - frame.border,
          y + cy - frame.border,
        ];
      if (actual.some((v, i) => v !== expected[i]))
        throw Error('Custom nonclient window positioning is unsupported');
    }
    if (!validAfter(m, w, after, flags)) return m.fail(1400, 7);
    if (
      !w.controlType &&
      (sized || discardContents) &&
      !resizeWindowSurface(r, hwnd, width, height, !discardContents, !(flags & S.NOREDRAW))
    )
      return m.fail(8, 7);
    w.x = x;
    w.y = y;
    w.width = width;
    w.height = height;
    const wasVisible = w.visible;
    if (flags & S.SHOW) w.visible = true;
    if (flags & S.HIDE) w.visible = false;
    const reordered = !(flags & S.NOZORDER) && place(m, w, after);
    if (!reordered) flags |= S.NOZORDER;
    if (!w.visible) {
      if (m.active === hwnd) m.active = 0;
      if (m.focus && !m.isVisible(m.focus)) await m.setFocus(0, false);
    } else if (!(flags & S.NOACTIVATE) && !w.parentId && m.active !== hwnd) {
      await m.setFocus(hwnd, false);
    }
    if (!m.windows.has(hwnd)) return m.fail(1400, 7);
    if (
      !(flags & S.NOREDRAW) &&
      (sized || moved || flags & (S.FRAMECHANGED | S.SHOW | S.NOCOPYBITS))
    )
      m.invalidate(w, null, true);
    m.emit(w);
    if (!moved) flags |= S.NOCLIENTMOVE;
    if (!sized) flags |= S.NOCLIENTSIZE;
    writePos(w.x, w.y, w.width + 2 * frame.border, w.height + 2 * frame.border + frame.title);
    if (moved || sized || reordered || wasVisible !== w.visible || flags & S.FRAMECHANGED)
      await m.send(hwnd, 0x47, 0, p);
    return result(1);
  } finally {
    r.free(p);
  }
}
