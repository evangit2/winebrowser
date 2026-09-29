import { describeGdiFont } from './win32-gdi.js';

const kinds = new Map([
  ['static', 'static'],
  ['button', 'button'],
  ['edit', 'edit'],
]);
export function builtinControlClass(name, wide) {
  const kind = kinds.get(name.toLowerCase());
  return kind
    ? {
        name: kind,
        controlType: kind,
        wide,
        proc: 0,
        extra: 0,
        background: 0,
        cursor: kind === 'edit' ? 32513 : 32512,
      }
    : null;
}
export function controlStyle(kind, style, extended) {
  const local = style & 0xffff;
  if (extended & ~0x204) throw Error('Unsupported child-control extended style');
  if (kind === 'button' && ![0, 1].includes(local)) throw Error('Only push buttons are supported');
  if (kind === 'static' && (local & ~0x83 || (local & 3) === 3))
    throw Error('Unsupported STATIC style');
  // EDIT styles: ES_LEFT/CENTER/RIGHT (0x3), MULTILINE (0x4), UPPERCASE (0x8),
  // LOWERCASE (0x10), PASSWORD (0x20), AUTOVSCROLL (0x40), AUTOHSCROLL (0x80),
  // NOHIDESEL (0x100), READONLY (0x800), WANTRETURN (0x1000), NUMBER (0x2000).
  const EDIT_STYLES = 0x3bff;
  if (kind === 'edit') {
    if (local & ~EDIT_STYLES) throw Error('Unsupported EDIT control style');
    if ((local & 3) === 3) throw Error('ES_LEFT, ES_CENTER and ES_RIGHT are mutually exclusive');
    // A password field is always single line, and a number field is a plain
    // single-line box; the OS rejects both combinations.
    if (local & 0x20 && local & (0x4 | 0x1000)) throw Error('ES_PASSWORD requires single line');
    if (local & 0x2000 && local & 0x4 && local & 0x1000)
      throw Error('ES_NUMBER with multiline requires ES_AUTOHSCROLL');
  }
  return {
    controlBorder: extended & 0x200 ? 2 : style & 0x800000 ? 1 : 0,
    readOnly: kind === 'edit' && !!(local & 0x800),
    noPrefix: kind === 'static' && !!(local & 0x80),
    textAlign: kind === 'button' ? 'center' : (['left', 'center', 'right'][local & 3] ?? 'left'),
    enabled: !(style & 0x08000000),
    fontHandle: 0,
    font: null,
    // EDIT attributes. Multiline is the one that changes which browser element
    // is used, so the desktop needs it explicitly.
    multiline: kind === 'edit' && !!(local & 0x4),
    password: kind === 'edit' && !!(local & 0x20),
    uppercase: kind === 'edit' && !!(local & 0x8),
    lowercase: kind === 'edit' && !!(local & 0x10),
    number: kind === 'edit' && !!(local & 0x2000),
    autoVScroll: kind === 'edit' && !!(local & 0x40),
    autoHScroll: kind === 'edit' && !!(local & 0x80),
    wantReturn: kind === 'edit' && !!(local & 0x1000),
    verticalScroll: kind === 'edit' && !!(style & 0x00200000),
    horizontalScroll: kind === 'edit' && !!(style & 0x00100000),
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

// ES_UPPERCASE / ES_LOWERCASE / ES_NUMBER rewrite typed text the way the real
// edit control does, so a guest reading the window text back sees the filtered
// value rather than the raw keystrokes.
function applyEditFilters(window, text) {
  if (window.uppercase) text = text.toUpperCase();
  if (window.lowercase) text = text.toLowerCase();
  if (window.number) text = text.replace(/[^0-9-]/g, '');
  return text;
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
    const text = window.multiline ? event.text : event.text.replace(/[\r\n]/g, '');
    window.title = applyEditFilters(window, text).slice(0, 32767);
    r.windows.emit(window);
    r.windows.post(window.parentId, 0x111, command(window, 0x400), window.id);
    r.windows.post(window.parentId, 0x111, command(window, 0x300), window.id);
    return true;
  }
  return false;
}
