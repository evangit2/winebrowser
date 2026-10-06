import { showCombo } from './win32-combos.js';

const alive = (r, w) => !!w && r.windows.windows.get(w.id) === w && !w.destroying;

// The host combo owns an arrow press until the pointer enters its actual
// ComboLBox. Browser capture only transports events; HWND capture selects
// the procedure and performs the client-coordinate conversion.
export async function comboPointerMessage(r, w, msg, wp, lp) {
  if (w.comboType === 1) return null;
  if (msg === 0x1f) {
    await showCombo(r, w, false);
    return 0;
  }
  if (msg === 0x215) {
    if (lp !== w.comboListId) {
      w.comboPointer = false;
      w.comboButtonDown = false;
      r.windows.emit(w);
    }
    return 0;
  }
  if (![0x201, 0x200, 0x202].includes(msg)) return null;
  const x = (lp << 16) >> 16,
    y = lp >> 16;
  if (msg === 0x201) {
    if (!r.windows.isEnabled(w.id) || x < 0 || y < 0 || x >= w.width || y >= w.height) return 1;
    if (w.comboType === 2 && x < w.width - 20) return 1;
    await r.windows.setFocus(w.comboEditId || w.id);
    if (!alive(r, w)) return 1;
    if (w.comboDropped) await showCombo(r, w, false);
    else {
      w.comboPointer = true;
      w.comboButtonDown = true;
      await r.windows.changeCapture(w.id);
      if (alive(r, w) && r.windows.capture === w.id) await showCombo(r, w, true);
    }
    if (alive(r, w)) r.windows.emit(w);
    return 1;
  }
  if (!w.comboPointer || r.windows.capture !== w.id) return 1;
  if (msg === 0x202) {
    w.comboPointer = false;
    w.comboButtonDown = false;
    if (w.comboDropped) await r.windows.changeCapture(w.comboListId);
    else await r.windows.changeCapture(0);
    if (alive(r, w)) r.windows.emit(w);
    return 1;
  }
  if (x < w.width - 20 || x >= w.width || y < 0 || y >= w.height) w.comboButtonDown = false;
  const popup = w.comboListWindow;
  if (w.comboDropped && alive(r, popup)) {
    const hostOrigin = r.windows.clientPosition(w),
      listOrigin = r.windows.clientPosition(popup),
      listX = x + hostOrigin[0] - listOrigin[0],
      listY = y + hostOrigin[1] - listOrigin[1];
    if (listX >= 0 && listY >= 0 && listX < popup.width && listY < popup.height) {
      w.comboButtonDown = false;
      await r.windows.changeCapture(popup.id);
      if (alive(r, popup) && r.windows.capture === popup.id)
        await r.windows.send(popup.id, 0x201, wp, ((listY << 16) | (listX & 0xffff)) >>> 0);
    }
  }
  if (alive(r, w)) r.windows.emit(w);
  return 1;
}
