// COMCTL32 drag-list contracts. Mouse messages are queued by the desktop;
// registered parent notifications execute on the guest GUI dispatcher.
const BEGIN = 0x485,
  DRAGGING = 0x486,
  DROPPED = 0x487,
  CANCEL = 0x488,
  TIMER = 666;
const result = (value, argc) => ({ result: value >>> 0, argc });
const timer = (r, w, start) =>
  r.apiProvider.get(`user32.dll!${start ? 'SetTimer' : 'KillTimer'}`)(
    r,
    (i) => [w.id, TIMER, 200, 0][i],
  );

function end(r, w) {
  timer(r, w, false);
  if (r.windows.capture === w.id) r.windows.capture = 0;
  w.dragList.dragging = false;
  w.dragList.marker = -1;
  w.dragList.cursor = 0;
  r.windows.emit(w);
}
async function notify(r, w, code, point) {
  const p = r.allocate(16);
  try {
    [code, w.id, point.x, point.y].forEach((v, i) => r.write32(p + i * 4, v));
    return await r.windows.send(w.parentId, w.dragList.message, w.controlId, p);
  } finally {
    r.free(p);
  }
}

export async function dragListMessage(r, w, msg, wp, lp) {
  const drag = w.dragList;
  if (!drag) return false;
  const origin = r.windows.clientPosition(w),
    point =
      msg >= 0x200 && msg <= 0x209
        ? { x: origin[0] + ((lp << 16) >> 16), y: origin[1] + (lp >> 16) }
        : { ...r.windows.pointer };
  if (msg === 0x201) {
    if (drag.dragging) end(r, w);
    const accepted = await notify(r, w, BEGIN, point);
    if (accepted && r.windows.windows.has(w.id)) {
      drag.dragging = true;
      r.windows.capture = w.id;
      timer(r, w, true);
      r.windows.emit(w);
    }
    return false; // normal list selection follows DL_BEGINDRAG
  }
  if (drag.dragging && (msg === 0x200 || (msg === 0x113 && wp === TIMER))) {
    const cursor = await notify(r, w, DRAGGING, point);
    if (r.windows.windows.has(w.id) && drag.dragging) {
      drag.cursor = [1, 2, 3].includes(cursor) ? cursor : 0;
      r.windows.emit(w);
    }
    return true;
  }
  if (drag.dragging && msg === 0x202) {
    end(r, w);
    await notify(r, w, DROPPED, point);
    return true;
  }
  if (
    drag.dragging &&
    (msg === 0x204 ||
      (msg === 0x100 && wp === 27) ||
      msg === 0x1f ||
      (msg === 0x215 && lp !== w.id))
  ) {
    end(r, w);
    await notify(r, w, CANCEL, point);
    return true;
  }
  if (msg === 0x82) end(r, w);
  return false;
}

export const dragListApis = {
  'comctl32.dll!MakeDragList': (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 1);
    if (w.controlType !== 'listbox') return r.windows.fail(87, 1);
    w.dragList ??= {
      message: r.windows.registerWindowMessage('commctrl_DragListMsg'),
      dragging: false,
      marker: -1,
      cursor: 0,
      lastScroll: -Infinity,
    };
    r.windows.emit(w);
    return result(1, 1);
  },
  'comctl32.dll!LBItemFromPt': (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 4, -1);
    if (w.controlType !== 'listbox') return r.windows.fail(87, 4, -1);
    const s = w.list,
      origin = r.windows.clientPosition(w),
      x = (a(1) | 0) - origin[0],
      y = (a(2) | 0) - origin[1];
    if (x < 0 || x >= w.width) return result(-1, 4);
    if (y >= 0 && y < w.height) {
      const index = s.top + Math.floor(y / s.itemHeight);
      return result(index < s.items.length ? index : -1, 4);
    }
    if (a(3)) {
      const now = performance.now(),
        last = w.dragList?.lastScroll ?? w.lastListScroll ?? -Infinity;
      if (now - last >= 200) {
        const maximum = Math.max(
          0,
          s.items.length - Math.max(1, Math.floor(w.height / s.itemHeight)),
        );
        s.top = Math.max(0, Math.min(maximum, s.top + (y < 0 ? -1 : 1)));
        if (w.dragList) w.dragList.lastScroll = now;
        else w.lastListScroll = now;
        r.windows.emit(w);
      }
    }
    return result(-1, 4);
  },
  'comctl32.dll!DrawInsert': (r, a) => {
    const parent = r.windows.windows.get(a(0)),
      w = r.windows.windows.get(a(1)),
      index = a(2) | 0;
    if (!parent || !w) return r.windows.fail(1400, 3);
    if (w.parentId !== parent.id || !w.dragList) return r.windows.fail(87, 3);
    if (index >= w.list.items.length) return result(0, 3);
    const marker = index < 0 ? -1 : index;
    if (w.dragList.marker !== marker) {
      w.dragList.marker = marker;
      r.windows.emit(w);
    }
    return result(0, 3);
  },
};
