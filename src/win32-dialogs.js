// Dialog boxes. A classic application ships a DLGTEMPLATE resource and calls
// DialogBoxParam, which creates the dialog window and its child controls, sends
// WM_INITDIALOG to the caller's procedure, and runs a modal loop until
// EndDialog. The runtime builds an ordinary owned window so the browser desktop
// renders it and the existing control machinery drives it.
import { readPEResource } from './pe-resources.js';
import { windowFrame } from './window-frame.js';
import { createWindowFromHost, windowApis } from './win32-windows.js';

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
  if (!(bytes instanceof Uint8Array)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = offset;
  const need = (size) => {
    if (at < 0 || at + size > bytes.length) throw Error('Truncated dialog template');
  };
  const word = () => {
    need(2);
    const value = view.getUint16(at, true);
    at += 2;
    return value;
  };
  const signed = () => (word() << 16) >> 16;
  const dword = () => {
    need(4);
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const align = () => {
    at = (at + 3) & ~3;
  };
  const string = () => {
    let unit = word();
    if (unit === 0xffff) return { value: word(), ordinal: true };
    let value = '';
    while (unit) {
      value += String.fromCharCode(unit);
      unit = word();
    }
    return { value, ordinal: false };
  };
  try {
    need(4);
    const extended = view.getUint16(at, true) === 1 && view.getUint16(at + 2, true) === 0xffff;
    let style, exStyle;
    if (extended) {
      word();
      word();
      dword();
      exStyle = dword();
      style = dword();
    } else {
      style = dword();
      exStyle = dword();
    }
    const itemCount = word();
    if (itemCount > maxItems) return null;
    const x = signed(),
      y = signed(),
      cx = signed(),
      cy = signed();
    const menu = string(),
      klass = string(),
      title = string();
    let font = null;
    if (style & 0x40) {
      const size = word();
      if (extended) {
        word();
        need(2);
        at += 2;
      }
      const face = string();
      font = { value: face.value, size };
    }
    const items = [];
    for (let i = 0; i < itemCount; i++) {
      align();
      let itemStyle, itemExStyle;
      if (extended) {
        dword();
        itemExStyle = dword();
        itemStyle = dword();
      } else {
        itemStyle = dword();
        itemExStyle = dword();
      }
      const ix = signed(),
        iy = signed(),
        width = signed(),
        height = signed(),
        id = extended ? dword() : word();
      const itemClass = string(),
        text = string(),
        extra = word();
      // The standard creation-data size includes the WORD size itself.
      if (extra) {
        need(extended ? extra : Math.max(0, extra - 2));
        at += extended ? extra : Math.max(0, extra - 2);
      }
      items.push({
        style: itemStyle,
        exStyle: itemExStyle,
        id,
        className: itemClass.ordinal
          ? ({
              128: 'button',
              129: 'edit',
              130: 'static',
              131: 'listbox',
              132: 'scrollbar',
              133: 'combobox',
            }[itemClass.value] ?? String(itemClass.value))
          : String(itemClass.value),
        text: text.ordinal ? '' : text.value,
        x: ix,
        y: iy,
        width,
        height,
      });
    }
    return {
      style,
      exStyle,
      items,
      title: title.value,
      font,
      x,
      y,
      cx,
      cy,
      menu: menu.value,
      className: klass.value,
      extended,
    };
  } catch {
    return null;
  }
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
  'user32.dll!CreateDialogIndirectParamA': (r, a) => dialogBoxIndirect(r, a, false, true),
  'user32.dll!CreateDialogIndirectParamW': (r, a) => dialogBoxIndirect(r, a, true, true),
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

export async function buildDialog(r, template, owner, proc, instance, wide = false) {
  const frame = windowFrame(template.style);
  const customClass =
    template.className && ![32770, 0x8002, '#32770', '32770'].includes(template.className);
  const created = await createWindowFromHost(r, {
    className: customClass ? template.className : DIALOG_CLASS,
    title: template.title || '',
    x: template.x === 0x8000 ? 40 : dialogUnitsToPixels(template.x),
    y: template.y === 0x8000 ? 40 : dialogUnitsToPixels(template.y),
    width: Math.max(1, dialogUnitsToPixels(template.cx)) + 2 * frame.border,
    height: Math.max(1, dialogUnitsToPixels(template.cy)) + frame.title + 2 * frame.border,
    parent: owner,
    owner: true,
    style: template.style & ~0x10000000,
    exStyle: template.exStyle,
    instance,
    proc,
    wide,
  });
  if (created.error !== undefined || !created.id) return { error: created.error ?? 1407 };
  const window = r.windows.windows.get(created.id);
  window.dialogProc = proc;
  window.customDialogClass = !!customClass;
  if (window.extra.byteLength >= 8) window.extra.setUint32(4, proc, true);
  const dialog = {
    id: created.id,
    result: 0,
    finished: false,
    proc,
    initialVisible: !!(template.style & 0x10000000),
  };
  dialogState(r).byWindow.set(created.id, dialog);
  // Create the template's child controls through the same path a guest
  // CreateWindowEx takes, so every control style is honoured.
  for (const item of template.items) {
    const child = await createWindowFromHost(r, {
      className: item.className,
      title: item.text,
      x: dialogUnitsToPixels(item.x),
      y: dialogUnitsToPixels(item.y),
      width: Math.max(1, dialogUnitsToPixels(item.width)),
      height: Math.max(1, dialogUnitsToPixels(item.height)),
      parent: created.id,
      controlId: item.id,
      style: item.style | 0x10000000,
      exStyle: item.exStyle,
      instance,
      wide,
    });
    if (child.error) {
      await r.windows.destroy(created.id);
      dialogState(r).byWindow.delete(created.id);
      return { error: child.error };
    }
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
  const built = await buildDialog(r, template, owner, proc, module.base, wide);
  if (built.error) return fail(r, built.error, 5);
  return runDialog(r, built.dialog, a(4));
}

async function dialogBoxIndirect(r, a, wide, modeless = false) {
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
  const built = await buildDialog(r, template, owner, proc, r.pe.imageBase, wide);
  if (built.error) return fail(r, built.error, 5);
  if (modeless) {
    await initializeDialog(r, built.dialog, a(4), built.dialog.initialVisible);
    return ok(built.window.id, 5);
  }
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
  const built = await buildDialog(r, template, owner, a(3), module.base, wide);
  if (built.error) return fail(r, built.error, 5);
  await initializeDialog(r, built.dialog, a(4), built.dialog.initialVisible);
  // The modeless form returns the window handle immediately.
  return ok(built.window.id, 5);
}

function moduleAt(r, base) {
  return [...r.graph.modules.values()].find((m) => m.base === base) ?? null;
}

async function initializeDialog(r, dialog, param, visible = true) {
  const children = [...r.windows.windows.values()].filter(
    (w) => w.parentId === dialog.id && w.enabled && w.visible && w.style & 0x10000,
  );
  const first = children[0]?.id ?? 0;
  const focus = await r.callGuest(dialog.proc, [dialog.id, WM_INITDIALOG, first, param || 0]);
  if (dialog.finished || !r.windows.windows.has(dialog.id)) return;
  if (!visible) return;
  await windowApis['user32.dll!ShowWindow'](r, (i) => [dialog.id, 5][i]);
  if (focus && first) await r.windows.setFocus(first);
  else if (!r.windows.focus || r.windows.topLevel(r.windows.focus) !== dialog.id)
    await r.windows.setFocus(dialog.id);
}

// The modal loop. WM_INITDIALOG runs first; the procedure's return value
// decides whether the runtime focuses its default control. The loop then
// dispatches the dialog's own messages until EndDialog (or the window being
// destroyed) ends it.
async function runDialog(r, dialog, param) {
  const m = r.windows;
  const window = m.windows.get(dialog.id),
    owner = m.windows.get(window?.ownerId);
  const wasEnabled = owner?.enabled !== false;
  const previousFocus = m.focus;
  if (owner && wasEnabled) {
    owner.enabled = false;
    m.emit(owner);
    await m.send(owner.id, 0xa, 0, 0);
  }
  try {
    await initializeDialog(r, dialog, param);
    while (!dialog.finished && m.windows.has(dialog.id) && r.exitCode === null) {
      // A modal loop still dispatches posted messages for the process; only
      // user input to its disabled owner is suppressed by the window manager.
      const message = m.next(0, 0, 0, true);
      if (!message) {
        await r.threads.block(
          new Promise((resolve) => {
            m.wake = resolve;
          }),
        );
        continue;
      }
      const pointer = r.allocate(28);
      try {
        [
          message.hwnd,
          message.message,
          message.wParam,
          message.lParam,
          message.time,
          message.x,
          message.y,
        ].forEach((v, i) => r.write32(pointer + i * 4, v ?? 0));
        const handled = await windowApis['user32.dll!IsDialogMessageW'](
          r,
          (i) => [dialog.id, pointer][i],
        );
        if (!handled.result) await dispatchGuestMessage(r, message);
      } finally {
        r.free(pointer);
      }
    }
    return ok(dialog.result, 5);
  } finally {
    dialogState(r).byWindow.delete(dialog.id);
    if (m.windows.has(dialog.id)) await m.destroy(dialog.id);
    if (owner && wasEnabled && m.windows.has(owner.id)) {
      owner.enabled = true;
      m.emit(owner);
      await m.send(owner.id, 0xa, 1, 0);
      await m.setFocus(m.windows.has(previousFocus) ? previousFocus : owner.id);
    }
  }
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
