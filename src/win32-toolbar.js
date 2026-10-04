import { encodeAnsi } from './encoding.js';
import { bitmapFromDib } from './win32-resource-bitmaps.js';
import { describeGdiBitmap } from './win32-gdi.js';
import { createWindowFromHost } from './win32-windows.js';
import standardBitmaps from './toolbar-bitmaps.json' with { type: 'json' };

const ENABLED = 4,
  HIDDEN = 8,
  CHECKED = 1,
  SEP = 1,
  CHECK = 2,
  GROUP = 4;
const CLICK = 0x7fc1;
const result = (value, argc = 13) => ({ result: value >>> 0, argc });
function fail(r, error = 87, value = 0) {
  r.lastError = error;
  return value;
}
function state(w) {
  return (w.toolbar ??= {
    buttons: [],
    strings: [],
    ownedStrings: [],
    images: [],
    rects: [],
    buttonWidth: 24,
    buttonHeight: 24,
    bitmapWidth: 16,
    bitmapHeight: 16,
    indent: 0,
    textRows: 1,
    unicode: !!w.cls.wide,
    notifyParent: w.parentId,
    rows: 1,
  });
}
function caption(s, b) {
  return b.text ?? s.strings[b.string] ?? '';
}
function arrange(r, w) {
  const s = state(w),
    parent = r.windows.windows.get(w.parentId);
  if (parent && !(w.style & 8)) {
    w.width = parent.width;
    w.x = 0;
  }
  let x = s.indent + 2,
    y = 2,
    max = x;
  s.rects = s.buttons.map((b) => {
    if (b.state & HIDDEN) return null;
    const text = s.textRows ? caption(s, b) : '';
    const width =
      b.style & SEP
        ? b.image > 0
          ? b.image
          : 8
        : b.width ||
          (b.style & 16
            ? Math.max(s.buttonWidth, text.length * 8 + 12 + (b.image >= 0 ? s.bitmapWidth : 0))
            : s.buttonWidth);
    if (w.style & 0x200 && x > s.indent + 2 && x + width > w.width) {
      x = s.indent + 2;
      y += s.buttonHeight;
    }
    const rect = [x, y, x + width, y + s.buttonHeight];
    max = Math.max(max, x + width);
    x += width;
    if (b.state & 32) {
      x = s.indent + 2;
      y += s.buttonHeight;
    }
    return rect;
  });
  s.rows = Math.max(1, Math.floor(y / s.buttonHeight) + 1);
  s.maxWidth = max + 2;
  if (!(w.style & 4)) w.height = y + s.buttonHeight + 2;
  if (parent && !(w.style & 8)) w.y = (w.style & 3) === 3 ? parent.height - w.height : 0;
  r.windows.emit(w);
}
function lookup(s, command) {
  return s.buttons.findIndex((b) => b.command === (command | 0));
}
function checkGroup(s, index) {
  const current = s.buttons[index];
  if (!(current.style & GROUP) || !(current.state & CHECKED)) return;
  let first = index,
    end = index + 1;
  while (first > 0 && s.buttons[first - 1].style & GROUP) first--;
  while (end < s.buttons.length && s.buttons[end].style & GROUP) end++;
  for (let i = first; i < end; i++) if (i !== index) s.buttons[i].state &= ~CHECKED;
}
function parseButtons(r, s, pointer, count, wide) {
  if (count > 1024 || count + s.buttons.length > 1024 || (count && !pointer)) return null;
  if (!count) return [];
  r.check(pointer, count * 20);
  const buttons = [];
  for (let i = 0; i < count; i++) {
    const p = pointer + i * 20,
      style = r.data[p + 9],
      string = r.read32(p + 16) | 0;
    if (style & 0x88) {
      fail(r, 120);
      return null;
    } // dropdown/whole-dropdown need TBN_DROPDOWN
    const b = {
      image: r.read32(p) | 0,
      command: r.read32(p + 4) | 0,
      state: r.data[p + 8],
      style,
      data: r.read32(p + 12),
      string,
    };
    if (string >>> 0 > 0xffff && string !== -1)
      b.text = wide ? r.wideString(string >>> 0) : r.string(string >>> 0);
    buttons.push(b);
  }
  for (const b of buttons)
    if (b.text !== undefined) {
      b.string = r.allocString(b.text, wide);
      s.ownedStrings.push(b.string);
    }
  return buttons;
}
function addBitmap(r, w, count, instance, id) {
  const s = state(w);
  if (count > 1024) return fail(r, 87, -1);
  let bitmap,
    labels,
    cellWidth = s.bitmapWidth,
    cellHeight = s.bitmapHeight;
  if (instance === 0xffffffff) {
    const asset = standardBitmaps[id];
    if (!asset) return fail(r, 120, -1);
    const bytes = Uint8Array.from(atob(asset.bitmap), (c) => c.charCodeAt(0));
    const handle = bitmapFromDib(r, bytes).result;
    if (!handle) return -1;
    bitmap = describeGdiBitmap(r, handle);
    r.apiProvider.get('gdi32.dll!DeleteObject')(r, () => handle);
    cellWidth = cellHeight = asset.size;
    labels = asset.labels;
    count = Math.floor(bitmap.width / cellWidth);
  } else if (instance) {
    const handler = r.apiProvider.get('user32.dll!LoadBitmapA');
    const handle = handler(r, (i) => [instance, id][i]).result;
    if (!handle) return -1;
    bitmap = describeGdiBitmap(r, handle);
    r.apiProvider.get('gdi32.dll!DeleteObject')(r, () => handle);
  } else bitmap = describeGdiBitmap(r, id);
  if (
    !bitmap ||
    !count ||
    cellHeight > bitmap.height ||
    count * cellWidth > bitmap.width ||
    s.images.length + count > 1024
  )
    return fail(r, 87, -1);
  const first = s.images.length;
  for (let index = 0; index < count; index++) {
    const pixels = new Uint8ClampedArray(cellWidth * cellHeight * 4);
    for (let y = 0; y < cellHeight; y++) {
      const start = (y * bitmap.width + index * cellWidth) * 4;
      pixels.set(bitmap.pixels.subarray(start, start + cellWidth * 4), y * cellWidth * 4);
    }
    for (let p = 0; p < pixels.length; p += 4)
      if (pixels[p] === 192 && pixels[p + 1] === 192 && pixels[p + 2] === 192) pixels[p + 3] = 0;
    s.images.push({ width: cellWidth, height: cellHeight, pixels, label: labels?.[index] });
  }
  r.windows.emit(w);
  return first;
}
function writeText(r, p, value, wide, capacity = 32768) {
  const bytes = wide ? null : encodeAnsi(value).bytes;
  const count = Math.min(wide ? value.length : bytes.length, Math.max(0, capacity - 1));
  if (p && capacity) {
    r.check(p, (count + 1) * (wide ? 2 : 1), true);
    for (let i = 0; i <= count; i++)
      r.guestMemory.write(
        p + i * (wide ? 2 : 1),
        i === count ? 0 : wide ? value.charCodeAt(i) : bytes[i],
        wide ? 2 : 1,
      );
  }
  return count;
}
export function describeToolbar(w) {
  if (w.controlType !== 'toolbar') return undefined;
  const s = state(w);
  return {
    showText: s.textRows > 0,
    buttons: s.buttons.map((b, index) => ({
      index,
      command: b.command,
      state: b.state,
      style: b.style,
      text: caption(s, b),
      image: s.images[b.image],
      rect: s.rects[index],
    })),
    rows: s.rows,
  };
}
export function toolbarInput(r, w, event) {
  if (event.type !== 'toolbar-command') return false;
  r.windows.post(w.id, CLICK, event.command >>> 0);
  return true;
}
export async function toolbarMessage(r, w, msg, wp, lp, fallback) {
  const s = state(w),
    index = lookup(s, wp),
    b = s.buttons[index];
  if ([1, 5, 0x421].includes(msg)) {
    arrange(r, w);
    return 0;
  }
  if (msg === 0x82) {
    for (const p of s.ownedStrings) r.free(p);
    return fallback();
  }
  if (msg === CLICK) {
    if (!b || !(b.state & ENABLED) || b.state & HIDDEN || b.style & SEP) return 0;
    if (b.style & CHECK) {
      if (b.style & GROUP) b.state |= CHECKED;
      else b.state ^= CHECKED;
      checkGroup(s, index);
      r.windows.emit(w);
    }
    if (r.windows.windows.has(s.notifyParent))
      await r.windows.send(s.notifyParent, 0x111, wp & 0xffff, w.id);
    return 0;
  }
  if (msg >= 0x401 && msg <= 0x405) {
    if (!b) return 0;
    const bit = [ENABLED, CHECKED, 2, HIDDEN, 16][msg - 0x401];
    b.state = (b.state & ~bit) | (lp & 0xffff ? bit : 0);
    if (msg === 0x402) checkGroup(s, index);
    arrange(r, w);
    return 1;
  }
  if (msg >= 0x409 && msg <= 0x40d)
    return b ? +!!(b.state & [ENABLED, CHECKED, 2, HIDDEN, 16][msg - 0x409]) : -1;
  if (msg === 0x411) {
    if (!b) return 0;
    b.state = lp & 255;
    arrange(r, w);
    return 1;
  }
  if (msg === 0x412) return b ? b.state : -1;
  if (msg === 0x413) {
    if (!lp) return fail(r, 87, -1);
    r.check(lp, 8);
    return addBitmap(r, w, wp >>> 0, r.read32(lp), r.read32(lp + 4));
  }
  if ([0x414, 0x444, 0x415, 0x443].includes(msg)) {
    const insert = msg === 0x415 || msg === 0x443;
    const buttons = parseButtons(r, s, lp, insert ? 1 : wp >>> 0, msg === 0x444 || msg === 0x443);
    if (!buttons) return 0;
    if (insert) s.buttons.splice(Math.min(wp >>> 0, s.buttons.length), 0, ...buttons);
    else s.buttons.push(...buttons);
    arrange(r, w);
    return 1;
  }
  if (msg === 0x416) {
    if (wp >= s.buttons.length) return 0;
    s.buttons.splice(wp, 1);
    arrange(r, w);
    return 1;
  }
  if (msg === 0x417) {
    const item = s.buttons[wp];
    if (!item || !lp) return 0;
    r.check(lp, 20, true);
    r.data.fill(0, lp, lp + 20);
    r.write32(lp, item.image);
    r.write32(lp + 4, item.command);
    r.data[lp + 8] = item.state;
    r.data[lp + 9] = item.style;
    r.write32(lp + 12, item.data);
    r.write32(lp + 16, item.string);
    return 1;
  }
  if (msg === 0x418) return s.buttons.length;
  if (msg === 0x419) return index;
  if ([0x41c, 0x44d].includes(msg)) {
    if (wp) return fail(r, 120, -1); // resource-delimited string pools need resource loading
    const wide = msg === 0x44d,
      strings = [];
    let p = lp;
    if (!p) return fail(r, 87, -1);
    for (let i = 0; i < 1024; i++) {
      const value = wide ? r.wideString(p) : r.string(p);
      if (!value) {
        const first = s.strings.length;
        s.strings.push(...strings);
        arrange(r, w);
        return first;
      }
      if (value.length > 32767) return fail(r, 87, -1);
      strings.push(value);
      p += (value.length + 1) * (wide ? 2 : 1);
    }
    return fail(r, 87, -1);
  }
  if (msg === 0x41e) return wp === 20 ? 0 : fail(r, 87);
  if (msg === 0x41f || msg === 0x420) {
    const width = lp & 0xffff,
      height = lp >>> 16;
    if (!width || !height || width > 4096 || height > 4096) return 0;
    if (msg === 0x41f) {
      s.buttonWidth = width;
      s.buttonHeight = height;
    } else {
      s.bitmapWidth = width;
      s.bitmapHeight = height;
    }
    arrange(r, w);
    return 1;
  }
  if ([0x41d, 0x433].includes(msg)) {
    const rect = s.rects[msg === 0x41d ? wp : index];
    if (!rect || !lp) return 0;
    r.check(lp, 16, true);
    rect.forEach((v, i) => r.write32(lp + i * 4, v));
    return 1;
  }
  if (msg === 0x425) {
    if (!r.windows.windows.has(wp)) return fail(r, 1400);
    const old = s.notifyParent;
    s.notifyParent = wp;
    return old;
  }
  if (msg === 0x428) return s.rows;
  if (msg === 0x42a) {
    if (!s.buttons[wp]) return 0;
    s.buttons[wp].command = lp | 0;
    r.windows.emit(w);
    return 1;
  }
  if (msg === 0x42b) {
    if (!b) return 0;
    b.image = lp & 0xffff;
    r.windows.emit(w);
    return 1;
  }
  if (msg === 0x42c) return b?.image ?? -1;
  if ([0x42d, 0x44b].includes(msg)) {
    if (!b) return -1;
    const text = b.text ?? s.strings[b.string];
    if (text === undefined) return msg === 0x44b ? 0 : -1;
    return writeText(r, lp, text, msg === 0x44b);
  }
  if (msg === 0x42f) {
    if (wp > 4096) return 0;
    s.indent = wp;
    arrange(r, w);
    return 1;
  }
  if (msg === 0x432) return addBitmap(r, w, 0, lp, wp);
  if (msg === 0x439) return w.style;
  if (msg === 0x43a) return (s.buttonWidth | (s.buttonHeight << 16)) >>> 0;
  if (msg === 0x43c) {
    s.textRows = wp >>> 0;
    arrange(r, w);
    return 1;
  }
  if (msg === 0x43d) return s.textRows;
  if ([0x43f, 0x440, 0x441, 0x442].includes(msg)) {
    if (!lp) return fail(r, 87, msg === 0x43f || msg === 0x441 ? -1 : 0);
    const get = msg === 0x43f || msg === 0x441,
      wide = msg === 0x43f || msg === 0x440;
    r.check(lp, 32, get);
    const mask = r.read32(lp + 4),
      at = mask & 0x80000000 ? wp : index,
      item = s.buttons[at];
    if (r.read32(lp) !== 32 || mask & ~0x8000007f || !item) return get ? -1 : 0;
    if (get) {
      if (mask & 1) r.write32(lp + 12, item.image);
      if (mask & 2) writeText(r, r.read32(lp + 24), caption(s, item), wide, r.read32(lp + 28));
      if (mask & 4) r.data[lp + 16] = item.state;
      if (mask & 8) r.data[lp + 17] = item.style;
      if (mask & 16) r.write32(lp + 20, item.data);
      if (mask & 32) r.write32(lp + 8, item.command);
      if (mask & 64) r.view.setUint16(lp + 18, item.width || s.buttonWidth, true);
      return at;
    }
    const changed = { ...item };
    if (mask & 1) changed.image = r.read32(lp + 12) | 0;
    if (mask & 4) changed.state = r.data[lp + 16];
    if (mask & 8) changed.style = r.data[lp + 17];
    if (changed.style & 0x88) return fail(r, 120);
    if (mask & 16) changed.data = r.read32(lp + 20);
    if (mask & 32) changed.command = r.read32(lp + 8) | 0;
    if (mask & 64) {
      changed.width = r.view.getUint16(lp + 18, true);
      if (changed.width > 4096) return 0;
    }
    if (mask & 2) {
      const p = r.read32(lp + 24);
      changed.text = p ? (wide ? r.wideString(p) : r.string(p)) : '';
      changed.string = r.allocString(changed.text, wide);
      s.ownedStrings.push(changed.string);
    }
    s.buttons[at] = changed;
    arrange(r, w);
    return 1;
  }
  if (msg === 0x453) {
    if (!lp) return 0;
    r.check(lp, 8, true);
    r.write32(lp, s.maxWidth);
    r.write32(lp + 4, w.height);
    return 1;
  }
  if (msg === 0x2005) {
    const old = s.unicode;
    s.unicode = !!wp;
    return +old;
  }
  if (msg === 0x2006) return +s.unicode;
  if (msg >= 0x400 && msg < 0x500) throw Error(`Unsupported toolbar message 0x${msg.toString(16)}`);
  return fallback();
}
export const toolbarApis = {
  'comctl32.dll!CreateToolbarEx': async (r, a) => {
    const parent = r.windows.windows.get(a(0));
    if (!parent) return result(fail(r, 1400));
    if (a(12) !== 20 || a(1) & 0x80 || a(3) > 1024 || a(7) > 1024) return result(fail(r));
    const sizes = [a(8) || 24, a(9) || 24, a(10) || 16, a(11) || 16];
    if (sizes.some((v) => v > 4096)) return result(fail(r));
    const created = await createWindowFromHost(r, {
      className: 'ToolbarWindow32',
      parent: parent.id,
      controlId: a(2),
      style: a(1) | 0x40000000,
      width: parent.width,
      height: 28,
    });
    if (!created.id) return result(0);
    const w = r.windows.windows.get(created.id),
      s = state(w);
    const abort = async () => {
      await r.windows.destroy(w.id);
      return result(0);
    };
    [s.buttonWidth, s.buttonHeight, s.bitmapWidth, s.bitmapHeight] = sizes;
    if (a(3) && addBitmap(r, w, a(3), a(4), a(5)) < 0) return abort();
    const buttons = parseButtons(r, s, a(6), a(7), false);
    if (!buttons) return abort();
    s.buttons = buttons;
    arrange(r, w);
    return result(w.id);
  },
};
