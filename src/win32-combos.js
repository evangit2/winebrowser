import { sendWindowMessage } from './win32-window-text.js';
import { createWindowFromHost } from './win32-windows.js';
import { gdiApis, clearControlDrawing, flushGdi } from './win32-gdi.js';
import { measureListItem, paintOwnerList, updateList } from './win32-owner-lists.js';

const COMBO_LIST_MESSAGES = new Map([
  [0x143, 0x180],
  [0x144, 0x182],
  [0x146, 0x18b],
  [0x147, 0x188],
  [0x148, 0x189],
  [0x149, 0x18a],
  [0x14a, 0x181],
  [0x14b, 0x184],
  [0x14c, 0x18f],
  [0x14d, 0x18c],
  [0x14e, 0x186],
  [0x150, 0x199],
  [0x151, 0x19a],
  [0x153, 0x1a0],
  [0x154, 0x1a1],
  [0x158, 0x1a2],
  [0x159, 0x1a5],
  [0x15a, 0x1a6],
  [0x15b, 0x18e],
  [0x15c, 0x197],
]);

export const COMBO_TOGGLE = 0x7fe3,
  COMBO_DISMISS = 0x7fe4;
const call = (r, name, ...args) => r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] >>> 0);
const gdi = (r, name, ...args) => gdiApis[name](r, (i) => args[i] >>> 0).result;
const notify = (r, w, code) =>
  r.windows.send(w.parentId, 0x111, ((code << 16) | (w.controlId & 0xffff)) >>> 0, w.id);
const alive = (r, w) => r.windows.windows.has(w.id) && !w.destroying;
export function comboFocused(r, w) {
  return r.windows.focus === w.id || r.windows.focus === w.comboEditId;
}
export function comboTextRect(w) {
  return [
    1,
    1,
    Math.max(1, w.width - (w.comboType === 1 ? 1 : 21)),
    Math.min(w.height - 1, (w.comboTextHeight ?? 20) + 1),
  ];
}

export async function layoutCombo(r, w) {
  if (w.comboLayout || !alive(r, w)) return;
  w.comboLayout = true;
  try {
    const border = w.controlBorder ?? 0,
      textHeight = w.comboTextHeight ?? 20;
    if (w.comboType !== 1 && w.height !== textHeight + 2)
      await call(
        r,
        'SetWindowPos',
        w.id,
        0,
        0,
        0,
        w.width + border * 2,
        textHeight + 2 + border * 2,
        0x16,
      );
    const rect = comboTextRect(w);
    if (w.comboEditId)
      await call(
        r,
        'SetWindowPos',
        w.comboEditId,
        0,
        rect[0],
        rect[1],
        rect[2] - rect[0],
        rect[3] - rect[1],
        0x14,
      );
    const popup = w.comboListWindow;
    if (popup) {
      const outerWidth = w.comboDroppedWidth || w.width + border * 2;
      const y = w.comboType === 1 ? textHeight + 2 : w.height + border;
      const height =
        w.comboType === 1
          ? Math.max(2, w.height - y)
          : Math.max(2, (w.comboRequestedHeight ?? 120) - (w.height + 2 * border));
      await call(
        r,
        'SetWindowPos',
        popup.id,
        0,
        w.comboType === 1 ? 0 : -border,
        y,
        outerWidth,
        height,
        0x14,
      );
      updateList(r, popup);
    }
  } finally {
    w.comboLayout = false;
  }
}

