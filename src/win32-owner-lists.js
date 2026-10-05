import { comboFocused } from './win32-combos.js';
import { gdiApis, flushGdi, clearControlDrawing } from './win32-gdi.js';

export function listMultiple(w) {
  return w.controlType === 'listbox' && !!(w.style & 0x808);
}
export function listItemSelected(w, index) {
  return listMultiple(w)
    ? !!w.list.items[index]?.selected
    : index >= 0 && index === w.list.selected;
}

export function ownerListHost(r, w) {
  return w.comboHostId ? (r.windows.windows.get(w.comboHostId) ?? w) : w;
}

export function listItemHeight(w, index) {
  return w.ownerVariable ? (w.list.items[index]?.height ?? w.list.itemHeight) : w.list.itemHeight;
}
export function listItemY(w, index) {
  if (!w.ownerVariable) return (index - w.list.top) * w.list.itemHeight;
  let y = 0;
  for (let i = Math.min(index, w.list.top); i < Math.max(index, w.list.top); i++)
    y += listItemHeight(w, i);
  return index < w.list.top ? -y : y;
}
export function maxListTop(w) {
  w = w.comboListWindow ?? w;
  if (!w.ownerVariable)
    return Math.max(0, w.list.items.length - Math.max(1, Math.floor(w.height / w.list.itemHeight)));
  let remaining = w.height,
    index = w.list.items.length - 1;
  for (; index >= 0; index--) if ((remaining -= listItemHeight(w, index)) < 0) break;
  if (index < w.list.items.length - 1) index++;
  return Math.max(0, index);
}
export function revealListItem(w, index) {
  w = w.comboListWindow ?? w;
  if (index < 0) return;
  if (index < w.list.top) w.list.top = index;
  while (w.list.top < index && listItemY(w, index) + listItemHeight(w, index) > w.height)
    w.list.top++;
  w.list.top = Math.min(w.list.top, maxListTop(w));
}
export function updateList(r, w) {
  if (w.comboListWindow) {
    updateList(r, w.comboListWindow);
    r.windows.emit(w);
    if (!w.destroying) r.windows.invalidate(w, null, true);
    return;
  }
  if (w.ownerDraw || listMultiple(w) || w.comboHostId)
    w.list.top = Math.min(w.list.top, maxListTop(w));
  r.windows.emit(w);
  if (w.comboHostId) {
    const host = ownerListHost(r, w);
    r.windows.emit(host);
    if (!host.destroying) r.windows.invalidate(host, null, true);
  }
  if (w.ownerDraw && !w.destroying) r.windows.invalidate(w, null, true);
}
export async function measureListItem(r, w, index, data) {
  const host = ownerListHost(r, w);
  const p = r.allocate(24);
  try {
    [
      host.controlType === 'combobox' ? 3 : 2,
      host.controlId,
      index,
      host.controlType === 'combobox' ? host.width : 0,
      w.list.itemHeight,
      data,
    ].forEach((v, i) => r.write32(p + i * 4, v));
    await r.windows.send(host.parentId, 0x2c, host.controlId, p);
    return Math.max(1, Math.min(256, r.read32(p + 16)));
  } finally {
    r.free(p);
  }
}
export async function compareListItem(r, w, index, data) {
  const host = ownerListHost(r, w);
  const p = r.allocate(32);
  try {
    [
      host.controlType === 'combobox' ? 3 : 2,
      host.controlId,
      host.id,
      index,
      w.list.items[index].data,
      -1,
      data,
      w.list.locale ?? 0x409,
    ].forEach((v, i) => r.write32(p + i * 4, v));
    return (await r.windows.send(host.parentId, 0x39, host.controlId, p)) | 0;
  } finally {
    r.free(p);
  }
}
export async function deleteListItem(r, w, index, item) {
  if (!w.ownerDraw || item.deleting) return;
  item.deleting = true;
  const host = ownerListHost(r, w);
  const p = r.allocate(20);
  try {
    [host.controlType === 'combobox' ? 3 : 2, host.controlId, index, host.id, item.data].forEach(
      (v, i) => r.write32(p + i * 4, v),
    );
    await r.windows.send(host.parentId, 0x2d, host.controlId, p);
  } finally {
    r.free(p);
  }
}

// Each PE32 DRAWITEMSTRUCT uses the actual child HDC and client coordinates.
// Save/restore isolates callback state and bounds drawing to the visible item.
export async function paintOwnerList(r, w, action = 1, indices = null) {
  if (!w.ownerDraw || w.listPainting || w.destroying || !r.windows.windows.has(w.id)) return 0;
  const host = ownerListHost(r, w);
  w.listPainting = true;
  const top = Math.min(w.list.top, maxListTop(w));
  if (top !== w.list.top) {
    w.list.top = top;
    r.windows.emit(w);
  }
  const p = r.allocate(48);
  const call = (name, ...args) => gdiApis[name](r, (i) => args[i] >>> 0).result;
  const dc = call('user32.dll!GetDC', w.id);
  try {
    if (!dc) return 0;
    if (w.fontHandle) call('gdi32.dll!SelectObject', dc, w.fontHandle);
    if (action === 1) {
      w.invalid = null;
      w.erase = false;
      clearControlDrawing(r, w.id);
      const brush =
        (await r.windows.send(w.parentId, 0x134, dc, w.id)) ||
        call('user32.dll!GetSysColorBrush', 5);
      if (!r.windows.windows.has(w.id)) return 0;
      [0, 0, w.width, w.height].forEach((v, i) => r.write32(p + i * 4, v));
      call('user32.dll!FillRect', dc, p, brush);
    }
    const items =
      indices ?? Array.from({ length: w.list.items.length - w.list.top }, (_, i) => i + w.list.top);
    for (const index of items) {
      if (!r.windows.windows.has(w.id)) break;
      const item = w.list.items[index];
      if (!item && index !== -1) continue;
      const y = index < 0 ? 0 : listItemY(w, index),
        height = index < 0 ? w.list.itemHeight : listItemHeight(w, index);
      if (y >= w.height && !indices) break;
      if (y + height <= 0 || y >= w.height) continue;
      const saved = call('gdi32.dll!SaveDC', dc);
      if (!saved) return 0;
      try {
        call(
          'gdi32.dll!IntersectClipRect',
          dc,
          0,
          Math.max(0, y),
          w.width,
          Math.min(w.height, y + height),
        );
        [
          host.controlType === 'combobox' ? 3 : 2,
          host.controlId,
          index,
          action,
          (listItemSelected(w, index) ? 1 : 0) |
            (!r.windows.isEnabled(w.id) ? 4 : 0) |
            ((r.windows.focus === w.id ||
              (w.comboHostId && host.comboDropped && comboFocused(r, host))) &&
            index === w.list.caret
              ? 16
              : 0),
          host.id,
          dc,
          0,
          y,
          w.width,
          y + height,
          item?.data ?? 0,
        ].forEach((v, i) => r.write32(p + i * 4, v));
        await r.windows.send(host.parentId, 0x2b, host.controlId, p);
      } finally {
        call('gdi32.dll!RestoreDC', dc, saved);
      }
    }
    return 0;
  } finally {
    if (dc) call('user32.dll!ReleaseDC', w.id, dc);
    r.free(p);
    w.listPainting = false;
    flushGdi(r);
  }
}
