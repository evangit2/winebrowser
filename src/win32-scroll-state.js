import { sendWindowMessage } from './win32-window-text.js';

const result = (value, argc) => ({ result: value >>> 0, argc });
const ACCESS_VIOLATION = 0xc0000005;
const keyFor = (bar) => (bar === 0 ? 'horizontal' : bar === 1 ? 'vertical' : null);
const initial = () => ({ min: 0, max: 100, page: 0, pos: 0 });

function stateFor(window, key, create = false) {
  if (!window || !key) return null;
  if (!window.scrollInfo && (create || window.style & 0x300000))
    window.scrollInfo = { horizontal: initial(), vertical: initial() };
  return window.scrollInfo?.[key] ?? null;
}
function readInfo(r, pointer) {
  if (!pointer) return null;
  try {
    r.check(pointer, 8);
    const size = r.read32(pointer),
      mask = r.read32(pointer + 4);
    if ((size !== 24 && size !== 28) || mask & ~0x1f) return { invalid: true };
    r.check(pointer, size);
    return {
      size,
      mask,
      min: r.read32(pointer + 8) | 0,
      max: r.read32(pointer + 12) | 0,
      page: r.read32(pointer + 16),
      pos: r.read32(pointer + 20) | 0,
    };
  } catch {
    return null;
  }
}
function change(state, info) {
  if (info.mask & 1) {
    state.min = info.min;
    state.max = info.max;
  }
  if (state.min > state.max) state.min = state.max = 0;
  const count = state.max - state.min + 1;
  if (info.mask & 2) state.page = info.page;
  state.page = Math.min(state.page, count);
  if (info.mask & 4) state.pos = info.pos;
  state.pos = Math.max(state.min, Math.min(state.max - Math.max(0, state.page - 1), state.pos));
  return state.pos;
}
function redraw(r, window, enabled) {
  if (enabled && window) r.windows.emit(window);
}
async function setControl(r, hwnd, mask, fields, repaint) {
  const info = r.allocate(28);
  try {
    r.data.fill(0, info, info + 28);
    r.write32(info, 28);
    r.write32(info + 4, mask);
    for (const [offset, value] of fields) r.write32(info + offset, value);
    return await sendWindowMessage(r, hwnd, 0xe9, repaint >>> 0, info, true);
  } finally {
    r.free(info);
  }
}

export const scrollStateApis = {
  'user32.dll!SetScrollInfo': async (r, a) => {
    const window = r.windows.windows.get(a(0)),
      bar = a(1) >>> 0,
      pointer = a(2);
    if (bar === 2 && !window) return r.windows.fail(1400, 4);
    const info = readInfo(r, pointer);
    if (!info) return result(ACCESS_VIOLATION, 4);
    if (info.invalid) return result(0, 4);
    if (bar === 2) return result(await sendWindowMessage(r, a(0), 0xe9, a(3), pointer, true), 4);
    const state = stateFor(window, keyFor(bar), true);
    if (!state) return result(0, 4);
    const pos = change(state, info);
    redraw(r, window, a(3));
    return result(pos, 4);
  },
  'user32.dll!GetScrollInfo': async (r, a) => {
    const bar = a(1) >>> 0,
      pointer = a(2);
    if (bar === 2) {
      await sendWindowMessage(r, a(0), 0xea, 0, pointer, true);
      return result(1, 3);
    }
    const info = readInfo(r, pointer);
    if (!info) return result(ACCESS_VIOLATION, 3);
    if (info.invalid || !(info.mask & 0x17)) return result(0, 3);
    const state = stateFor(r.windows.windows.get(a(0)), keyFor(bar));
    if (!state) return result(0, 3);
    try {
      // Validate every requested output before writing any caller storage.
      for (const [mask, offset, count] of [
        [1, 8, 8],
        [2, 16, 4],
        [4, 20, 4],
        [16, 24, 4],
      ])
        if (info.mask & mask && (offset !== 24 || info.size === 28))
          r.check(pointer + offset, count, true);
    } catch {
      return result(ACCESS_VIOLATION, 3);
    }
    if (info.mask & 1) {
      r.write32(pointer + 8, state.min);
      r.write32(pointer + 12, state.max);
    }
    if (info.mask & 2) r.write32(pointer + 16, state.page);
    if (info.mask & 4) r.write32(pointer + 20, state.pos);
    if (info.mask & 16 && info.size === 28)
      r.write32(pointer + 24, state.tracking ? state.track : state.pos);
    return result(1, 3);
  },
  'user32.dll!GetScrollPos': async (r, a) => {
    if (a(1) >>> 0 === 2) return result(await sendWindowMessage(r, a(0), 0xe1, 0, 0, true), 2);
    return result(stateFor(r.windows.windows.get(a(0)), keyFor(a(1) >>> 0))?.pos ?? 0, 2);
  },
  'user32.dll!SetScrollPos': async (r, a) => {
    if (a(1) >>> 0 === 2) return result(await setControl(r, a(0), 4, [[20, a(2)]], a(3)), 4);
    const window = r.windows.windows.get(a(0)),
      state = stateFor(window, keyFor(a(1) >>> 0), true);
    if (!state) return result(0, 4);
    const previous = state.pos;
    change(state, { mask: 4, pos: a(2) | 0 });
    redraw(r, window, a(3));
    return result(previous, 4);
  },
  'user32.dll!GetScrollRange': async (r, a) => {
    if (a(1) >>> 0 === 2) {
      await sendWindowMessage(r, a(0), 0xe3, a(2), a(3), true);
      return result(1, 4);
    }
    try {
      if (!a(2) || !a(3)) return result(ACCESS_VIOLATION, 4);
      r.check(a(2), 4, true);
      r.check(a(3), 4, true);
    } catch {
      return result(ACCESS_VIOLATION, 4);
    }
    const state = stateFor(r.windows.windows.get(a(0)), keyFor(a(1) >>> 0));
    r.write32(a(2), state?.min ?? 0);
    r.write32(a(3), state?.max ?? 0);
    return result(1, 4);
  },
  'user32.dll!SetScrollRange': async (r, a) => {
    if (a(1) >>> 0 === 2) {
      await setControl(
        r,
        a(0),
        1,
        [
          [8, a(2)],
          [12, a(3)],
        ],
        a(4),
      );
      return result(1, 5);
    }
    const window = r.windows.windows.get(a(0)),
      state = stateFor(window, keyFor(a(1) >>> 0), true);
    if (state) {
      change(state, { mask: 1, min: a(2) | 0, max: a(3) | 0 });
      redraw(r, window, a(4));
    }
    return result(1, 5);
  },
};
