import { encodeAnsi } from './encoding.js';
// Bounded, text-only report view. Callback text, image lists, owner data and
// non-report views deliberately fail instead of manufacturing native results.
const SELECT = 0x7fb0;
function model(w) {
  return (w.report ??= {
    items: [],
    columns: [],
    next: 1,
    mark: -1,
    extended: 0,
    unicode: !!w.cls.wide,
  });
}
export function describeListview(w) {
  if (w.controlType !== 'listview') return undefined;
  const s = model(w);
  return {
    columns: s.columns.map((c) => ({ ...c })),
    items: s.items.map((i) => ({ id: i.id, texts: [...i.texts], state: i.state })),
    header: !(w.style & 0x4000),
  };
}
function text(r, p, wide) {
  if (p === 0xffffffff) throw Error('ListView callback text is unsupported');
  const value = p ? (wide ? r.wideString(p) : r.string(p)) : '';
  if (value.length > 32767) throw Error('ListView text limit exceeded');
  return value;
}
function output(r, p, value, capacity, wide) {
  if (!p || capacity <= 0) return 0;
  const bytes = wide ? null : encodeAnsi(value).bytes.subarray(0, capacity - 1);
  value = value.slice(0, capacity - 1);
  const count = wide ? value.length : bytes.length;
  r.check(p, (count + 1) * (wide ? 2 : 1), true);
  if (wide)
    for (let i = 0; i <= count; i++)
      r.guestMemory.write(p + 2 * i, i === count ? 0 : value.charCodeAt(i), 2);
  else {
    r.data.set(bytes, p);
    r.data[p + count] = 0;
  }
  return count;
}
async function notify(r, w, code, index, item, oldState = 0, newState = 0, changed = 0) {
  const p = r.allocate(44);
  try {
    r.data.fill(0, p, p + 44);
    [w.id, w.controlId, code, index, 0, newState, oldState, changed].forEach((v, n) =>
      r.write32(p + 4 * n, v),
    );
    r.write32(p + 40, item?.param ?? 0);
    return await r.windows.send(w.parentId, 0x4e, w.controlId, p);
  } finally {
    r.free(p);
  }
}
async function state(r, w, item, value, mask) {
  if (mask & ~3) throw Error('Unsupported ListView state bits');
  const s = model(w),
    before = item.state,
    after = (before & ~mask) | (value & mask);
  if (before === after) return true;
  if (await notify(r, w, -100, s.items.indexOf(item), item, before, after, 8)) return false;
  if (!r.windows.windows.has(w.id) || !s.items.includes(item)) return false;
  // Single focus and LVS_SINGLESEL selection also apply to programmatic state.
  if (after & 1 || (after & 2 && w.style & 4)) {
    for (const other of [...s.items])
      if (other !== item) {
        const clear = (after & 1 ? 1 : 0) | (after & 2 && w.style & 4 ? 2 : 0);
        if (other.state & clear) await state(r, w, other, 0, clear);
      }
  }
  item.state = after;
  r.windows.emit(w);
  await notify(r, w, -101, s.items.indexOf(item), item, before, after, 8);
  return true;
}
async function choose(r, w, id, flags) {
  const s = model(w),
    target = s.items.find((i) => i.id === id);
  if (!target) return 0;
  const index = s.items.indexOf(target),
    multi = !(w.style & 4),
    ctrl = multi && flags & 1,
    shift = multi && flags & 2;
  const anchor = s.items.findIndex((i) => i.id === s.anchor);
  for (const item of [...s.items]) {
    const at = s.items.indexOf(item);
    const selected =
      shift && anchor >= 0
        ? at >= Math.min(anchor, index) && at <= Math.max(anchor, index)
        : item === target
          ? ctrl
            ? !(item.state & 2)
            : true
          : ctrl
            ? !!(item.state & 2)
            : false;
    await state(r, w, item, (selected ? 2 : 0) | (item === target ? 1 : 0), 3);
    if (!r.windows.windows.has(w.id)) return 0;
  }
  if (!shift) s.anchor = id;
  s.mark = s.items.indexOf(target);
  return 0;
}
export function listviewInput(r, w, event) {
  if (event.type !== 'report-select') return false;
  if (model(w).items.some((i) => i.id === event.item))
    r.windows.post(w.id, SELECT, +!!event.ctrlKey | (+!!event.shiftKey << 1), event.item);
  return true;
}
export async function listviewMessage(r, w, msg, wp, lp, fallback) {
  const s = model(w),
    index = wp | 0;
  if (msg === SELECT) return choose(r, w, lp, wp);
  if (msg === 0x100) {
    const p = r.allocate(18);
    try {
      [w.id, w.controlId, -155].forEach((v, i) => r.write32(p + 4 * i, v));
      r.guestMemory.write(p + 12, wp, 2);
      r.write32(p + 14, lp);
      await r.windows.send(w.parentId, 0x4e, w.controlId, p);
    } finally {
      r.free(p);
    }
    if (wp === 38 || wp === 40) {
      const focused = s.items.findIndex((i) => i.state & 1),
        next = Math.max(0, Math.min(s.items.length - 1, focused + (wp === 38 ? -1 : 1)));
      if (s.items[next]) return choose(r, w, s.items[next].id, 0);
    }
    return 0;
  }
  if (msg === 0x2005) {
    const before = s.unicode;
    s.unicode = !!wp;
    return +before;
  }
  if (msg === 0x2006) return +s.unicode;
  if (msg === 0x1004) return s.items.length;
  if (msg === 0x1032) return s.items.filter((i) => i.state & 2).length;
  if (msg === 0x1042) return s.mark;
  if (msg === 0x1043) {
    const before = s.mark;
    s.mark = lp | 0;
    return before;
  }
  if (msg === 0x1037) return s.extended;
  if (msg === 0x1036) {
    const next = wp ? (s.extended & ~wp) | (lp & wp) : lp;
    if (next & ~0x20) throw Error('Unsupported ListView extended styles');
    const before = s.extended;
    s.extended = next;
    r.windows.emit(w);
    return before;
  }
  if (msg === 0x100c) {
    if (lp & ~3) throw Error('Unsupported ListView search flags');
    return s.items.findIndex((item, at) => at > index && (item.state & lp) === lp);
  }
  if (msg === 0x102c) return (s.items[index]?.state ?? 0) & lp;
  if (msg === 0x102b) {
    r.check(lp, 20);
    const value = r.read32(lp + 12),
      mask = r.read32(lp + 16);
    if (index !== -1 && !s.items[index]) return 0;
    for (const item of index === -1 ? [...s.items] : [s.items[index]])
      await state(r, w, item, value, mask);
    return 1;
  }
  if ([0x101b, 0x1061, 0x101a, 0x1060, 0x1019, 0x105f].includes(msg)) {
    r.check(lp, 4);
    const mask = r.read32(lp),
      wide = msg >= 0x105f;
    if (mask & ~0xf) throw Error('Unsupported ListView column fields');
    const insert = msg === 0x101b || msg === 0x1061,
      get = msg === 0x1019 || msg === 0x105f;
    if (index < 0 || (!insert && !s.columns[index])) return get ? 0 : -1;
    if (insert && s.columns.length >= 64) return -1;
    const c = insert ? { text: '', width: 80, format: 0, subitem: index } : { ...s.columns[index] };
    for (const [bit, offset, field] of [
      [1, 4, 'format'],
      [2, 8, 'width'],
      [8, 20, 'subitem'],
    ])
      if (mask & bit) {
        r.check(lp + offset, 4, get);
        if (get) r.write32(lp + offset, c[field]);
        else c[field] = r.read32(lp + offset) | 0;
      }
    if (mask & 4) {
      r.check(lp + 12, 8);
      const p = r.read32(lp + 12);
      if (get) output(r, p, c.text, r.read32(lp + 16) | 0, wide);
      else c.text = text(r, p, wide);
    }
    if (get) return 1;
    if (
      c.format & ~3 ||
      c.format === 3 ||
      c.width < 0 ||
      c.width > 32767 ||
      c.subitem < 0 ||
      c.subitem >= 64
    )
      throw Error('Unsupported ListView column layout');
    const at = Math.min(index, s.columns.length);
    if (insert) s.columns.splice(at, 0, c);
    else s.columns[index] = c;
    r.windows.emit(w);
    return insert ? at : 1;
  }
  if (msg === 0x101c) {
    if (!s.columns[index]) return 0;
    s.columns.splice(index, 1);
    r.windows.emit(w);
    return 1;
  }
  if (msg === 0x101d) return s.columns[index]?.width ?? 0;
  if (msg === 0x101e) {
    const c = s.columns[index];
    if (!c) return 0;
    let width = (lp << 16) >> 16;
    if (width === -1 || width === -2)
      width = Math.max(
        20,
        ...s.items.map((i) => (i.texts[c.subitem] ?? '').length * 7 + 12),
        width === -2 ? c.text.length * 7 + 12 : 0,
      );
    if (width < 0 || width > 32767) return 0;
    c.width = width;
    r.windows.emit(w);
    return 1;
  }
  if (
    [0x1005, 0x104b, 0x1006, 0x104c, 0x1007, 0x104d, 0x102d, 0x1073, 0x102e, 0x1074].includes(msg)
  ) {
    r.check(lp, 12);
    const insert = msg === 0x1007 || msg === 0x104d,
      get = [0x1005, 0x104b, 0x102d, 0x1073].includes(msg),
      textOnly = [0x102d, 0x1073, 0x102e, 0x1074].includes(msg);
    const at = textOnly ? index : r.read32(lp + 4) | 0,
      sub = r.read32(lp + 8) | 0,
      wide = msg >= 0x104b;
    const mask = textOnly ? 1 : r.read32(lp),
      item = insert ? { id: s.next++, texts: [], state: 0, param: 0 } : s.items[at];
    if (mask & ~0xd) throw Error('Unsupported ListView item fields');
    if (at < 0 || sub < 0 || sub >= 64 || !item || (insert && (sub || s.items.length >= 4096)))
      return insert ? -1 : 0;
    if (sub && mask & ~1) throw Error('Unsupported ListView subitem fields');
    if (mask & 1) {
      r.check(lp + 20, 8);
      const p = r.read32(lp + 20);
      if (get) {
        const length = output(r, p, item.texts[sub] ?? '', r.read32(lp + 24) | 0, wide);
        if (textOnly) return length;
      } else item.texts[sub] = text(r, p, wide);
    }
    if (mask & 4) {
      r.check(lp + 32, 4, get);
      if (get) r.write32(lp + 32, item.param);
      else item.param = r.read32(lp + 32);
    }
    if (mask & 4) {
      r.check(lp + 12, 8, get);
      const value = r.read32(lp + 12),
        stateMask = r.read32(lp + 16);
      if (get) r.write32(lp + 12, item.state & stateMask);
      else if (insert) {
        if (stateMask & ~3) throw Error('Unsupported ListView state');
        item.state = value & stateMask;
      } else await state(r, w, item, value, stateMask);
    }
    if (get) return 1;
    if (insert) {
      const n = Math.min(at, s.items.length);
      s.items.splice(n, 0, item);
      if (s.mark >= n) s.mark++;
      r.windows.emit(w);
      await notify(r, w, -102, n, item);
      return n;
    }
    r.windows.emit(w);
    return 1;
  }
  if (msg === 0x1008 || msg === 0x1009) {
    if (msg === 0x1008 && !s.items[index]) return 0;
    const all = msg === 0x1009,
      skip = all && (await notify(r, w, -104, -1));
    for (const item of all ? [...s.items] : [s.items[index]]) {
      const at = s.items.indexOf(item);
      if (at < 0) continue;
      if (!skip) await notify(r, w, -103, at, item);
      const current = s.items.indexOf(item);
      if (current >= 0) s.items.splice(current, 1);
    }
    s.mark = -1;
    r.windows.emit(w);
    return 1;
  }
  if (msg >= 0x1000 && msg <= 0x10ff)
    throw Error(`Unsupported ListView message 0x${msg.toString(16)}`);
  return fallback();
}