export async function initializeCombo(r, w) {
  if (w.ownerDraw) {
    // Wine measures the selected text area first, then fixed popup rows.
    w.comboTextHeight = (await measureListItem(r, w, -1, 0)) + 2;
    if (!w.ownerVariable) w.list.itemHeight = await measureListItem(r, w, 0, 0);
  } else {
    w.comboTextHeight = 20;
    w.list.itemHeight = 20;
  }
  if (!alive(r, w)) return;
  const popupStyle =
    0x40008001 |
    0x800000 |
    (w.ownerDraw ? (w.ownerVariable ? 0x20 : 0x10) : 0) |
    (w.hasStrings ? 0x40 : 0) |
    (w.sorted ? 2 : 0) |
    (w.comboType === 1 ? 0x10000000 : 0);
  const listCreated = await createWindowFromHost(r, {
    className: 'ComboLBox',
    title: 'Combo choices',
    style: popupStyle,
    parent: w.id,
    controlId: 1000,
    instance: w.instance,
    width: w.width,
    height: Math.max(2, (w.comboRequestedHeight ?? 120) - w.height),
    wide: w.cls.wide,
  });
  const listId = listCreated.id;
  w.comboListId = listId;
  w.comboListWindow = r.windows.windows.get(listId);
  if (!listId) throw Error('Unable to create native combo list');
  if (w.comboType !== 3) {
    const editCreated = await createWindowFromHost(r, {
      className: 'EDIT',
      title: w.title,
      style: 0x50000080 | (w.style & 0x2000 ? 0x8 : 0) | (w.style & 0x4000 ? 0x10 : 0),
      parent: w.id,
      controlId: 1001,
      instance: w.instance,
      width: Math.max(0, w.width - 22),
      height: Math.max(0, w.comboTextHeight),
      wide: w.cls.wide,
    });
    w.comboEditId = editCreated.id;
    w.comboEditWindow = r.windows.windows.get(w.comboEditId);
    if (!w.comboEditId) throw Error('Unable to create native combo edit');
  }
  await layoutCombo(r, w);
  r.windows.emit(w);
}

export async function syncComboSelection(r, w) {
  if (!alive(r, w)) return;
  if (w.hasStrings || w.comboType === 3) w.title = w.list.items[w.list.selected]?.text ?? '';
  if (w.comboEditId && w.hasStrings) {
    w.comboUpdatingEdit = true;
    const text = r.allocString(w.title, true);
    try {
      await sendWindowMessage(r, w.comboEditId, 0xc, 0, text, true);
    } finally {
      r.free(text);
      w.comboUpdatingEdit = false;
    }
  }
  r.windows.emit(w);
  r.windows.invalidate(w, null, true);
  if (w.comboListWindow) updateList(r, w.comboListWindow);
  await paintOwnerCombo(r, w);
}

export async function paintOwnerCombo(r, w) {
  if (!w.ownerDraw || w.comboPainting || !alive(r, w)) return 0;
  w.comboPainting = true;
  w.invalid = null;
  w.erase = false;
  clearControlDrawing(r, w.id);
  const dc = gdi(r, 'user32.dll!GetDC', w.id),
    p = r.allocate(48);
  try {
    if (!dc || w.comboType !== 3) return 0;
    if (w.fontHandle) gdi(r, 'gdi32.dll!SelectObject', dc, w.fontHandle);
    const rect = comboTextRect(w),
      selected = w.list.selected,
      item = w.list.items[selected];
    const saved = gdi(r, 'gdi32.dll!SaveDC', dc);
    if (!saved) return 0;
    try {
      gdi(r, 'gdi32.dll!IntersectClipRect', dc, ...rect);
      const brush =
        (await r.windows.send(w.parentId, 0x138, dc, w.id)) ||
        gdi(r, 'user32.dll!GetSysColorBrush', 5);
      if (!alive(r, w)) return 0;
      rect.forEach((v, i) => r.write32(p + i * 4, v));
      gdi(r, 'user32.dll!FillRect', dc, p, brush);
      [
        3,
        w.controlId,
        selected,
        1,
        0x1000 |
          (r.windows.isEnabled(w.id) ? 0 : 4) |
          (comboFocused(r, w) && !w.comboDropped ? 17 : 0),
        w.id,
        dc,
        ...rect,
        item?.data ?? 0xffffffff,
      ].forEach((v, i) => r.write32(p + i * 4, v));
      await r.windows.send(w.parentId, 0x2b, w.controlId, p);
    } finally {
      gdi(r, 'gdi32.dll!RestoreDC', dc, saved);
    }
    return 0;
  } finally {
    if (dc) gdi(r, 'user32.dll!ReleaseDC', w.id, dc);
    r.free(p);
    w.comboPainting = false;
    flushGdi(r);
  }
}

export async function showCombo(r, w, show, ok = false) {
  if (w.comboType === 1 || !alive(r, w) || show === !!w.comboDropped) return;
  if (show) {
    if (!r.windows.isEnabled(w.id)) return;
    await notify(r, w, 7); // CBN_DROPDOWN precedes the dropped state.
    if (!alive(r, w)) return;
    w.comboDropped = true;
    await layoutCombo(r, w);
    w.list.top = Math.max(0, w.list.selected);
    if (w.list.selected >= 0) w.list.caret = w.list.selected;
    await call(r, 'ShowWindow', w.comboListId, 5);
    updateList(r, w.comboListWindow);
    await paintOwnerList(r, w.comboListWindow);
  } else {
    await notify(r, w, ok ? 9 : 10); // selection end precedes hiding/close-up.
    if (!alive(r, w)) return;
    w.comboDropped = false;
    await call(r, 'ShowWindow', w.comboListId, 0);
    await notify(r, w, 8);
  }
  if (alive(r, w)) {
    r.windows.emit(w);
    await paintOwnerCombo(r, w);
  }
}

