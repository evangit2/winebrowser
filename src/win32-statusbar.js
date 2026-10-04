import { encodeAnsi } from './encoding.js';

// Shared horizontal textual status bars. Native EXEs/DLLs own their parts and
// callbacks; the desktop renders the resulting model without interpreting IDs.
function state(w) {
  return (w.statusbar ??= {
    parts: [{ edge: -1, text: w.title ?? '', style: 0, tip: '' }],
    simplePart: { text: '', style: 0, tip: '' },
    simple: false,
    borders: [0, 2, 2],
    minimum: 18,
    background: 0xff000000,
    unicode: !!w.cls.wide,
  });
}
function bounds(w) {
  const s = state(w);
  if (s.simple) return [[s.borders[0], s.borders[1], w.width, w.height]];
  let left = 0;
  return s.parts.map((part) => {
    const right = part.edge === -1 ? w.width : part.edge,
      rect = [left, s.borders[1], right, w.height];
    left = right + s.borders[2];
    return rect;
  });
}
export function describeStatusbar(w) {
  if (w.controlType !== 'statusbar') return undefined;
  const s = state(w),
    rects = bounds(w);
  return {
    background: s.background,
    simple: s.simple,
    sizeGrip: !!(w.style & 0x100),
    parts: (s.simple ? [s.simplePart] : s.parts).map((p, i) => ({
      text: p.text,
      style: p.style,
      tip: p.tip,
      rect: rects[i],
    })),
  };
}
function writeText(r, pointer, text, wide, capacity = Infinity) {
  const bytes = wide ? null : encodeAnsi(text).bytes,
    length = wide ? text.length : bytes.length,
    count = Math.min(length, Math.max(0, capacity - 1)),
    width = wide ? 2 : 1;
  if (pointer && capacity > 0) {
    r.check(pointer, (count + 1) * width, true);
    for (let i = 0; i < count; i++)
      r.guestMemory.write(pointer + i * width, wide ? text.charCodeAt(i) : bytes[i], width);
    r.guestMemory.write(pointer + count * width, 0, width);
  }
  return count;
}
async function notify(r, w, code, mouse) {
  const p = r.allocate(mouse ? 32 : 12);
  try {
    [w.id, w.controlId, code].forEach((v, i) => r.write32(p + i * 4, v));
    if (mouse)
      [mouse.item, 0, mouse.x, mouse.y, 0x30000].forEach((v, i) => r.write32(p + 12 + i * 4, v));
    return await r.windows.send(w.parentId, 0x4e, mouse ? w.controlId : 0, p);
  } finally {
    r.free(p);
  }
}
export async function statusbarMessage(r, w, message, wp, lp, fallback, wide) {
  const s = state(w),
    index = wp & 255;
  const read = (pointer, isWide) =>
    pointer ? (isWide ? r.wideString(pointer) : r.string(pointer)) : '';
  if (message === 1 || message === 5) {
    const parent = r.windows.windows.get(w.parentId);
    if (parent && !(w.style & 4) && (message === 1 || wp === 0 || wp === 2)) {
      w.width = parent.width;
      w.height = Math.max((w.font?.height ?? 14) + 4, s.minimum) + s.borders[1];
      w.x = 0;
      w.y = parent.height - w.height;
      r.windows.emit(w);
    }
    return 0;
  }
  if (message === 0x2005) {
    const old = s.unicode;
    s.unicode = !!wp;
    return +old;
  }
  if (message === 0x2006) return +s.unicode;
  if (message === 0x2001) {
    const old = s.background;
    s.background = lp >>> 0;
    r.windows.emit(w);
    return old;
  }
  if (message === 0x404) {
    const count = wp >>> 0;
    if (!count || count > 256 || !lp) return 0;
    r.check(lp, count * 4);
    const edges = Array.from({ length: count }, (_, i) => r.read32(lp + i * 4) | 0);
    // Bounded horizontal rectangles; retain parts on rejected layouts.
    if (
      edges.some(
        (v, i) => v < -1 || (v === -1 && i !== count - 1) || (i && v !== -1 && v < edges[i - 1]),
      )
    )
      return 0;
    s.parts = edges.map((edge, i) => ({ text: '', style: 0, tip: '', ...s.parts[i], edge }));
    r.windows.emit(w);
    return 1;
  }
  if (message === 0x406) {
    const count = Math.min(wp >>> 0, s.parts.length);
    if (lp) {
      r.check(lp, count * 4, true);
      for (let i = 0; i < count; i++) r.write32(lp + i * 4, s.parts[i].edge);
    }
    return s.parts.length;
  }
  if (message === 0x405 || message === 0x407) {
    if (!lp) return 0;
    r.check(lp, 12, message === 0x407);
    if (message === 0x407) {
      s.borders.forEach((v, i) => r.write32(lp + 4 * i, v));
      return 1;
    }
    const values = [0, 4, 8].map((i) => r.read32(lp + i) | 0);
    if (values.some((v) => v < 0 || v > 4096)) return 0;
    s.borders = values;
    r.windows.emit(w);
    return 1;
  }
  if (message === 0x408) {
    if (wp > 2046) throw Error('Unsupported status bar minimum height');
    s.minimum = wp;
    return 0;
  }
  if (message === 0x409) {
    if (s.simple === !!wp) return 1;
    s.simple = !!wp;
    r.windows.emit(w);
    await notify(r, w, -880);
    return 1;
  }
  if (message === 0x40e) return +s.simple;
  if (message === 0x40a) {
    if (!s.parts[index] || !lp) return 0;
    r.check(lp, 16, true);
    (s.simple ? bounds(w)[0] : bounds(w)[index]).forEach((v, i) => r.write32(lp + 4 * i, v));
    return 1;
  }
  if (message === 0x401 || message === 0x40b || message === 0xc) {
    const part = message === 0xc ? s.parts[0] : index === 255 ? s.simplePart : s.parts[index];
    if (!part) return 0;
    const style = message === 0xc ? part.style : wp & 0xff00;
    if (style & ~0xf00) throw Error('Unsupported status bar text style');
    const value = read(lp, message === 0xc ? (wide ?? w.cls.wide) : message === 0x40b);
    if (value.length > 65535) throw Error('Status bar text limit exceeded');
    part.text = message === 0xc ? value : value.replace(/[\x01-\x08\x0a-\x1f]/g, ' ');
    part.style = style;
    if (part === s.parts[0]) w.title = part.text;
    r.windows.emit(w);
    return 1;
  }
  if ([0x402, 0x403, 0x40c, 0x40d, 0xd, 0xe].includes(message)) {
    const part =
      message === 0xd ? s.parts[0] : s.parts[index] && (s.simple ? s.simplePart : s.parts[index]);
    if (!part) return 0;
    const isWide =
      message === 0xd || message === 0xe ? (wide ?? w.cls.wide) : [0x40c, 0x40d].includes(message);
    if (message === 0xd) return writeText(r, lp, part.text, isWide, wp);
    const length = isWide ? part.text.length : encodeAnsi(part.text).bytes.length;
    if (message === 0xe) return length;
    if ([0x402, 0x40d].includes(message)) writeText(r, lp, part.text, isWide);
    return ((part.style << 16) | length) >>> 0;
  }
  if ([0x410, 0x411, 0x412, 0x413].includes(message)) {
    const part = s.parts[index];
    if (!part) return 0;
    if (message === 0x410 || message === 0x411) {
      if (w.style & 0x800) {
        part.tip = read(lp, message === 0x411);
        r.windows.emit(w);
      }
    } else writeText(r, lp, part.tip, message === 0x413, wp >>> 16);
    return 0;
  }
  if (message === 0x40f || message === 0x414) {
    if (message === 0x40f && lp) throw Error('Status bar icons are not implemented');
    return message === 0x40f ? +(index === 255 || !!s.parts[index]) : 0;
  }
  if ([0x202, 0x203, 0x205, 0x206].includes(message)) {
    const x = (lp << 16) >> 16,
      y = lp >> 16;
    const item = s.simple
      ? 255
      : bounds(w).findIndex(([l, t, rr, b]) => x >= l && x < rr && y >= t && y < b);
    await notify(r, w, { 0x202: -2, 0x203: -3, 0x205: -5, 0x206: -6 }[message], {
      x,
      y,
      item: item < 0 ? -2 : item,
    });
    return 0;
  }
  if (message >= 0x400 && message <= 0x414)
    throw Error(`Unsupported status bar message 0x${message.toString(16)}`);
  return fallback();
}
async function createStatus(r, a, wide) {
  const parent = r.windows.windows.get(a(2));
  if (!parent) {
    r.lastError = 1400;
    return { result: 0, argc: 4 };
  }
  const name = r.allocString('msctls_statusbar32', wide);
  try {
    const values = [0, name, a(1), a(0), 0, 0, parent.width, 20, a(2), a(3), 0, 0];
    const answer = await r.apiProvider.get(`user32.dll!CreateWindowEx${wide ? 'W' : 'A'}`)(
      r,
      (i) => values[i],
    );
    return { result: answer.result, argc: 4 };
  } finally {
    r.free(name);
  }
}
export const statusbarApis = {
  'comctl32.dll!CreateStatusWindowA': (r, a) => createStatus(r, a, false),
  'comctl32.dll!CreateStatusWindow': (r, a) => createStatus(r, a, false),
  'comctl32.dll!CreateStatusWindowW': (r, a) => createStatus(r, a, true),
};
