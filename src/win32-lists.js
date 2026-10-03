import { encodeAnsi } from './encoding.js';
import { dragListMessage } from './win32-draglist.js';

const USER_SELECT = 0x7fe0,
  USER_TEXT = 0x7fe1,
  USER_SCROLL = 0x7fe2;
function list(w) {
  return (w.list ??= {
    items: [],
    selected: -1,
    top: 0,
    itemHeight: 20,
    next: 1,
    pending: new Map(),
    nextEvent: 1,
  });
}
export function describeList(w) {
  if (!['listbox', 'combobox'].includes(w.controlType)) return undefined;
  const s = list(w);
  return {
    items: s.items.map((i) => ({ id: i.id, text: i.text })),
    selected: s.selected,
    itemHeight: s.itemHeight,
    top: s.top,
    comboType: w.comboType,
    tabStops: w.controlType === 'listbox' && w.style & 0x80 ? (s.tabStops ?? []) : undefined,
    drag: w.dragList
      ? { dragging: w.dragList.dragging, marker: w.dragList.marker, cursor: w.dragList.cursor }
      : undefined,
  };
}
function readText(r, p, wide) {
  return p ? (wide ? r.wideString(p) : r.string(p)) : '';
}
function writeText(r, p, text, wide, count) {
  if (count !== undefined) text = text.slice(0, Math.max(0, count - 1));
  if (wide) {
    r.check(p, (text.length + 1) * 2, true);
    for (let i = 0; i <= text.length; i++)
      r.guestMemory.write(p + i * 2, i === text.length ? 0 : text.charCodeAt(i), 2);
    return text.length;
  }
  let bytes = encodeAnsi(text).bytes;
  if (count !== undefined) bytes = bytes.subarray(0, Math.max(0, count - 1));
  r.check(p, bytes.length + 1, true);
  r.data.set(bytes, p);
  r.guestMemory.write(p + bytes.length, 0, 1);
  return bytes.length;
}
function choose(r, w, index) {
  const s = list(w);
  if (index < -1 || index >= s.items.length) {
    s.selected = -1;
    if (w.comboType === 3) w.title = '';
    r.windows.emit(w);
    return -1;
  }
  s.selected = index;
  if (w.controlType === 'combobox') w.title = s.items[index]?.text ?? '';
  r.windows.emit(w);
  return index;
}
function notify(r, w, code) {
  return r.windows.send(w.parentId, 0x111, ((code << 16) | (w.controlId & 0xffff)) >>> 0, w.id);
}
export function listInput(r, w, event) {
  const s = list(w);
  if (event.type === 'list-scroll') {
    if (Number.isInteger(event.top) && event.top >= 0)
      r.windows.post(w.id, USER_SCROLL, event.top, 0);
    return true;
  }
  if (event.type === 'list-select') {
    r.windows.post(w.id, USER_SELECT, event.index >>> 0, 0);
    return true;
  }
  if (event.type === 'list-text' && w.comboType !== 3 && typeof event.text === 'string') {
    const id = s.nextEvent++;
    s.pending.set(id, event.text.slice(0, 32767));
    if (!r.windows.post(w.id, USER_TEXT, id, 0)) s.pending.delete(id);
    return true;
  }
  return false;
}
const comboOps = new Map([
  [0x143, 'add'],
  [0x144, 'delete'],
  [0x146, 'count'],
  [0x147, 'getsel'],
  [0x148, 'text'],
  [0x149, 'length'],
  [0x14a, 'insert'],
  [0x14b, 'reset'],
  [0x14c, 'find'],
  [0x14d, 'select'],
  [0x14e, 'setsel'],
  [0x150, 'data'],
  [0x151, 'setdata'],
  [0x153, 'height'],
  [0x154, 'getheight'],
  [0x158, 'findexact'],
  [0x15b, 'gettop'],
  [0x15c, 'settop'],
]);
const listOps = new Map([
  [0x180, 'add'],
  [0x181, 'insert'],
  [0x182, 'delete'],
  [0x184, 'reset'],
  [0x186, 'setsel'],
  [0x188, 'getsel'],
  [0x189, 'text'],
  [0x18a, 'length'],
  [0x18b, 'count'],
  [0x18c, 'select'],
  [0x18e, 'gettop'],
  [0x18f, 'find'],
  [0x197, 'settop'],
  [0x199, 'data'],
  [0x19a, 'setdata'],
  [0x1a0, 'height'],
  [0x1a1, 'getheight'],
  [0x1a2, 'findexact'],
]);
export async function listMessage(r, w, message, wp, lp, fallback, wide = !!w.cls.wide) {
  const s = list(w),
    combo = w.controlType === 'combobox';
  if (await dragListMessage(r, w, message, wp, lp)) return 0;
  if (message === USER_SCROLL) {
    s.top = Math.max(0, Math.min(wp, s.items.length - 1));
    return 0;
  }
  if (!combo && w.dragList && message === 0x201) {
    const x = (lp << 16) >> 16,
      y = lp >> 16,
      index = s.top + Math.floor(y / s.itemHeight);
    if (
      x >= 0 &&
      x < w.width &&
      y >= 0 &&
      y < w.height &&
      index < s.items.length &&
      index !== s.selected
    ) {
      choose(r, w, index);
      if (w.style & 1) await notify(r, w, 1);
    }
    return 0;
  }
  if (!combo && message === 0x198) {
    // LB_GETITEMRECT for uniform-height string lists
    const index = wp | 0;
    if (index < 0 || index >= s.items.length) return -1;
    const y = (index - s.top) * s.itemHeight;
    r.check(lp, 16, true);
    [0, y, w.width, y + s.itemHeight].forEach((value, i) => r.write32(lp + i * 4, value));
    return 0;
  }
  if (message === USER_SELECT) {
    const index = wp | 0;
    if (index < 0 || index >= s.items.length) return 0;
    if (index === s.selected) return 0;
    choose(r, w, index);
    if (combo || w.style & 1) await notify(r, w, 1); // CBN_SELCHANGE/LBN_SELCHANGE
    return 0;
  }
  if (message === USER_TEXT) {
    const value = s.pending.get(wp);
    s.pending.delete(wp);
    if (value === undefined) return 0;
    w.title = w.uppercase ? value.toUpperCase() : w.lowercase ? value.toLowerCase() : value;
    s.selected = -1;
    r.windows.emit(w);
    await notify(r, w, 6);
    await notify(r, w, 5);
    return 0;
  }
  if (combo && message === 0xc) {
    if (w.comboType === 3) return -1;
    w.title = readText(r, lp, wide).slice(0, 32767);
    s.selected = -1;
    r.windows.emit(w);
    return 1;
  }
  if (combo && message === 0xe) return wide ? w.title.length : encodeAnsi(w.title).bytes.length;
  if (combo && message === 0xd) return wp ? writeText(r, lp, w.title, wide, wp) : 0;
  if (!combo && message === 0x192) {
    // LB_SETTABSTOPS, in dialog-template units
    if (!(w.style & 0x80)) {
      r.lastError = 1434;
      return 0;
    }
    if (wp > 256) return 0;
    if (wp && !lp) return 0;
    if (wp) r.check(lp, wp * 4);
    const stops = Array.from({ length: wp }, (_, i) => r.read32(lp + i * 4) | 0);
    if (stops.some((value, i) => value <= 0 || (i && value <= stops[i - 1]))) return 0;
    s.tabStops = stops;
    r.windows.emit(w);
    return 1;
  }
  const op = (combo ? comboOps : listOps).get(message),
    index = wp | 0,
    item = s.items[index];
  if (op === 'add' || op === 'insert') {
    if (s.items.length >= 4096) {
      r.lastError = 8;
      return -2;
    }
    const text = readText(r, lp, wide);
    if (text.length > 32767) throw Error('List control text limit exceeded');
    let at = op === 'add' ? s.items.length : index;
    if (at === -1) at = s.items.length;
    if (at < 0 || at > s.items.length) return -1;
    if (op === 'add' && w.sorted) {
      at = s.items.findIndex(
        (i) => i.text.localeCompare(text, undefined, { sensitivity: 'base' }) > 0,
      );
      if (at < 0) at = s.items.length;
    }
    s.items.splice(at, 0, { id: s.next++, text, data: 0 });
    if (s.selected >= at) s.selected++;
    r.windows.emit(w);
    return at;
  }
  if (op === 'count') return s.items.length;
  if (op === 'reset') {
    s.items = [];
    s.selected = -1;
    s.top = 0;
    w.title = '';
    r.windows.emit(w);
    return 0;
  }
  if (op === 'delete') {
    if (!item) return -1;
    s.items.splice(index, 1);
    if (s.selected === index) {
      s.selected = -1;
      if (combo) w.title = '';
    } else if (s.selected > index) s.selected--;
    s.top = Math.max(0, Math.min(s.top, s.items.length - 1));
    r.windows.emit(w);
    return s.items.length;
  }
  if (op === 'getsel') return s.selected;
  if (op === 'setsel') return choose(r, w, index);
  if (op === 'text') return item ? writeText(r, lp, item.text, wide) : -1;
  if (op === 'length')
    return item ? (wide ? item.text.length : encodeAnsi(item.text).bytes.length) : -1;
  if (op === 'data') return item ? item.data : -1;
  if (op === 'setdata') {
    if (!item) return -1;
    item.data = lp;
    return 0;
  }
  if (['find', 'findexact', 'select'].includes(op)) {
    const text = readText(r, lp, wide).toLocaleLowerCase();
    let found = -1;
    for (let i = 1; i <= s.items.length; i++) {
      const at = (Math.max(-1, index) + i) % s.items.length,
        value = s.items[at].text.toLocaleLowerCase();
      if (op === 'findexact' ? value === text : value.startsWith(text)) {
        found = at;
        break;
      }
    }
    if (op === 'select' && found >= 0) choose(r, w, found);
    return found;
  }
  if (op === 'gettop') return s.top;
  if (op === 'settop') {
    if (index < 0 || index >= s.items.length) return -1;
    s.top = index;
    r.windows.emit(w);
    return 0;
  }
  if (op === 'height') {
    if (lp < 1 || lp > 256) return -1;
    s.itemHeight = lp;
    r.windows.emit(w);
    return 0;
  }
  if (op === 'getheight') return s.itemHeight;
  if (!combo && message === 0x187) return item ? (s.selected === index ? 1 : 0) : -1; // LB_GETSEL
  if (!combo && [0x185, 0x190, 0x191].includes(message)) return -1; // multi-selection API on single-select list
  if (
    (combo && message >= 0x140 && message <= 0x164) ||
    (!combo && message >= 0x180 && message <= 0x1b3)
  )
    throw Error(`Unsupported ${combo ? 'ComboBox' : 'ListBox'} message 0x${message.toString(16)}`);
  return fallback();
}
