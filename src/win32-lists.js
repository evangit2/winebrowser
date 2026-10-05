import { comboMessage, syncComboSelection, COMBO_TOGGLE, COMBO_DISMISS } from './win32-combos.js';
import {
  listMultiple,
  listItemSelected,
  maxListTop,
  listItemHeight,
  listItemY,
  revealListItem,
  updateList,
  measureListItem,
  compareListItem,
  deleteListItem,
  paintOwnerList,
} from './win32-owner-lists.js';
import { decodeAnsi, encodeAnsi } from './encoding.js';
import { dragListMessage } from './win32-draglist.js';
import { listPointerMessage } from './win32-list-pointer.js';

const USER_SELECT = 0x7fe0,
  USER_TEXT = 0x7fe1,
  USER_SCROLL = 0x7fe2;
function nativeKeyboard(w) {
  return w.controlType === 'listbox' || w.ownerDraw;
}
function list(w) {
  return (w.list ??= {
    items: [],
    selected: -1,
    caret: 0,
    anchor: -1,
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
    items: s.items.map((i, index) => ({
      id: i.id,
      text: i.text,
      selected: listItemSelected(w, index),
      height: w.ownerVariable ? listItemHeight(w, index) : undefined,
    })),
    ownerDraw: !!w.ownerDraw,
    nativeKeyboard: !!nativeKeyboard(w),
    nativePointer: w.controlType === 'listbox' && !w.dragList,
    tracking: !!s.pointer,
    wantKeyboardInput: w.controlType === 'listbox' && !!(w.style & 0x400),
    multiple: listMultiple(w),
    caret: s.caret,
    anchor: s.anchor ?? -1,
    maxTop: w.controlType === 'listbox' ? maxListTop(w) : undefined,
    selected: s.selected,
    itemHeight: s.itemHeight,
    top: s.top,
    comboType: w.comboType,
    dropped: !!w.comboDropped,
    comboTextHeight: w.comboTextHeight,
    comboHostId: w.comboHostId,
    textLimit: w.comboEditWindow?.textLimit ?? w.textLimit ?? 32767,
    selection: {
      start: (w.comboEditWindow ?? w).selectionStart ?? 0,
      end: (w.comboEditWindow ?? w).selectionEnd ?? 0,
    },
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
async function choose(r, w, index) {
  const old = list(w).selected,
    oldTop = list(w).top,
    oldCaret = list(w).caret;
  const s = list(w);
  if (index < -1 || index >= s.items.length) {
    s.selected = -1;
    if (w.comboType === 3) w.title = '';
    updateList(r, w);
    return -1;
  }
  s.selected = index;
  if (index >= 0) s.caret = index;
  if (nativeKeyboard(w)) revealListItem(w, index);
  if (w.controlType === 'combobox') w.title = s.items[index]?.text ?? '';
  r.windows.emit(w);
  if (w.comboListWindow && w.controlType === 'combobox') {
    await syncComboSelection(r, w);
    return index;
  }
  if (w.ownerDraw) {
    if (w.invalid || oldTop !== s.top) await paintOwnerList(r, w);
    else {
      if (oldCaret !== s.caret && oldCaret !== old && oldCaret >= 0)
        await paintOwnerList(r, w, 4, [oldCaret]);
      await paintOwnerList(
        r,
        w,
        2,
        [...new Set([old, index])].filter((i) => i >= 0),
      );
    }
  }
  if (w.comboHostId) {
    const combo = r.windows.windows.get(w.comboHostId);
    if (combo) await syncComboSelection(r, combo);
  }
  return index;
}
async function repaintSelection(r, w) {
  updateList(r, w);
  if (w.ownerDraw) await paintOwnerList(r, w);
}
async function multiChoose(r, w, index, flags = 0, keyboard = false, toggle = false) {
  const s = list(w);
  if (index < 0 || index >= s.items.length) return false;
  const old = s.items.map((i) => !!i.selected),
    shift = !!(flags & 4),
    ctrl = !!(flags & 8);
  const extended = !!(w.style & 0x800);
  if (!shift) s.shiftBase = null;
  if (extended && shift) {
    if ((s.anchor ?? -1) < 0) s.anchor = s.caret;
    if (!s.shiftBase) s.shiftBase = new Set(s.items.filter((i) => i.selected).map((i) => i.id));
    const low = Math.min(s.anchor, index),
      high = Math.max(s.anchor, index);
    s.items.forEach((item, i) => {
      item.selected = (i >= low && i <= high) || (ctrl && s.shiftBase.has(item.id));
    });
  } else if (toggle || (!keyboard && (!extended || ctrl))) {
    s.items[index].selected = !s.items[index].selected;
    s.anchor = index;
  } else if (extended && !ctrl) {
    s.items.forEach((item, i) => {
      item.selected = i === index;
    });
    s.anchor = index;
  } else if (!keyboard) s.anchor = index;
  s.caret = index;
  revealListItem(w, index);
  await repaintSelection(r, w);
  return s.items.some((item, i) => !!item.selected !== old[i]);
}
async function multiMessage(r, w, msg, wp, lp) {
  const s = list(w),
    index = wp | 0;
  if (msg === 0x186) return -1; // LB_SETCURSEL is single-selection only.
  if (msg === 0x188) return s.items.length ? s.caret : -1;
  if (msg === 0x187) return s.items[index] ? (s.items[index].selected ? 1 : 0) : -1;
  if (msg === 0x190) return s.items.filter((i) => i.selected).length;
  if (msg === 0x191) {
    const selected = s.items
      .map((item, i) => (item.selected ? i : -1))
      .filter((i) => i >= 0)
      .slice(0, Math.max(0, index));
    if (selected.length) r.check(lp, selected.length * 4, true);
    selected.forEach((i, offset) => r.write32(lp + offset * 4, i));
    return selected.length;
  }
  if (msg === 0x19c) {
    if (index < -1 || index >= s.items.length) {
      r.lastError = 1413;
      return -1;
    }
    s.anchor = index;
    s.shiftBase = null;
    return 0;
  }
  if (msg === 0x19d) return s.anchor ?? -1;
  if (msg === 0x185) {
    s.shiftBase = null;
    const target = lp | 0;
    if (target < -1 || target >= s.items.length) return -1;
    s.items.forEach((item, i) => {
      if (target === -1 || target === i) item.selected = !!wp;
    });
    if (wp) {
      s.anchor = target;
      if (target >= 0) {
        s.caret = target;
        revealListItem(w, target);
      }
    }
    await repaintSelection(r, w);
    return 0;
  }
  if (msg === 0x19b || msg === 0x183) {
    s.shiftBase = null;
    const first = msg === 0x19b ? lp & 0xffff : wp | 0,
      last = msg === 0x19b ? lp >>> 16 : lp | 0;
    let low = Math.min(first, last),
      high = Math.max(first, last);
    const on = msg === 0x19b ? !!wp : last >= first;
    if (msg === 0x183 && last >= first && last === -1) high = s.items.length - 1;
    low = Math.max(0, low);
    high = Math.min(s.items.length - 1, high);
    s.items.forEach((item, i) => {
      if (i >= low && i <= high) item.selected = on;
    });
    await repaintSelection(r, w);
    return 0;
  }
  return null;
}
function notify(r, w, code) {
  return r.windows.send(w.parentId, 0x111, ((code << 16) | (w.controlId & 0xffff)) >>> 0, w.id);
}
export function listInput(r, w, event) {
  const s = list(w);
  if (event.type === 'list-cancel') {
    r.windows.post(w.id, 0x1f);
    return true;
  }
  if (event.type === 'combo-toggle') {
    r.windows.post(w.id, COMBO_TOGGLE, 0, 0);
    return true;
  }
  if (event.type === 'combo-dismiss') {
    r.windows.post(w.id, COMBO_DISMISS, 0, 0);
    return true;
  }
  if (event.type === 'list-scroll') {
    if (Number.isInteger(event.top) && event.top >= 0)
      r.windows.post(w.id, USER_SCROLL, event.top, 0);
    return true;
  }
  if (event.type === 'list-select') {
    r.windows.post(
      w.id,
      USER_SELECT,
      event.index >>> 0,
      (event.shiftKey ? 4 : 0) | (event.ctrlKey ? 8 : 0),
    );
    return true;
  }
  if (event.type === 'list-text' && w.comboType !== 3 && typeof event.text === 'string') {
    const id = s.nextEvent++;
    s.pending.set(id, {
      text: event.text.slice(0, w.textLimit ?? 32767),
      start: event.start,
      end: event.end,
    });
    if (!r.windows.post(w.id, USER_TEXT, id, 0)) s.pending.delete(id);
    return true;
  }
  if (event.type === 'list-selection' && w.controlType === 'combobox' && w.comboType !== 3) {
    if (
      Number.isInteger(event.start) &&
      Number.isInteger(event.end) &&
      event.start >= 0 &&
      event.end >= event.start
    ) {
      const edit = w.comboEditWindow ?? w;
      edit.selectionStart = Math.min(edit.title.length, event.start);
      edit.selectionEnd = Math.min(edit.title.length, event.end);
    }
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
  const pointerHandled = await listPointerMessage(r, w, message, wp, lp, choose);
  if (pointerHandled !== null) return pointerHandled;
  if (listMultiple(w)) {
    const handled = await multiMessage(r, w, message, wp, lp);
    if (handled !== null) return handled;
  }
  if (listMultiple(w) && message === 0x101 && wp === 16) s.shiftBase = null;
  if (combo) {
    const handled = await comboMessage(r, w, message, wp, lp, wide);
    if (handled !== null) return handled;
  }
  if (w.ownerDraw && message === 1) {
    if (!w.ownerVariable && !w.comboHostId) s.itemHeight = await measureListItem(r, w, -1, 0);
    return 0;
  }
  if (w.ownerDraw && message === 0x82) {
    for (const [index, item] of s.items.entries()) await deleteListItem(r, w, index, item);
    s.items = [];
    return 0;
  }
  if (!combo && (message === 7 || message === 8)) {
    if (w.ownerDraw) await paintOwnerList(r, w, 4, [s.items.length ? s.caret : -1]);
    else r.windows.emit(w);
    if (w.style & 1) await notify(r, w, message === 7 ? 4 : 5);
    return 0;
  }
  if (w.ownerDraw && message === 0xa) {
    updateList(r, w);
    return 0;
  }
  if (await dragListMessage(r, w, message, wp, lp)) return 0;
  if (nativeKeyboard(w) && !combo && message === 0x102) {
    if (!r.windows.isEnabled(w.id) || !s.items.length) return 0;
    const character = wide
      ? String.fromCharCode(wp & 0xffff)
      : decodeAnsi(Uint8Array.of(wp & 0xff));
    let index = -1;
    if (w.style & 0x400) {
      index =
        (await r.windows.send(
          w.parentId,
          0x2f, // WM_CHARTOITEM: Unicode character, caret, real list HWND.
          (character.charCodeAt(0) | (s.caret << 16)) >>> 0,
          w.id,
        )) | 0;
      if (index === -2 || r.windows.windows.get(w.id) !== w) return 0;
    }
    if (index === -1 && !(w.ownerDraw && !w.hasStrings) && character.charCodeAt(0) >= 0x20) {
      const locale = { 0x409: 'en-US', 0x809: 'en-GB', 0xc0a: 'es-ES' }[s.locale ?? 0x409],
        prefix = character.toLocaleLowerCase(locale);
      for (let offset = 1; offset <= s.items.length; offset++) {
        const at = (s.caret + offset) % s.items.length,
          value = s.items[at].text.toLocaleLowerCase(locale);
        if (
          [
            value,
            ...(value.startsWith('[') ? [value.slice(1)] : []),
            ...(value.startsWith('[-') ? [value.slice(2)] : []),
          ].some((text) => text.startsWith(prefix))
        ) {
          index = at;
          break;
        }
      }
    }
    if (index < 0 || index >= s.items.length) return 0;
    if (listMultiple(w)) {
      // Character search moves the caret without toggling a multiple selection.
      // An extended list retains its anchor and selects the anchor-to-caret range.
      if (w.style & 0x800 && s.anchor >= 0) {
        const low = Math.min(s.anchor, index),
          high = Math.max(s.anchor, index);
        s.items.forEach((item, i) => {
          item.selected = i >= low && i <= high;
        });
      }
      s.shiftBase = null;
      s.caret = index;
      revealListItem(w, index);
      await repaintSelection(r, w);
    } else await choose(r, w, index);
    if (w.style & 1) await notify(r, w, 1);
    return 0;
  }
  if (nativeKeyboard(w) && !combo && message === 0x100) {
    if (!r.windows.isEnabled(w.id) || !s.items.length) return 0;
    const multiple = listMultiple(w),
      flags =
        (r.windows.keyboardState.get(16) & 0x8000 ? 4 : 0) |
        (r.windows.keyboardState.get(17) & 0x8000 ? 8 : 0);
    let index = -1;
    if (w.style & 0x400) {
      index =
        (await r.windows.send(
          w.parentId,
          0x2e, // WM_VKEYTOITEM
          ((wp & 0xffff) | (s.caret << 16)) >>> 0,
          w.id,
        )) | 0;
      if (index === -2 || r.windows.windows.get(w.id) !== w) return 0;
    }
    if (index === -1) {
      if (multiple && wp === 0x20) {
        const changed = await multiChoose(
          r,
          w,
          s.caret,
          flags,
          true,
          !(w.style & 0x800) || !!(flags & 8),
        );
        if (changed && w.style & 1) await notify(r, w, 1);
        return 0;
      }
      index = s.caret;
      if (wp === 0x28 || wp === 0x27) index++;
      else if (wp === 0x26 || wp === 0x25) index--;
      else if (wp === 0x24) index = 0;
      else if (wp === 0x23) index = s.items.length - 1;
      else if (wp === 0x22 || wp === 0x21) {
        const direction = wp === 0x22 ? 1 : -1;
        let height = 0;
        do {
          index += direction;
          height += listItemHeight(w, index);
        } while (index > 0 && index < s.items.length - 1 && height < w.height);
      } else return fallback();
      index = Math.max(0, Math.min(s.items.length - 1, index));
    }
    if (index < 0 || index >= s.items.length) return 0;
    if (multiple) {
      const changed = await multiChoose(r, w, index, flags, true);
      if (changed && w.style & 1) await notify(r, w, 1);
      return 0;
    }
    const old = s.selected;
    await choose(r, w, index);
    if (old !== index && w.style & 1) await notify(r, w, 1);
    return 0;
  }
  if (message === USER_SCROLL) {
    const top = Math.max(
      0,
      Math.min(wp, w.ownerDraw || listMultiple(w) ? maxListTop(w) : s.items.length - 1),
    );
    if (top !== s.top) {
      s.top = top;
      updateList(r, w);
    } else if (w.ownerDraw && wp !== top) r.windows.emit(w);
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
      await choose(r, w, index);
      if (w.style & 1) await notify(r, w, 1);
    }
    return 0;
  }
  if (!combo && message === 0x198) {
    // LB_GETITEMRECT follows fixed or measured row heights, including offscreen rows.
    const index = wp | 0;
    if (index < 0 || index >= s.items.length) return -1;
    const y = listItemY(w, index);
    r.check(lp, 16, true);
    [0, y, w.width, y + listItemHeight(w, index)].forEach((value, i) =>
      r.write32(lp + i * 4, value),
    );
    return 0;
  }
  if (message === USER_SELECT) {
    if (!r.windows.isEnabled(w.id)) return 0;
    const index = wp | 0;
    if (index < 0 || index >= s.items.length) return 0;
    if (listMultiple(w)) {
      const changed = await multiChoose(r, w, index, lp);
      if (changed && w.style & 1) await notify(r, w, 1);
      return 0;
    }
    if (index === s.selected) {
      if (w.comboHostId) {
        w.comboCommit = true;
        try {
          await notify(r, w, 1);
        } finally {
          w.comboCommit = false;
        }
      }
      return 0;
    }
    await choose(r, w, index);
    w.comboCommit = !!w.comboHostId;
    try {
      if (combo || w.style & 1) await notify(r, w, 1);
    } finally {
      w.comboCommit = false;
    } // CBN_SELCHANGE/LBN_SELCHANGE
    return 0;
  }
  if (message === USER_TEXT) {
    const value = s.pending.get(wp);
    s.pending.delete(wp);
    if (value === undefined) return 0;
    w.title = w.uppercase
      ? value.text.toUpperCase()
      : w.lowercase
        ? value.text.toLowerCase()
        : value.text;
    w.selectionStart = Math.min(w.title.length, Math.max(0, value.start ?? w.title.length));
    w.selectionEnd = Math.min(
      w.title.length,
      Math.max(w.selectionStart, value.end ?? w.title.length),
    );
    if (w.comboEditWindow) {
      const edit = w.comboEditWindow,
        start = w.selectionStart,
        end = w.selectionEnd;
      const bytes = edit.cls.wide ? null : encodeAnsi(w.title).bytes;
      const text = bytes ? r.allocate(bytes.length + 1) : r.allocString(w.title, true);
      if (bytes) r.data.set(bytes, text);
      try {
        await r.windows.send(edit.id, 0xc, 0, text);
      } finally {
        r.free(text);
      }
      edit.selectionStart = w.selectionStart = start;
      edit.selectionEnd = w.selectionEnd = end;
      r.windows.emit(edit);
      return 0;
    }
    s.selected = -1;
    r.windows.emit(w);
    await notify(r, w, 6);
    await notify(r, w, 5);
    return 0;
  }
  // Wine forwards these three CB messages to the embedded edit. Selection
  // fields are signed 16-bit values in CB_SETEDITSEL's LPARAM; GET returns
  // DWORD pointer values as well as the packed result. Limit applies to user
  // typing, leaving WM_SETTEXT and existing text unchanged.
  if (combo && message === 0x141) {
    if (w.comboType === 3) return 1;
    w.textLimit = Math.min(32767, wp >>> 0 || 32767);
    r.windows.emit(w);
    return 0;
  }
  if (combo && message === 0x140) {
    if (w.comboType === 3) return -1;
    const start = w.selectionStart ?? 0,
      end = w.selectionEnd ?? start;
    if (wp) {
      r.check(wp, 4, true);
      r.write32(wp, start);
    }
    if (lp) {
      r.check(lp, 4, true);
      r.write32(lp, end);
    }
    return (start | (end << 16)) >>> 0;
  }
  if (combo && message === 0x142) {
    if (w.comboType === 3) return -1;
    const start = (lp << 16) >> 16,
      end = lp >> 16,
      length = w.title.length;
    if (start === -1) w.selectionStart = w.selectionEnd = w.selectionEnd ?? 0;
    else {
      const first = Math.min(length, Math.max(0, start));
      const last = end === -1 ? length : Math.min(length, Math.max(0, end));
      w.selectionStart = Math.min(first, last);
      w.selectionEnd = Math.max(first, last);
    }
    r.windows.emit(w);
    return 0;
  }
  if (combo && message === 0xc) {
    if (w.comboType === 3) return -1;
    w.title = readText(r, lp, wide).slice(0, 32767);
    w.selectionStart = w.selectionEnd = 0;
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
    const raw = w.ownerDraw && !w.hasStrings;
    const text = raw ? '' : readText(r, lp, wide);
    if (text.length > 32767) throw Error('List control text limit exceeded');
    let at = op === 'add' ? s.items.length : index;
    if (at === -1) at = s.items.length;
    if (at < 0 || at > s.items.length) return -1;
    if (op === 'add' && w.sorted) {
      if (raw) {
        let low = 0,
          high = s.items.length;
        while (low < high) {
          const mid = (low + high) >>> 1;
          if ((await compareListItem(r, w, mid, lp)) > 0) high = mid;
          else low = mid + 1;
        }
        at = low;
      } else {
        at = s.items.findIndex(
          (i) =>
            i.text.localeCompare(
              text,
              { 0x409: 'en-US', 0x809: 'en-GB', 0xc0a: 'es-ES' }[s.locale ?? 0x409],
              { sensitivity: 'base' },
            ) > 0,
        );
        if (at < 0) at = s.items.length;
      }
    }
    const inserted = { id: s.next++, text, data: raw ? lp >>> 0 : 0 };
    s.items.splice(at, 0, inserted);
    if (w.ownerVariable) inserted.height = await measureListItem(r, w, at, lp);
    if ((s.anchor ?? -1) >= at) s.anchor++;
    if (s.selected >= at) s.selected++;
    if (s.caret >= at && s.items.length > 1) s.caret++;
    updateList(r, w);
    return at;
  }
  if (op === 'count') return s.items.length;
  if (op === 'reset') {
    for (const [index, item] of s.items.entries()) await deleteListItem(r, w, index, item);
    s.items = [];
    s.caret = 0;
    s.anchor = -1;
    s.shiftBase = null;
    s.selected = -1;
    s.top = 0;
    w.title = '';
    updateList(r, w);
    return 0;
  }
  if (op === 'delete') {
    if (!item) return -1;
    await deleteListItem(r, w, index, item);
    s.items.splice(index, 1);
    if (s.anchor === index) s.anchor = -1;
    else if (s.anchor > index) s.anchor--;
    s.caret = Math.max(0, Math.min(s.items.length - 1, s.caret - (s.caret >= index ? 1 : 0)));
    if (s.selected === index) {
      s.selected = -1;
      if (combo) w.title = '';
    } else if (s.selected > index) s.selected--;
    s.top = Math.max(0, Math.min(s.top, s.items.length - 1));
    updateList(r, w);
    return s.items.length;
  }
  if (op === 'getsel') return s.selected;
  if (op === 'setsel') return choose(r, w, index);
  if (op === 'text') {
    if (!item) return -1;
    if (w.ownerDraw && !w.hasStrings) {
      r.check(lp, 4, true);
      r.write32(lp, item.data);
      return 4;
    }
    return writeText(r, lp, item.text, wide);
  }
  if (op === 'length')
    return item
      ? w.ownerDraw && !w.hasStrings
        ? 4
        : wide
          ? item.text.length
          : encodeAnsi(item.text).bytes.length
      : -1;
  if (op === 'data') return item ? item.data : -1;
  if (op === 'setdata') {
    if (!item) return -1;
    item.data = lp;
    if (w.ownerDraw) updateList(r, w);
    return 0;
  }
  if (['find', 'findexact', 'select'].includes(op)) {
    const raw = w.ownerDraw && !w.hasStrings;
    const text = raw ? '' : readText(r, lp, wide).toLocaleLowerCase();
    let found = -1;
    for (let i = 1; i <= s.items.length; i++) {
      const at = (Math.max(-1, index) + i) % s.items.length,
        value = s.items[at].text.toLocaleLowerCase();
      if (
        raw
          ? s.items[at].data === lp >>> 0
          : op === 'findexact'
            ? value === text
            : value.startsWith(text)
      ) {
        found = at;
        break;
      }
    }
    if (op === 'select' && found >= 0) {
      if (listMultiple(w)) await multiMessage(r, w, 0x185, 1, found);
      else await choose(r, w, found);
    }
    return found;
  }
  if (op === 'gettop') return s.top;
  if (op === 'settop') {
    if (index < 0 || index >= s.items.length) return -1;
    s.top = index;
    updateList(r, w);
    return 0;
  }
  if (op === 'height') {
    if (lp < 1 || lp > 256) return -1;
    if (w.ownerVariable) {
      if (!item) return -1;
      item.height = lp;
    } else s.itemHeight = lp;
    updateList(r, w);
    return 0;
  }
  if (op === 'getheight')
    return w.ownerVariable ? (item ? listItemHeight(w, index) : -1) : s.itemHeight;
  if (!combo && message === 0x19f) return s.caret;
  if (!combo && message === 0x19e) {
    if (!item) return -1;
    s.caret = index;
    revealListItem(w, index);
    updateList(r, w);
    return 0;
  }
  if (!combo && message === 0x1a6) return s.locale ?? 0x409;
  if (!combo && message === 0x1a5) {
    const old = s.locale ?? 0x409;
    if (![0x409, 0x809, 0xc0a].includes(wp)) {
      r.lastError = 87;
      return -1;
    }
    s.locale = wp;
    return old;
  }
  if (!combo && message === 0x187) return item ? (s.selected === index ? 1 : 0) : -1; // LB_GETSEL
  if (!combo && [0x185, 0x190, 0x191].includes(message)) return -1; // multi-selection API on single-select list
  if (
    (combo && message >= 0x140 && message <= 0x164) ||
    (!combo && message >= 0x180 && message <= 0x1b3)
  )
    throw Error(`Unsupported ${combo ? 'ComboBox' : 'ListBox'} message 0x${message.toString(16)}`);
  return fallback();
}
