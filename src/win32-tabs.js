import { encodeAnsi } from './encoding.js';
import { stripCaptionMnemonics } from './caption-text.js';
import { measureDialogUnits } from './dialog-units.js';

// PE32 TCITEMA/W is 28 bytes. Native code owns the pages; this control owns
// tab items, selection, hit testing and WM_NOTIFY. Browser input stays queued.
const SELECT = 0x7fd0;
function tabs(w) {
  return (w.tabs ??= {
    items: [],
    selected: -1,
    focused: -1,
    next: 1,
    width: 96,
    height: 28,
    fixedHeight: false,
    padding: [10, 4],
    minimum: 48,
    unicode: !!w.cls.wide,
  });
}
function displayText(w, text) {
  return w.style & 0x2000 ? text : stripCaptionMnemonics(text);
}
let measurement;
function textWidth(w, text) {
  if (!w.font) return text.length * 7;
  if (!measurement && typeof globalThis.OffscreenCanvas === 'function')
    measurement = new OffscreenCanvas(1, 1).getContext('2d');
  if (measurement) {
    measurement.font = w.font.css;
    const width = measurement.measureText(text).width;
    if (Number.isFinite(width)) return Math.ceil(width);
  }
  return Math.ceil((text.length * w.font.height) / 2);
}
function tabHeight(w) {
  const t = tabs(w);
  if (t.fixedHeight || !w.font) return t.height;
  if (t.metricsFont !== w.font.css) {
    t.metricsFont = w.font.css;
    t.fontHeight = measureDialogUnits(w.font).y;
  }
  return Math.max(1, t.fontHeight + 2 * t.padding[1]);
}
function rects(w) {
  const t = tabs(w);
  let left = 2;
  return t.items.map((item) => {
    const width =
      w.style & 0x400
        ? t.width
        : Math.max(t.minimum, textWidth(w, displayText(w, item.text)) + 2 * t.padding[0]);
    const rect = [left, 2, left + width, 2 + tabHeight(w)];
    left += width;
    return rect;
  });
}
export function describeTabs(w) {
  if (w.controlType !== 'tabcontrol') return undefined;
  const t = tabs(w),
    bounds = rects(w);
  return {
    items: t.items.map((item, index) => ({
      id: item.id,
      text: item.text,
      displayText: displayText(w, item.text),
      highlighted: !!(item.state & 2),
      rect: bounds[index],
    })),
    selected: t.selected,
    focused: t.focused,
    height: tabHeight(w),
  };
}
function itemInput(r, p, wide, previous = {}) {
  r.check(p, 28);
  const mask = r.read32(p),
    item = { text: '', param: 0, state: 0, ...previous };
  if (mask & ~0x1b) throw Error('Unsupported Tab control item fields');
  if (mask & 1) {
    const text = r.read32(p + 12);
    if (text === 0xffffffff) throw Error('Tab callback text is not implemented');
    item.text = text ? (wide ? r.wideString(text) : r.string(text)) : '';
    if (item.text.length > 32767) throw Error('Tab text limit exceeded');
  }
  if (mask & 2 && r.read32(p + 20) !== 0xffffffff) throw Error('Tab images are not implemented');
  if (mask & 8) item.param = r.read32(p + 24);
  if (mask & 0x10) {
    const stateMask = r.read32(p + 8);
    if (stateMask & ~2) throw Error('Unsupported Tab item state');
    item.state = (item.state & ~stateMask) | (r.read32(p + 4) & stateMask);
  }
  return item;
}
async function notify(r, w, code, key, flags) {
  const p = r.allocate(key === undefined ? 12 : 18);
  try {
    [w.id, w.controlId, code].forEach((v, i) => r.write32(p + 4 * i, v));
    if (key !== undefined) {
      r.view.setUint16(p + 12, key, true);
      r.write32(p + 14, flags);
    }
    return await r.windows.send(w.parentId, 0x4e, w.controlId, p);
  } finally {
    r.free(p);
  }
}
function setSelection(r, w, index) {
  const t = tabs(w),
    previous = t.selected;
  if (index >= t.items.length) return -1;
  t.selected = index < 0 ? -1 : index;
  t.focused = t.selected;
  r.windows.emit(w);
  return previous;
}
async function userSelect(r, w, index) {
  const t = tabs(w),
    item = t.items[index];
  if (!item || index === t.selected) return 0;
  if (await notify(r, w, -552)) return 0; // TCN_SELCHANGING: parent can veto
  if (!r.windows.windows.has(w.id)) return 0;
  // A parent callback may insert/delete items; retain the intended identity.
  index = t.items.indexOf(item);
  if (index < 0) return 0;
  setSelection(r, w, index);
  await notify(r, w, -551);
  return 0;
}
export function tabInput(r, w, event) {
  if (event.type !== 'tab-select') return false;
  const index = tabs(w).items.findIndex((item) => item.id === event.item);
  if (index >= 0) r.windows.post(w.id, SELECT, 0, event.item);
  return true;
}
export async function tabMessage(r, w, message, wp, lp, fallback) {
  const t = tabs(w),
    index = wp | 0;
  if (message === SELECT)
    return userSelect(
      r,
      w,
      t.items.findIndex((item) => item.id === lp),
    );
  if (message === 0x100) {
    await notify(r, w, -550, wp, lp);
    if (!r.windows.windows.has(w.id)) return 0;
    if (wp === 37 || wp === 39) return userSelect(r, w, t.focused + (wp === 37 ? -1 : 1));
    return 0;
  }
  if (message === 0x2005) {
    const old = t.unicode;
    t.unicode = !!wp;
    return +old;
  }
  if (message === 0x2006) return +t.unicode;
  if (message === 0x1304) return t.items.length;
  if ([0x1307, 0x133e].includes(message)) {
    if (index < 0) return -1;
    if (t.items.length >= 2048) {
      r.lastError = 8;
      return -1;
    }
    const at = Math.min(index, t.items.length),
      item = itemInput(r, lp, message === 0x133e);
    item.id = t.next++;
    t.items.splice(at, 0, item);
    if (t.items.length === 1) t.selected = t.focused = 0;
    else {
      if (at <= t.selected) t.selected++;
      if (at <= t.focused) t.focused++;
    }
    r.windows.emit(w);
    return at;
  }
  if ([0x1306, 0x133d].includes(message)) {
    if (!t.items[index]) return 0;
    Object.assign(t.items[index], itemInput(r, lp, message === 0x133d, t.items[index]));
    r.windows.emit(w);
    return 1;
  }
  if ([0x1305, 0x133c].includes(message)) {
    const item = t.items[index];
    if (!item) return 0;
    r.check(lp, 28, true);
    const mask = r.read32(lp),
      wide = message === 0x133c;
    if (mask & ~0x1b) throw Error('Unsupported Tab query fields');
    if (mask & 1) {
      const p = r.read32(lp + 12),
        capacity = r.read32(lp + 16) | 0;
      if (p && capacity > 0) {
        if (wide) {
          const text = item.text.slice(0, capacity - 1);
          r.check(p, (text.length + 1) * 2, true);
          for (let i = 0; i <= text.length; i++)
            r.view.setUint16(p + 2 * i, i < text.length ? text.charCodeAt(i) : 0, true);
        } else {
          const bytes = encodeAnsi(item.text).bytes.subarray(0, capacity - 1);
          r.check(p, bytes.length + 1, true);
          r.data.set(bytes, p);
          r.data[p + bytes.length] = 0;
        }
      }
    }
    if (mask & 2) r.write32(lp + 20, -1);
    if (mask & 8) r.write32(lp + 24, item.param);
    if (mask & 0x10)
      r.write32(lp + 4, (item.state | (index === t.selected ? 1 : 0)) & r.read32(lp + 8));
    return 1;
  }
  if (message === 0x1308) {
    if (!t.items[index]) return 0;
    t.items.splice(index, 1);
    for (const field of ['selected', 'focused']) {
      if (index === t[field]) t[field] = -1;
      else if (index < t[field]) t[field]--;
    }
    r.windows.emit(w);
    return 1;
  }
  if (message === 0x1309) {
    t.items = [];
    t.selected = t.focused = -1;
    r.windows.emit(w);
    return 1;
  }
  if (message === 0x130a) {
    const rect = rects(w)[index];
    if (!rect) return 0;
    r.check(lp, 16, true);
    rect.forEach((v, i) => r.write32(lp + 4 * i, v));
    return 1;
  }
  if (message === 0x130b) return t.selected;
  if (message === 0x130c) return setSelection(r, w, index);
  if (message === 0x130d) {
    r.check(lp, 12, true);
    const x = r.read32(lp) | 0,
      y = r.read32(lp + 4) | 0;
    const found =
      x < 0 || x >= w.width || y < 0 || y >= w.height
        ? -1
        : rects(w).findIndex(
            ([left, top, right, bottom]) => x >= left && x < right && y >= top && y < bottom,
          );
    r.write32(lp + 8, found < 0 ? 1 : 4);
    return found;
  }
  if (message === 0x1328) {
    r.check(lp, 16, true);
    const sign = wp ? -1 : 1,
      margins = [4, tabHeight(w) + 4, -4, -4];
    margins.forEach((v, i) => r.write32(lp + 4 * i, (r.read32(lp + 4 * i) | 0) + sign * v));
    return 0;
  }
  if (message === 0x1329) {
    const previous = (tabHeight(w) << 16) | t.width,
      width = lp & 0xffff,
      height = lp >>> 16;
    if (!width || !height || width > 4096 || height > 4096) throw Error('Unsupported Tab size');
    t.width = width;
    t.height = height;
    t.fixedHeight = true;
    r.windows.emit(w);
    return previous;
  }
  if (message === 0x132b) {
    const padding = [lp & 0xffff, lp >>> 16];
    if (padding.some((value) => value > 4096)) throw Error('Unsupported Tab padding');
    if (!t.fixedHeight) t.height = Math.max(1, t.height + 2 * (padding[1] - t.padding[1]));
    t.padding = padding;
    r.windows.emit(w);
    return 0;
  }
  if (message === 0x132c) return 1;
  if (message === 0x132f) return t.focused;
  if (message === 0x1330) {
    if (index < 0) {
      if (t.selected < 0) return 0;
      setSelection(r, w, -1);
      await notify(r, w, -551);
      return 0;
    }
    return userSelect(r, w, index);
  }
  if (message === 0x1331) {
    const old = t.minimum;
    const minimum = (lp | 0) === -1 ? 48 : lp >>> 0;
    if (minimum > 4096) throw Error('Unsupported Tab minimum width');
    t.minimum = minimum;
    r.windows.emit(w);
    return old;
  }
  if (message === 0x1333) {
    if (!t.items[index]) return 0;
    t.items[index].state = lp & 0xffff ? 2 : 0;
    r.windows.emit(w);
    return 1;
  }
  if (message === 0x1302) return 0;
  if (message === 0x1303 && !lp) return 0;
  if (message >= 0x1300 && message <= 0x133e)
    throw Error(`Unsupported Tab message 0x${message.toString(16)}`);
  return fallback();
}
