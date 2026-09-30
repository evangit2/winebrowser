// Dialog boxes. A classic application ships a DLGTEMPLATE resource and calls
// DialogBoxParam, which creates the dialog window and its child controls, sends
// WM_INITDIALOG to the caller's procedure, and runs a modal loop until
// EndDialog. The runtime builds an ordinary owned window so the browser desktop
// renders it and the existing control machinery drives it.
import { readPEResource } from './pe-resources.js';
import { createWindowFromHost } from './win32-windows.js';

const RT_DIALOG = 5;
const MAX_DIALOG_ITEMS = 256;
const MAX_TEMPLATE_BYTES = 64 * 1024;
const WM_INITDIALOG = 0x110;
const WM_COMMAND = 0x111;
const WM_CLOSE = 0x10;
const WM_QUIT = 0x12;

const ok = (result = 0, argc = 0) => ({ result: result >>> 0, argc });
const fail = (r, error, argc = 0, value = 0) => {
  r.lastError = error;
  return ok(value, argc);
};

function dialogState(r) {
  r.dialogs ??= { byWindow: new Map() };
  return r.dialogs;
}

// A DLGTEMPLATE is a fixed 18-byte header followed by three variable-length
// string runs (menu, class, title), an optional point size and font face when
// DS_SETFONT is set, then DLGITEMTEMPLATE records that each begin on a DWORD
// boundary. Strings are NUL-terminated UTF-16; 0xffff introduces an ordinal.
export function readDialogTemplate(bytes, offset = 0, maxItems = MAX_DIALOG_ITEMS) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 18) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const align4 = (value) => (value + 3) & ~3;
  const readString = (at) => {
    if (at + 2 > bytes.length) return null;
    if (view.getUint16(at, true) === 0xffff) {
      if (at + 4 > bytes.length) return null;
      return { value: view.getUint16(at + 2, true), ordinal: true, at: at + 4 };
    }
    let value = '';
    let cursor = at;
    while (cursor + 2 <= bytes.length) {
      const unit = view.getUint16(cursor, true);
      cursor += 2;
      if (unit === 0) return { value, ordinal: false, at: cursor };
      value += String.fromCharCode(unit);
    }
    return null;
  };
  const style = view.getUint32(offset, true);
  const exStyle = view.getUint32(offset + 4, true);
  const itemCount = view.getInt16(offset + 8, true);
  if (itemCount < 0 || itemCount > maxItems) return null;
  const x = view.getInt16(offset + 10, true);
  const y = view.getInt16(offset + 12, true);
  const cx = view.getInt16(offset + 14, true);
  const cy = view.getInt16(offset + 16, true);
  let at = offset + 18;
  for (const field of ['menu', 'class']) {
    const value = readString(at);
    if (!value) return null;
    at = value.at;
  }
  const title = readString(at);
  if (!title) return null;
  at = title.at;
  let font = null;
  if (style & 0x40) {
    // DS_SETFONT: a 16-bit point size, then the typeface.
    if (at + 2 > bytes.length) return null;
    at += 2;
    const face = readString(at);
    if (!face) return null;
    font = { value: face.value };
    at = face.at;
  }
  const items = [];
  at = align4(at);
  for (let i = 0; i < itemCount; i++) {
    if (at + 18 > bytes.length) return null;
    const itemStyle = view.getUint32(at, true);
    const itemExStyle = view.getUint32(at + 4, true);
    const id = view.getUint16(at + 16, true);
    const geometry = {
      x: view.getInt16(at + 8, true),
      y: view.getInt16(at + 10, true),
      width: view.getInt16(at + 12, true),
      height: view.getInt16(at + 14, true),
    };
    at += 18;
    const klass = readString(at);
    if (!klass) return null;
    at = klass.at;
    const text = readString(at);
    if (!text) return null;
    at = text.at;
    if (at + 2 > bytes.length) return null;
    const extra = view.getUint16(at, true);
    at = align4(at + 2 + extra);
    items.push({
      style: itemStyle >>> 0,
      exStyle: itemExStyle >>> 0,
      id,
      className: klass.ordinal ? String(klass.value) : klass.value,
      text: text.ordinal ? '' : text.value,
      ...geometry,
    });
  }
  return { style, exStyle, items, title: title.value, font, x, y, cx, cy };
}

