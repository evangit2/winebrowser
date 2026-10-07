// Original WineBrowser contributors, MIT. Native standalone scrollbar messages.
import { readScrollInfo, changeScrollInfo } from './win32-scroll-state.js';
import { scrollbarGeometry, nativeMulDiv } from './scrollbar-geometry.js';
export function controlScrollState(window) {
  return (window.scrollbar ??= { min: 0, max: 0, page: 0, pos: 0, disabled: 0 });
}
export function describeScrollbar(window) {
  if (window.controlType !== 'scrollbar') return;
  return {
    ...controlScrollState(window),
    vertical: !!(window.style & 1),
    pressed: window.scrollPressed ?? -1,
  };
}
async function notify(r, window, command, position = 0) {
  if (r.windows.windows.has(window.parentId))
    await r.windows.send(
      window.parentId,
      window.style & 1 ? 0x115 : 0x114,
      (((position & 0xffff) << 16) | command) >>> 0,
      window.id,
    );
}
function point(window, lp) {
  const x = (lp << 16) >> 16,
    y = lp >> 16;
  return {
    coordinate: window.style & 1 ? y : x,
    inside: x >= 0 && y >= 0 && x < window.width && y < window.height,
  };
}
function geometry(window, state) {
  return scrollbarGeometry(window.style & 1 ? window.height : window.width, state, state.disabled);
}
function part(g, coordinate) {
  if (coordinate < g.arrow) return 0;
  if (coordinate >= g.length - g.arrow) return 1;
  if (!g.thumb || coordinate < g.top) return 2;
  if (coordinate >= g.bottom) return 3;
  return 5;
}
function trackPosition(state, g, delta = 0) {
  const span = state.max - state.min - Math.max(0, state.page - 1),
    travel = g.space - g.thumb;
  return Math.max(
    state.min,
    Math.min(state.min + span, state.min + nativeMulDiv(g.top - g.arrow + delta, span, travel)),
  );
}
async function endTracking(r, window, notifyEnd) {
  const state = controlScrollState(window),
    tracking = window.scrollTracking;
  if (!tracking) return;
  window.scrollTracking = null;
  window.scrollPressed = -1;
  if (notifyEnd && tracking.command === 5) await notify(r, window, 4, state.track);
  if (notifyEnd) await notify(r, window, 8);
  state.tracking = false;
  delete state.track;
  if (r.windows.capture === window.id) await r.windows.changeCapture(0);
  if (r.windows.windows.has(window.id)) r.windows.emit(window);
}
export async function scrollbarMessage(r, window, message, wp, lp) {
  const state = controlScrollState(window);
  if (message === 0xe9) {
    const info = readScrollInfo(r, lp);
    if (!info || info.invalid) return 0;
    const pos = changeScrollInfo(state, info);
    r.windows.emit(window);
    return pos;
  }
  if (message === 0xea) {
    const info = readScrollInfo(r, lp);
    if (!info || info.invalid || !(info.mask & 0x17)) return 0;
    if (info.mask & 1) {
      r.write32(lp + 8, state.min);
      r.write32(lp + 12, state.max);
    }
    if (info.mask & 2) r.write32(lp + 16, state.page);
    if (info.mask & 4) r.write32(lp + 20, state.pos);
    if (info.mask & 16 && info.size === 28)
      r.write32(lp + 24, state.tracking ? state.track : state.pos);
    return 1;
  }
  if (message === 0xe1) return state.pos;
  if (message === 0xe0) {
    const old = state.pos;
    changeScrollInfo(state, { mask: 4, pos: wp | 0 });
    r.windows.emit(window);
    return old;
  }
  if (message === 0xe2 || message === 0xe6) {
    changeScrollInfo(state, { mask: 1, min: wp | 0, max: lp | 0 });
    r.windows.emit(window);
    return 0;
  }
  if (message === 0xe3) {
    r.write32(wp, state.min);
    r.write32(lp, state.max);
    return 0;
  }
  if (message === 0xe4) {
    state.disabled = wp & 3;
    r.windows.emit(window);
    return 1;
  }
  if (message === 0x87) return 1; // DLGC_WANTARROWS
  if (message === 0x100) {
    const command = new Map([
      [37, 0],
      [38, 0],
      [39, 1],
      [40, 1],
      [33, 2],
      [34, 3],
      [36, 6],
      [35, 7],
    ]).get(wp);
    if (command !== undefined) await notify(r, window, command);
    return command === undefined ? null : 0;
  }
  if (message === 0x201 || message === 0x203) {
    if (!r.windows.isEnabled(window.id)) return 0;
    const p = point(window, lp),
      g = geometry(window, state);
    if (!p.inside) return 0;
    const command = part(g, p.coordinate);
    if (command < 2 && state.disabled & (1 << command)) return 0;
    await r.windows.setFocus(window.id);
    if (!r.windows.windows.has(window.id)) return 0;
    await r.windows.changeCapture(window.id);
    window.scrollTracking = { command, start: p.coordinate, geometry: g };
    window.scrollPressed = command < 2 ? command : -1;
    if (command === 5) {
      state.tracking = true;
      state.track = trackPosition(state, g);
    }
    r.windows.emit(window);
    await notify(r, window, command, command === 5 ? state.track : 0);
    return 0;
  }
  if (message === 0x200 && window.scrollTracking) {
    const t = window.scrollTracking,
      p = point(window, lp);
    if (t.command === 5) {
      const next = trackPosition(state, t.geometry, p.coordinate - t.start);
      if (next !== state.track) {
        state.track = next;
        r.windows.emit(window);
        await notify(r, window, 5, next);
      }
    } else if (t.command < 2) {
      window.scrollPressed =
        p.inside && part(t.geometry, p.coordinate) === t.command ? t.command : -1;
      r.windows.emit(window);
    }
    return 0;
  }
  if (message === 0x202) {
    await endTracking(r, window, true);
    return 0;
  }
  if (message === 0x215 && lp === window.id) return 0;
  if (message === 0x1f || message === 0x215 || (message === 0xa && !wp) || message === 0x82) {
    await endTracking(r, window, false);
    return null;
  }
  if (message === 0xf) {
    window.invalid = null;
    window.erase = false;
    r.windows.emit(window);
    return 0;
  }
  return null;
}