export function writeComboInfo(r, w, p) {
  if (!p || r.read32(p) < 52) {
    r.lastError = 87;
    return 0;
  }
  r.check(p, 52, true);
  const text = [
      0,
      0,
      Math.max(0, w.width - (w.comboType === 1 ? 0 : 20)),
      Math.min(w.height, (w.comboTextHeight ?? 20) + 2),
    ],
    button =
      w.comboType === 1
        ? [0, 0, 0, 0]
        : [
            Math.max(0, w.width - 20),
            0,
            w.width,
            Math.min(w.height, (w.comboTextHeight ?? 20) + 2),
          ];
  [
    ...text,
    ...button,
    w.comboType === 1 ? 0x8000 : 0,
    w.id,
    w.comboEditId ?? 0,
    w.comboListId ?? 0,
  ].forEach((v, i) => r.write32(p + 4 + i * 4, v));
  return 1;
}

export async function comboMessage(r, w, msg, wp, lp, wide) {
  if (msg === 1) {
    await initializeCombo(r, w);
    return 0;
  }
  if (msg === 0x82) return 0; // the real ComboLBox owns item deletion callbacks.
  if (msg === COMBO_TOGGLE) {
    await r.windows.setFocus(w.comboEditId || w.id);
    await showCombo(r, w, !w.comboDropped);
    return 0;
  }
  if (msg === COMBO_DISMISS) {
    await showCombo(r, w, false);
    return 0;
  }
  if (msg === 0x14) return 1;
  if (msg === 5) {
    if (!w.comboLayout && w.comboType !== 1 && w.height !== (w.comboTextHeight ?? 20) + 2)
      w.comboRequestedHeight = w.height + 2 * (w.controlBorder ?? 0);
    await layoutCombo(r, w);
    return 0;
  }
  if (msg === 0x31) return w.fontHandle;
  if (msg === 0x30) {
    for (const child of [w.comboEditId, w.comboListId])
      if (child) await r.windows.send(child, msg, wp, lp);
    await layoutCombo(r, w);
    return 0;
  }
  if (msg === 7 || msg === 8) {
    // Browser focus notifications may still be queued when a native dialog
    // returns focus to this combo. Keep the popup while one of its windows
    // actually owns focus, including its native list or edit child.
    const focused = comboFocused(r, w) || r.windows.focus === w.comboListId;
    if (msg === 8 && !focused && wp !== w.comboEditId && wp !== w.comboListId)
      await showCombo(r, w, false);
    if (msg === 7 && w.comboEditId) await r.windows.setFocus(w.comboEditId);
    if (!w.comboEditId && (msg === 7 || !focused)) await notify(r, w, msg === 7 ? 3 : 4);
    await paintOwnerCombo(r, w);
    return 0;
  }
  if (msg === 0xa) {
    if (!wp) await showCombo(r, w, false);
    for (const child of [w.comboEditId, w.comboListId])
      if (child) await call(r, 'EnableWindow', child, wp);
    await paintOwnerCombo(r, w);
    return 0;
  }
  if (msg === 0x134) return r.windows.send(w.parentId, msg, wp, lp);
  if (msg === 0x111) {
    const code = wp >>> 16;
    if (lp === w.comboEditId) {
      if (code === 0x100 || code === 0x200) {
        if (code === 0x200 && r.windows.focus === w.id) return 0;
        if (code === 0x200) await showCombo(r, w, false);
        await notify(r, w, code === 0x100 ? 3 : 4);
        return 0;
      }
      if (w.comboUpdatingEdit) return 0;
      if (code === 0x400 || code === 0x300) {
        const edit = r.windows.windows.get(lp);
        w.title = edit?.title ?? '';
        w.list.selected = -1;
        if (edit) {
          w.selectionStart = edit.selectionStart;
          w.selectionEnd = edit.selectionEnd;
        }
        r.windows.emit(w);
        await notify(r, w, code === 0x400 ? 6 : 5);
        return 0;
      }
    }
    if (lp === w.comboListId) {
      if (code === 1) {
        await syncComboSelection(r, w);
        await notify(r, w, 1);
        if (w.comboListWindow?.comboCommit) await showCombo(r, w, false, true);
      }
      if (code === 2) await notify(r, w, 2);
      return 0;
    }
  }
  if (msg === 0x100 || msg === 0x104) {
    if (wp === 0x73 || (msg === 0x104 && [0x26, 0x28].includes(wp))) {
      await showCombo(r, w, !w.comboDropped);
      return 0;
    }
    if (w.comboDropped && [0x0d, 0x1b].includes(wp)) {
      await showCombo(r, w, false, wp === 0x0d);
      return 0;
    }
    if ([0x26, 0x28, 0x21, 0x22, 0x24, 0x23].includes(wp)) {
      await r.windows.send(w.comboListId, 0x100, wp, lp);
      return 0;
    }
  }
  if (msg === 0x102 && w.comboType === 3) {
    await r.windows.send(w.comboListId, msg, wp, lp, wide);
    return 0;
  }
  if (msg === 0x157) return w.comboDropped ? 1 : 0;
  if (msg === 0x14f) {
    await showCombo(r, w, !!wp);
    return 1;
  }
  if (msg === 0x164) return writeComboInfo(r, w, lp);
  if (msg === 0x152) {
    const [x, y] = r.windows.screenPosition(w),
      width = w.comboDroppedWidth || w.width + 2 * (w.controlBorder ?? 0);
    r.check(lp, 16, true);
    [x, y, x + width, y + (w.comboRequestedHeight ?? 120)].forEach((v, i) =>
      r.write32(lp + i * 4, v),
    );
    return 0;
  }
  if (msg === 0x160) return w.comboDroppedWidth || w.width + 2 * (w.controlBorder ?? 0);
  if (msg === 0x15f) {
    if (w.comboType === 1 || wp >= 32768) return -1;
    if (wp >= w.width + 2 * (w.controlBorder ?? 0)) w.comboDroppedWidth = wp;
    else if (wp) w.comboDroppedWidth = 0;
    await layoutCombo(r, w);
    return w.comboDroppedWidth || w.width + 2 * (w.controlBorder ?? 0);
  }
  if (msg === 0x155) {
    if (w.comboType === 1) return -1;
    w.comboExtendedUI = !!wp;
    return 0;
  }
  if (msg === 0x156) return w.comboExtendedUI ? 1 : 0;
  if (msg === 0x154 && (wp | 0) < 0) return w.comboTextHeight;
  if (msg === 0x153 && (wp | 0) === -1) {
    if (lp >= 32768) return -1;
    w.comboTextHeight = lp + 2;
    await layoutCombo(r, w);
    await paintOwnerCombo(r, w);
    return lp;
  }
  if ([0xc, 0xd, 0xe].includes(msg) && w.comboEditId) {
    if (msg === 0xc) {
      w.comboUpdatingEdit = true;
      try {
        const value = await sendWindowMessage(r, w.comboEditId, msg, wp, lp, wide);
        w.title = r.windows.windows.get(w.comboEditId)?.title ?? '';
        w.list.selected = -1;
        r.windows.emit(w);
        return value;
      } finally {
        w.comboUpdatingEdit = false;
      }
    }
    return sendWindowMessage(r, w.comboEditId, msg, wp, lp, wide);
  }
  if (msg === 0x141 && w.comboEditId) {
    w.textLimit = Math.min(32767, wp >>> 0 || 32767);
    return r.windows.send(w.comboEditId, 0xc5, wp, 0);
  }
  if (msg === 0x140 && w.comboEditId) return r.windows.send(w.comboEditId, 0xb0, wp, lp);
  if (msg === 0x142 && w.comboEditId)
    return r.windows.send(w.comboEditId, 0xb1, (lp << 16) >> 16, lp >> 16);
  const listMessage = COMBO_LIST_MESSAGES.get(msg);
  if (listMessage !== undefined && w.comboListId) {
    const value = await r.windows.send(w.comboListId, listMessage, wp, lp, wide);
    if ([0x144, 0x14b].includes(msg)) await syncComboSelection(r, w);
    return msg === 0x14b ? 1 : value;
  }
  if (msg === 0x87) {
    let flags = 0x81;
    if (
      lp &&
      r.read32(lp + 4) === 0x100 &&
      w.comboDropped &&
      [0xd, 0x1b].includes(r.read32(lp + 8))
    )
      flags |= 4;
    return flags;
  }
  return null;
}