// The dialog renders with its own class: an owned top-level window whose client
// area holds the template's child controls.
const DIALOG_CLASS = 'winebrowser-dialog';

export const dialogApis = {
  'user32.dll!DialogBoxParamA': (r, a) => dialogBoxParam(r, a, false),
  'user32.dll!DialogBoxParamW': (r, a) => dialogBoxParam(r, a, true),
  'user32.dll!DialogBoxParam': (r, a) => dialogBoxParam(r, a, false),
  'user32.dll!DialogBoxIndirectParamA': (r, a) => dialogBoxIndirect(r, a, false),
  'user32.dll!DialogBoxIndirectParamW': (r, a) => dialogBoxIndirect(r, a, true),
  'user32.dll!CreateDialogParamA': (r, a) => createDialogParam(r, a, false),
  'user32.dll!CreateDialogParamW': (r, a) => createDialogParam(r, a, true),
  // EndDialog records the result and ends the modal loop.
  'user32.dll!EndDialog': (r, a) => {
    const dialog = dialogState(r).byWindow.get(a(0));
    if (!dialog) return fail(r, 1400, 2);
    dialog.result = a(1) | 0;
    dialog.finished = true;
    r.windows.wake?.();
    return ok(1, 2);
  },
  'user32.dll!GetDlgCtrlID': (r, a) => {
    const window = r.windows.windows.get(a(0));
    return window ? ok(window.controlId ?? 0, 1) : fail(r, 1400, 1);
  },
  'user32.dll!CheckDlgButton': (r, a) => {
    const control = findControl(r, a(0), a(1));
    if (!control || control.controlType !== 'button') return fail(r, 1400, 3);
    const state = a(2) >>> 0;
    if (state > 2) return fail(r, 87, 3);
    control.checkState = state;
    r.windows.emit(control);
    return ok(1, 3);
  },
  'user32.dll!IsDlgButtonChecked': (r, a) => {
    const control = findControl(r, a(0), a(1));
    return control?.controlType === 'button' ? ok(control.checkState ?? 0, 2) : fail(r, 1400, 2);
  },
};

function findControl(r, hwnd, id) {
  return (
    [...r.windows.windows.values()].find((w) => w.parentId === hwnd && w.controlId === id) ?? null
  );
}

// Dialog units scale with the system font. The runtime's window manager works in
// pixels, so the classic 4x8-unit base is converted with the documented ratio.
function dialogUnitsToPixels(value) {
  // One horizontal dialog unit is 1/4 of the average character width; the
  // runtime's default font averages 8 px wide and 16 px tall, so the base units
  // are 2 px horizontally and 2 px vertically.
  return Math.round((value * 8) / 4);
}

async function buildDialog(r, template, owner, proc, instance) {
  const created = await createWindowFromHost(r, {
    className: DIALOG_CLASS,
    title: template.title || '',
    x: template.x === 0x8000 ? 40 : dialogUnitsToPixels(template.x),
    y: template.y === 0x8000 ? 40 : dialogUnitsToPixels(template.y),
    width: Math.max(80, dialogUnitsToPixels(template.cx)),
    height: Math.max(40, dialogUnitsToPixels(template.cy)),
    parent: owner,
    style: template.style,
    exStyle: template.exStyle,
    instance,
    proc,
  });
  if (created.error !== undefined || !created.id) return { error: created.error ?? 1407 };
  const dialog = { id: created.id, result: 0, finished: false, proc };
  dialogState(r).byWindow.set(created.id, dialog);
  // Create the template's child controls through the same path a guest
  // CreateWindowEx takes, so every control style is honoured.
  for (const item of template.items) {
    await createWindowFromHost(r, {
      className: item.className,
      title: item.text,
      x: dialogUnitsToPixels(item.x),
      y: dialogUnitsToPixels(item.y),
      width: Math.max(1, dialogUnitsToPixels(item.width)),
      height: Math.max(1, dialogUnitsToPixels(item.height)),
      parent: created.id,
      controlId: item.id,
      style: item.style,
      exStyle: item.exStyle,
      instance,
    });
  }
  return { dialog, window: created };
}

