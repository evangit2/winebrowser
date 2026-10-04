import { describeGdiFont } from './win32-gdi.js';
import { listMessage, listInput } from './win32-lists.js';
import { treeMessage, treeInput } from './win32-treeview.js';
import { tabMessage, tabInput } from './win32-tabs.js';
import { statusbarMessage } from './win32-statusbar.js';
export const EDIT_INPUT = 0x7fc0;

const kinds = new Map([
  ['static', 'static'],
  ['button', 'button'],
  ['edit', 'edit'],
  ['systreeview32', 'treeview'],
  ['listbox', 'listbox'],
  ['combobox', 'combobox'],
  ['systabcontrol32', 'tabcontrol'],
  ['msctls_statusbar32', 'statusbar'],
]);
export function builtinControlClass(name, wide) {
  const kind = kinds.get(name.toLowerCase());
  return kind
    ? {
        name: kind,
        originalName:
          {
            treeview: 'SysTreeView32',
            tabcontrol: 'SysTabControl32',
            statusbar: 'msctls_statusbar32',
          }[kind] ?? kind.toUpperCase(),
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
  // Registered classes own their low style bits. Only the client frame is
  // interpreted by the host; painting and control messages stay in the EXE/DLL.
  if (kind === 'custom') {
    if (extended & ~0x30204) throw Error('Unsupported custom child-window extended style');
    return {
      controlBorder: extended & 0x200 ? 2 : extended & 0x20000 || style & 0x800000 ? 1 : 0,
    };
  }
  const local = style & 0xffff;
  // WS_EX_STATICEDGE is a one-pixel control frame, used by native read-only
  // dialog edits. WS_EX_CLIENTEDGE retains its two-pixel inset precedence.
  if (extended & ~0x20204) throw Error('Unsupported child-control extended style');
  // BUTTON styles: BS_PUSHBUTTON (0), DEFPUSHBUTTON (1), CHECKBOX (2),
  // AUTOCHECKBOX (3), RADIOBUTTON (4), 3STATE (5), AUTO3STATE (6), GROUPBOX (7),
  // USERBUTTON (8, undocumented), AUTORADIOBUTTON (9), PUSHBOX (0xa),
  // OWNERDRAW (0xb). BS_TYPEMASK isolates the kind; the remaining bits are
  // modifiers, and BS_FLAT (0x8000) is the only one this backend honours.
  const BUTTON_TYPES = new Map([
    [0x0, 'push'],
    [0x1, 'default-push'],
    [0x2, 'checkbox'],
    [0x3, 'auto-checkbox'],
    [0x4, 'radio'],
    [0x5, 'three-state'],
    [0x6, 'auto-three-state'],
    [0x7, 'group-box'],
    [0x9, 'auto-radio'],
    [0xa, 'push-box'],
    [0xb, 'owner-draw'],
  ]);
  const buttonType = kind === 'button' ? BUTTON_TYPES.get(local & 0xf) : null;
  if (kind === 'button' && !buttonType) throw Error('Unsupported BUTTON style');
  // BS_TYPEMASK selects the kind; the remaining documented modifier bits change
  // only layout and notification, so they are honoured rather than rejected:
  // LEFT/RIGHT/CENTER (0x300), TOP/BOTTOM/VCENTER (0xc00), LEFTTEXT/RIGHTBUTTON
  // (0x20), PUSHLIKE (0x1000), MULTILINE (0x2000), NOTIFY (0x4000), FLAT
  // (0x8000), TEXT (0), ICON (0x40) and BITMAP (0x80).
  const BUTTON_MODIFIERS = 0xffe0;
  if (kind === 'button' && local & ~(0xf | BUTTON_MODIFIERS))
    throw Error('Unsupported BUTTON modifier bits');
  if (kind === 'button' && (local & 0xc0) === 0xc0)
    throw Error('BS_ICON and BS_BITMAP are mutually exclusive');
  const ownerDraw = kind === 'static' && (local & 0x1f) === 0xd;
  if (kind === 'static' && (local & ~0x29f || ![0, 1, 2, 0xc, 0xd].includes(local & 0x1f)))
    throw Error(`Unsupported STATIC style 0x${local.toString(16)}`);
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
  if (kind === 'combobox' && (![1, 2, 3].includes(local & 3) || local & ~0x6f43))
    throw Error('Unsupported ComboBox style');
  if (kind === 'listbox' && local & ~0x1c3) throw Error('Unsupported ListBox style');
  if (kind === 'treeview' && local & ~0xb7) throw Error('Unsupported TreeView style');
  if (kind === 'tabcontrol' && local & ~0xc00) throw Error('Unsupported Tab control style');
  if (kind === 'statusbar' && local & ~0x84f) throw Error('Unsupported status bar style');
  return {
    ownerDraw,
    comboType: kind === 'combobox' ? local & 3 : 0,
    sorted: kind === 'combobox' ? !!(local & 0x100) : kind === 'listbox' && !!(local & 2),
    noWordWrap: kind === 'static' && (local & 0x1f) === 0xc,
    centerImage: kind === 'static' && !!(local & 0x200),
    controlBorder: extended & 0x200 ? 2 : extended & 0x20000 || style & 0x800000 ? 1 : 0,
    // BUTTON family. The desktop uses `buttonType` to pick an element and
    // `toggle`/`triState` to decide what a click does; `checkState` is the
    // current BM_GETCHECK value.
    buttonType,
    flat: kind === 'button' && !!(local & 0x8000),
    // Layout modifiers a dialog author may rely on for appearance.
    leftText: kind === 'button' && !!(local & 0x20),
    // BS_LEFT(0x100) / BS_RIGHT(0x200) / BS_CENTER(0x300) share the 0x300
    // field: left=0x100, right=0x200, center=0x300. Push buttons default
    // to center; check/radio captions default to left. BS_TOP(0x400) / BS_BOTTOM(0x800) / BS_VCENTER(0xc00) share
    // 0xc00 with an unset field defaulting to center.
    horizontalAlign:
      kind === 'button'
        ? [
            'checkbox',
            'auto-checkbox',
            'radio',
            'auto-radio',
            'three-state',
            'auto-three-state',
          ].includes(buttonType) && !(local & 0x300)
          ? 'left'
          : ['center', 'left', 'right', 'center'][(local & 0x300) >> 8]
        : 'left',
    verticalAlign:
      kind === 'button' ? ['center', 'top', 'bottom', 'center'][(local & 0xc00) >> 10] : 'top',
    pushLike: kind === 'button' && !!(local & 0x1000),
    multilineCaption: kind === 'button' && !!(local & 0x2000),
    notify: kind === 'button' && !!(local & 0x4000),
    icon: kind === 'button' && !!(local & 0x40),
    bitmap: kind === 'button' && !!(local & 0x80),
    toggle:
      kind === 'button' &&
      ['checkbox', 'auto-checkbox', 'radio', 'auto-radio'].includes(buttonType),
    triState: kind === 'button' && ['three-state', 'auto-three-state'].includes(buttonType),
    automatic: kind === 'button' && buttonType?.startsWith('auto') === true,
    groupBox: buttonType === 'group-box',
    checkState: 0,
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

/**
 * Cycles a button's check state the way the native control does, then returns
 * whether the state changed. Only automatic buttons (and push boxes) change
 * state on their own; a manual checkbox changes state only through BM_SETCHECK,
 * so a click just notifies.
 */
function activateButton(r, window) {
  const before = window.checkState ?? 0;
  if (window.triState && window.automatic) {
    // 3-state buttons cycle unchecked -> checked -> indeterminate.
    window.checkState = (before + 1) % 3;
  } else if (window.toggle && window.automatic) {
    window.checkState = window.buttonType === 'auto-radio' ? 1 : before ? 0 : 1;
  }
  if (window.checkState !== before) r.windows.emit(window);
  return window.checkState !== before;
}

// WS_GROUP marks native dialog groups; any sibling class can start a group.
// A radio click clears both preceding and following radios in that group.
function clearRadioGroup(r, window) {
  if (window.buttonType !== 'auto-radio') return;
  const siblings = [...r.windows.windows.values()].filter(
    (other) => other.parentId === window.parentId,
  );
  siblings.sort((a, b) => b.zOrder - a.zOrder || a.id - b.id);
  const at = siblings.indexOf(window);
  let start = at,
    end = at + 1;
  while (start > 0 && !(siblings[start].style & 0x20000)) start--;
  while (end < siblings.length && !(siblings[end].style & 0x20000)) end++;
  for (const other of siblings.slice(start, end)) {
    if (
      other !== window &&
      ['radio', 'auto-radio'].includes(other.buttonType) &&
      other.checkState
    ) {
      other.checkState = 0;
      r.windows.emit(other);
    }
  }
}
export async function controlMessage(r, window, message, wp, lp, fallback, wide) {
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
    if (window.ownerDraw) r.windows.invalidate(window, null, true);
    return 0;
  }
  if (message === 0x31) return window.fontHandle;
  if (window.controlType === 'edit' && message === 0xcf) {
    // EM_SETREADONLY changes user editing, while WM_SETTEXT stays available.
    window.readOnly = !!wp;
    window.style = ((window.style & ~0x800) | (wp ? 0x800 : 0)) >>> 0;
    r.windows.emit(window);
    return 1;
  }
  if (message === 0x87)
    return window.dragList?.dragging
      ? 4
      : window.controlType === 'edit'
        ? 0x89
        : window.controlType === 'button'
          ? 0x2000
          : 0x100;
  if (window.controlType === 'button' && message === 0xf0) return window.checkState ?? 0;
  if (window.controlType === 'button' && message === 0xf1) {
    // BM_SETCHECK: the state is one of unchecked, checked or indeterminate, and
    // a two-state button cannot hold the third.
    const state = wp >>> 0;
    if (state > 2 || (state === 2 && !window.triState)) {
      if (state > 2) throw Error('Unsupported BM_SETCHECK state');
      return 0;
    }
    window.checkState = state;
    if (state) clearRadioGroup(r, window);
    r.windows.emit(window);
    return 0;
  }
  if (window.controlType === 'button' && message === 0xf5) {
    // BM_CLICK: a checked radio clears its group, then the parent is notified.
    if (window.enabled) {
      activateButton(r, window);
      if (window.checkState) clearRadioGroup(r, window);
      await notify(r, window, 0);
    }
    return 0;
  }
  if (message === 7 || message === 8) {
    if (window.controlType === 'edit') await notify(r, window, message === 7 ? 0x100 : 0x200);
    return 0;
  }
  if (window.controlType === 'treeview') return treeMessage(r, window, message, wp, lp, fallback);
  if (window.controlType === 'tabcontrol') return tabMessage(r, window, message, wp, lp, fallback);
  if (window.controlType === 'statusbar')
    return statusbarMessage(r, window, message, wp, lp, fallback, wide);
  if (['combobox', 'listbox'].includes(window.controlType))
    return listMessage(r, window, message, wp, lp, fallback, wide);
  const value = await fallback();
  if (message === 0xc && window.ownerDraw && value) r.windows.invalidate(window, null, true);
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
  if (['combobox', 'listbox'].includes(window.controlType) && listInput(r, window, event))
    return true;
  if (window.controlType === 'treeview' && treeInput(r, window, event)) return true;
  if (window.controlType === 'tabcontrol' && tabInput(r, window, event)) return true;
  if (event.type === 'command' && window.controlType === 'button') {
    if (r.windows.isControlSubclass(window)) {
      r.windows.post(window.id, 0xf5);
      return true;
    }
    // A click on an automatic button changes its state before the parent is
    // told, so a handler reading BM_GETCHECK sees the new value.
    if (window.enabled) {
      activateButton(r, window);
      if (window.checkState) clearRadioGroup(r, window);
      r.windows.post(window.parentId, 0x111, command(window, 0), window.id);
    }
    return true;
  }
  if (event.type === 'text' && window.controlType === 'edit') {
    if (window.readOnly || typeof event.text !== 'string') return true;
    const text = window.multiline ? event.text : event.text.replace(/[\r\n]/g, '');
    if (r.windows.isControlSubclass(window)) {
      window.pendingTextEvents ??= new Map();
      const id = (window.nextTextEvent = ((window.nextTextEvent ?? 0) + 1) >>> 0);
      window.pendingTextEvents.set(id, applyEditFilters(window, text).slice(0, 32767));
      r.windows.post(window.id, EDIT_INPUT, id);
      return true;
    }
    window.title = applyEditFilters(window, text).slice(0, 32767);
    r.windows.emit(window);
    r.windows.post(window.parentId, 0x111, command(window, 0x400), window.id);
    r.windows.post(window.parentId, 0x111, command(window, 0x300), window.id);
    return true;
  }
  return false;
}
