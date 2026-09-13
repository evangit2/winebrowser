import { describeGdiFont } from './win32-gdi.js';

const kinds = new Map([
  ['static', 'static'],
  ['button', 'button'],
  ['edit', 'edit'],
]);
export function builtinControlClass(name, wide) {
  const kind = kinds.get(name.toLowerCase());
  return kind ? { name: kind, controlType: kind, wide, proc: 0, extra: 0, background: 0 } : null;
}
export function controlStyle(kind, style, extended) {
  const local = style & 0xffff;
  if (extended & ~0x204) throw Error('Unsupported child-control extended style');
  if (kind === 'button' && ![0, 1].includes(local)) throw Error('Only push buttons are supported');
  if (kind === 'static' && (local & ~0x83 || (local & 3) === 3))
    throw Error('Unsupported STATIC style');
  if (kind === 'edit' && (local & ~0x883 || (local & 3) === 3))
    throw Error('Only single-line plain EDIT controls are supported');
  return {
    controlBorder: extended & 0x200 ? 2 : style & 0x800000 ? 1 : 0,
    readOnly: kind === 'edit' && !!(local & 0x800),
    noPrefix: kind === 'static' && !!(local & 0x80),
    textAlign: kind === 'button' ? 'center' : (['left', 'center', 'right'][local & 3] ?? 'left'),
    enabled: !(style & 0x08000000),
    fontHandle: 0,
    font: null,
  };
}
function command(window, notification) {
  return ((notification << 16) | (window.controlId & 0xffff)) >>> 0;
}
async function notify(r, window, notification) {
  if (r.windows.windows.has(window.parentId))
    await r.windows.send(window.parentId, 0x111, command(window, notification), window.id);
}
export async function controlMessage(r, window, message, wp, lp, fallback) {
  if (message === 0x30) {
    // WM_SETFONT
    const font = wp ? describeGdiFont(r, wp) : null;
    if (wp && !font) {
      r.lastError = 6;
      return 0;
    }
    window.fontHandle = wp;
    window.font = font;
    r.windows.emit(window);
    return 0;
  }
  if (message === 0x31) return window.fontHandle;
  if (message === 0x87)
    return window.controlType === 'edit' ? 0x89 : window.controlType === 'button' ? 0x2000 : 0x100;
  if (window.controlType === 'button' && message === 0xf5) {
    // BM_CLICK
    if (window.enabled) await notify(r, window, 0);
    return 0;
  }
  if (message === 7 || message === 8) {
    if (window.controlType === 'edit') await notify(r, window, message === 7 ? 0x100 : 0x200);
    return 0;
  }
  const value = await fallback();
  if (message === 0xc && window.controlType === 'edit' && value) {
    await notify(r, window, 0x400); // EN_UPDATE, followed by EN_CHANGE
    if (r.windows.windows.has(window.id)) await notify(r, window, 0x300);
  }
  return value;
}

// Browser input mutates control state and queues guest notifications. It never
// invokes a guest callback concurrently with the running CPU dispatcher.
export function controlInput(r, window, event) {
  if (!window.controlType || !window.enabled) return false;
  if (event.type === 'command' && window.controlType === 'button') {
    r.windows.post(window.parentId, 0x111, command(window, 0), window.id);
    return true;
  }
  if (event.type === 'text' && window.controlType === 'edit') {
    if (window.readOnly || typeof event.text !== 'string') return true;
    window.title = event.text.replace(/[\r\n]/g, '').slice(0, 32767);
    r.windows.emit(window);
    r.windows.post(window.parentId, 0x111, command(window, 0x400), window.id);
    r.windows.post(window.parentId, 0x111, command(window, 0x300), window.id);
    return true;
  }
  return false;
}