async function dialogBoxParam(r, a, wide) {
  const module = moduleAt(r, a(0)) ?? r.graph.main;
  const name = a(1) <= 0xffff ? a(1) : wide ? r.wideString(a(1)) : r.string(a(1));
  const owner = a(2) >>> 0;
  if (owner && !r.windows.windows.has(owner)) return fail(r, 1400, 5);
  const proc = a(3);
  if (!proc) return fail(r, 87, 5);
  let template;
  try {
    const bytes = readPEResource(module.bytes, RT_DIALOG, name);
    template = bytes ? readDialogTemplate(bytes) : null;
  } catch {
    template = null;
  }
  if (!template) return fail(r, 1813, 5);
  const built = await buildDialog(r, template, owner, proc, module.base);
  if (built.error) return fail(r, built.error, 5);
  return runDialog(r, built.dialog, a(4));
}

async function dialogBoxIndirect(r, a, wide) {
  const owner = a(2) >>> 0;
  if (owner && !r.windows.windows.has(owner)) return fail(r, 1400, 5);
  const proc = a(3);
  const pointer = a(1);
  if (!proc || !pointer) return fail(r, 87, 5);
  // The in-memory template uses the same layout as the resource, so the guest's
  // own bytes are copied out and parsed the same way.
  const bytes = new Uint8Array(MAX_TEMPLATE_BYTES);
  let length = 0;
  for (; length < bytes.length; length++) {
    try {
      bytes[length] = r.guestMemory.read(pointer + length, 1);
    } catch {
      break;
    }
  }
  const template = readDialogTemplate(bytes.subarray(0, length));
  if (!template) return fail(r, 1814, 5);
  const built = await buildDialog(r, template, owner, proc, r.pe.imageBase);
  if (built.error) return fail(r, built.error, 5);
  void wide;
  return runDialog(r, built.dialog, a(4));
}

async function createDialogParam(r, a, wide) {
  const module = moduleAt(r, a(0)) ?? r.graph.main;
  const name = a(1) <= 0xffff ? a(1) : wide ? r.wideString(a(1)) : r.string(a(1));
  const owner = a(2) >>> 0;
  if (owner && !r.windows.windows.has(owner)) return fail(r, 1400, 5);
  let template;
  try {
    const bytes = readPEResource(module.bytes, RT_DIALOG, name);
    template = bytes ? readDialogTemplate(bytes) : null;
  } catch {
    template = null;
  }
  if (!template) return fail(r, 1813, 5);
  const built = await buildDialog(r, template, owner, a(3), module.base);
  if (built.error) return fail(r, built.error, 5);
  await r.callGuest(built.dialog.proc, [built.dialog.id, WM_INITDIALOG, 0, a(4) || 0]);
  // The modeless form returns the window handle immediately.
  return ok(built.window.id, 5);
}

function moduleAt(r, base) {
  return [...r.graph.modules.values()].find((m) => m.base === base) ?? null;
}

// The modal loop. WM_INITDIALOG runs first; the procedure's return value
// decides whether the runtime focuses its default control. The loop then
// dispatches the dialog's own messages until EndDialog (or the window being
// destroyed) ends it.
async function runDialog(r, dialog, param) {
  const m = r.windows;
  await r.callGuest(dialog.proc, [dialog.id, WM_INITDIALOG, 0, param || 0]);
  while (!dialog.finished && m.windows.has(dialog.id)) {
    const message = m.next(dialog.id, 0, 0, false);
    if (!message) {
      await r.threads.block(
        new Promise((resolve) => {
          m.dialogWake = resolve;
        }),
      );
      continue;
    }
    m.next(dialog.id, 0, 0, true);
    await dispatchGuestMessage(r, message);
  }
  const result = dialog.result;
  dialogState(r).byWindow.delete(dialog.id);
  if (m.windows.has(dialog.id)) await m.destroy(dialog.id);
  return ok(result, 5);
}

// Delivers one queued message the way DispatchMessage does, but without going
// through the guest message-function pointer.
async function dispatchGuestMessage(r, message) {
  if (message.message === WM_QUIT) {
    r.exitCode ??= message.wParam | 0;
    return;
  }
  await r.windows.send(message.hwnd, message.message, message.wParam, message.lParam);
}

void WM_COMMAND;
void WM_CLOSE;
