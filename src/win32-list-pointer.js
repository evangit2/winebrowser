import {
  listMultiple,
  listItemHeight,
  listItemY,
  revealListItem,
  updateList,
  paintOwnerList,
} from './win32-owner-lists.js';
import { showCombo } from './win32-combos.js';
import { sendWindowMessage } from './win32-window-text.js';

const SCROLL_TIMER = 2;
const alive = (r, w) => r.windows.windows.get(w.id) === w && !w.destroying;
const notify = (r, w, code) =>
  r.windows.send(w.parentId, 0x111, ((code << 16) | (w.controlId & 0xffff)) >>> 0, w.id);

function itemAt(w, x, y) {
  if (x < 0 || x >= w.width || y < 0 || y >= w.height) return -1;
  for (let i = w.list.top; i < w.list.items.length; i++) {
    const top = listItemY(w, i);
    if (y < top + listItemHeight(w, i)) return i;
    if (top >= w.height) break;
  }
  return -1;
}

async function repaint(r, w) {
  updateList(r, w);
  if (w.ownerDraw) await paintOwnerList(r, w);
}

async function move(r, w, index, choose) {
  const s = w.list;
  if (index < 0 || index >= s.items.length || index === s.caret) return false;
  if (!listMultiple(w)) await choose(r, w, index);
  else {
    if (w.style & 0x800 && s.anchor >= 0) {
      const low = Math.min(s.anchor, index),
        high = Math.max(s.anchor, index);
      s.items.forEach((item, i) => {
        item.selected = i >= low && i <= high;
      });
    }
    s.caret = index;
    revealListItem(w, index);
    await repaint(r, w);
  }
  return true;
}

async function stop(r, w, release = true) {
  if (!w.list.pointer) return;
  w.list.pointer = null;
  r.windows.killSystemTimer(w.id, SCROLL_TIMER);
  if (release && r.windows.capture === w.id) await r.windows.changeCapture(0);
  if (alive(r, w)) r.windows.emit(w);
}

async function cancelPopup(r, w, host, choose, originalId) {
  await choose(
    r,
    w,
    w.list.items.findIndex((item) => item.id === originalId),
  );
  if (originalId === undefined && host.comboEditId && alive(r, host)) {
    host.title = host.comboDropText ?? '';
    const text = r.allocString(host.title, true);
    host.comboUpdatingEdit = true;
    try {
      await sendWindowMessage(r, host.comboEditId, 0xc, 0, text, true);
    } finally {
      r.free(text);
      host.comboUpdatingEdit = false;
    }
  }
  await stop(r, w);
  if (alive(r, host)) await showCombo(r, host, false);
}

async function track(r, w, x, y, choose) {
  const s = w.list,
    pointer = s.pointer;
  if (!pointer) return;
  const direction = y < 0 ? -1 : y >= w.height ? 1 : 0;
  let index = itemAt(w, x, y);
  if (direction < 0) index = Math.max(0, s.top - 1);
  if (direction > 0) {
    index = s.top;
    while (index < s.items.length && listItemY(w, index) + listItemHeight(w, index) <= w.height)
      index++;
    if (index === s.caret) index++;
    index = Math.min(s.items.length - 1, index);
  }
  const changed = await move(r, w, index, choose);
  if (!alive(r, w) || s.pointer !== pointer) return;
  pointer.x = x;
  pointer.y = y;
  if (direction && changed) {
    if (!pointer.direction) r.windows.setSystemTimer(w.id, SCROLL_TIMER, 100);
    pointer.direction = direction;
  } else {
    pointer.direction = 0;
    r.windows.killSystemTimer(w.id, SCROLL_TIMER);
  }
}

// Window procedures own capture, selection, scrolling and notifications. DOM
// events only supply the standard signed client coordinates and MK_* flags.
export async function listPointerMessage(r, w, msg, wp, lp, choose) {
  if (w.controlType !== 'listbox' || w.dragList) return null;
  const s = w.list;
  const host = w.comboHostId ? r.windows.windows.get(w.comboHostId) : null;
  if ([8, 0x1f, 0x82, 0x184].includes(msg) || (msg === 0xa && !wp)) {
    await stop(r, w);
    if (msg === 0x1f && host?.comboDropped) await showCombo(r, host, false);
    return null;
  }
  if (msg === 0x215) {
    if (lp !== w.id) await stop(r, w, false);
    if (host && lp !== host.id && lp !== w.id) {
      host.comboPointer = false;
      host.comboButtonDown = false;
      r.windows.emit(host);
    }
    return 0;
  }
  if (![0x201, 0x200, 0x202, 0x203, 0x118].includes(msg)) return null;
  if (msg === 0x118) {
    if (wp !== SCROLL_TIMER || !s.pointer?.direction) return null;
    if (r.windows.capture !== w.id || !r.windows.isEnabled(w.id)) await stop(r, w);
    else await track(r, w, s.pointer.x, s.pointer.y, choose);
    return 0;
  }
  const x = (lp << 16) >> 16,
    y = lp >> 16;
  if (msg === 0x201) {
    if (!r.windows.isEnabled(w.id)) return 0;
    const index = itemAt(w, x, y);
    if (index < 0) {
      if (host?.comboDropped) await cancelPopup(r, w, host, choose, host.comboDropSelectionId);
      return 0;
    }
    await r.windows.setFocus(host ? host.comboEditId || host.id : w.id);
    if (!alive(r, w)) return 0;
    if (!host && w.style & 1) await r.windows.send(w.parentId, 0x131, index, lp);
    if (!alive(r, w)) return 0;
    await stop(r, w);
    await r.windows.changeCapture(w.id);
    if (!alive(r, w) || r.windows.capture !== w.id) return 0;
    s.pointer = { x, y, direction: 0, originalId: s.items[s.selected]?.id };
    s.shiftBase = null;
    if (!(wp & 4) || s.anchor < 0) s.anchor = index;
    if (!listMultiple(w)) await choose(r, w, index);
    else {
      if (!(w.style & 0x800) || wp & 8) s.items[index].selected = !s.items[index].selected;
      else {
        const low = Math.min(s.anchor, index),
          high = Math.max(s.anchor, index);
        s.items.forEach((item, i) => {
          item.selected = i >= low && i <= high;
        });
      }
      s.caret = index;
      revealListItem(w, index);
      await repaint(r, w);
    }
    if (alive(r, w)) r.windows.emit(w);
    return 0;
  }
  if (msg === 0x200) {
    if (s.pointer && r.windows.capture === w.id) await track(r, w, x, y, choose);
    else if (host?.comboDropped && host.comboType !== 1) {
      const index = itemAt(w, x, y);
      if (index >= 0) await move(r, w, index, choose);
    }
    return 0;
  }
  if (msg === 0x203) {
    if (w.style & 1 && s.items.length && r.windows.isEnabled(w.id)) await notify(r, w, 2);
    return 0;
  }
  const pointer = s.pointer;
  if (!pointer) {
    if (host?.comboDropped && itemAt(w, x, y) < 0)
      await cancelPopup(r, w, host, choose, host.comboDropSelectionId);
    return 0;
  }
  const commit = itemAt(w, x, y) >= 0;
  if (host && host.comboType !== 1 && !commit) {
    await cancelPopup(r, w, host, choose, pointer.originalId);
    return 0;
  }
  await stop(r, w);
  if (alive(r, w) && s.items.length && w.style & 1) {
    w.comboCommit = !!host;
    try {
      await notify(r, w, 1);
    } finally {
      w.comboCommit = false;
    }
  }
  return 0;
}
