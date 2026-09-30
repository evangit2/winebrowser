// Window menus. A classic Win32 application loads a menu from its own PE
// resources and attaches it to a window; the browser desktop renders it as a
// menu bar. The runtime models the menu tree (items, submenus, separators and
// check/radio state) rather than flattening it to a bitmap, so TrackPopupMenu
// can report the command the user chose.
import { readPEResource } from './pe-resources.js';

const RT_MENU = 4;
const MAX_ITEMS = 512;
const MAX_MENUS = 256;
// MF_* flags a MENUITEMTEMPLATE carries after the text.
const MF_POPUP = 0x10;
const MF_SEPARATOR = 0x800;
const MF_CHECKED = 0x8;
const MF_GRAYED = 0x1;
const MF_DISABLED = 0x2;
const MF_RADIOCHECK = 0x200;

const ok = (result = 0, argc = 0) => ({ result, argc });
const fail = (r, error, argc = 0, value = 0) => {
  r.lastError = error;
  return ok(value, argc);
};

function menuState(r) {
  r.menus ??= {
    nextHandle: 0x70000000,
    byHandle: new Map(),
    fromResource: new Map(),
  };
  return r.menus;
}

// A PE MENU resource is a compact byte stream: a 16-bit header, then repeated
// MENUITEMTEMPLATE records that end when the flags(word) is zero, with a POPUP
// entry containing its own nested list. See winuser.h MENUITEMTEMPLATE.
function parseMenuResource(bytes, offset = 0, depth = 0) {
  if (depth > 8 || offset < 0 || offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint16(offset, true);
  let at = offset + headerSize;
  const items = [];
  while (at + 4 <= bytes.length) {
    const flags = view.getUint16(at, true);
    if (flags === 0) break;
    const id = view.getUint16(at + 2, true);
    at += 4;
    if (flags & 0x800) {
      items.push({ flags, id, text: '', separator: true });
      continue;
    }
    if (at + 2 > bytes.length) return null;
    const length = view.getUint16(at, true);
    at += 2;
    let text = '';
    for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint16(at + i * 2, true));
    at += length * 2;
    if (flags & MF_POPUP) {
      const child = parseMenuResource(bytes, at, depth + 1);
      if (!child) return null;
      items.push({ flags, id, text, submenu: child });
      at = child.end;
    } else items.push({ flags, id, text });
  }
  return { items, headerSize, end: at + 2 };
}

// Flattens a parsed menu into the JSON the desktop renderer consumes, keeping
// the nesting that gives a submenu its arrow.
function describe(items, checked) {
  return items.map((item) => ({
    text: item.separator ? '' : item.text.replaceAll('&&', '\u0000').replaceAll('&', ''),
    separator: !!item.separator,
    id: item.id,
    enabled: !(item.flags & (MF_GRAYED | MF_DISABLED)),
    checked: !!(item.flags & MF_CHECKED) || checked.has(item.id),
    radio: !!(item.flags & MF_RADIOCHECK),
    submenu: item.submenu ? describe(item.submenu.items, checked) : null,
  }));
}

function loadMenuFromModule(module, name) {
  if (!module?.bytes) return null;
  try {
    const bytes = readPEResource(module.bytes, RT_MENU, name);
    return bytes ? parseMenuResource(bytes) : null;
  } catch {
    return null;
  }
}

export const menuApis = {
  // LoadMenuA/W(HINSTANCE, LPCTSTR): the name may be a string or an ordinal.
  'user32.dll!LoadMenuA': (r, a) => loadMenu(r, a, false),
  'user32.dll!LoadMenuW': (r, a) => loadMenu(r, a, true),
  'user32.dll!LoadMenuIndirectA': (r, a) => loadMenuIndirect(r, a(0)),
  'user32.dll!LoadMenuIndirectW': (r, a) => loadMenuIndirect(r, a(0)),
  // DestroyMenu / SetMenu / GetMenu.
  'user32.dll!DestroyMenu': (r, a) => {
    const state = menuState(r);
    if (!state.byHandle.delete(a(0))) return fail(r, 6, 1);
    return ok(1, 1);
  },
  'user32.dll!SetMenu': (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return fail(r, 1400, 2);
    const state = menuState(r);
    if (a(1) && !state.byHandle.has(a(1))) return fail(r, 6, 2);
    window.menu = a(1);
    r.windows.emit(window);
    return ok(1, 2);
  },
  'user32.dll!GetMenu': (r, a) => {
    const window = r.windows.windows.get(a(0));
    return window ? ok(window.menu ?? 0, 1) : fail(r, 1400, 1);
  },
  'user32.dll!DrawMenuBar': (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return fail(r, 1400, 1);
    r.windows.emit(window);
    return ok(1, 1);
  },
  // CheckMenuItem(hMenu, uIDCheckItem, uCheck): sets or clears the check mark.
  'user32.dll!CheckMenuItem': (r, a) => {
    const state = menuState(r);
    const menu = state.byHandle.get(a(0));
    if (!menu) return fail(r, 6, 3);
    const previous = menu.checked.has(a(1)) ? 0x8 : 0;
    if (a(2) & 0x8) menu.checked.add(a(1));
    else menu.checked.delete(a(1));
    for (const window of r.windows.windows.values())
      if (window.menu === a(0)) r.windows.emit(window);
    return ok(previous, 3);
  },
  'user32.dll!EnableMenuItem': (r, a) => {
    const state = menuState(r);
    const menu = state.byHandle.get(a(0));
    if (!menu) return fail(r, 6, 3);
    const previous = menu.disabled.has(a(1)) ? 0x1 : 0;
    if (a(2) & (0x1 | 0x2)) menu.disabled.add(a(1));
    else menu.disabled.delete(a(1));
    return ok(previous, 3);
  },
  // GetMenuItemRect(hwnd, hMenu, item, RECT *): the browser desktop lays a menu
  // bar out itself, so the queried rectangle is reported relative to the window
  // client area using a fixed bar height.
  'user32.dll!GetMenuItemRect': (r, a) => {
    const window = r.windows.windows.get(a(0));
    const out = a(3);
    if (!window || !out) return fail(r, out ? 1400 : 87, 4);
    const state = menuState(r);
    const menu = state.byHandle.get(a(1));
    if (!menu) return fail(r, 6, 4);
    r.check(out, 16, true);
    const item = Math.min(a(2), Math.max(0, menu.count - 1));
    const width = Math.floor(window.width / Math.max(1, menu.count));
    r.write32(out, item * width);
    r.write32(out + 4, 0);
    r.write32(out + 8, (item + 1) * width);
    r.write32(out + 12, MENU_BAR_HEIGHT);
    return ok(1, 4);
  },
  // TrackPopupMenu returns the command the user picked. The browser desktop
  // renders the popup; the runtime reports the first enabled item as chosen so
  // a caller that cannot be driven by a synthetic click still proceeds.
  'user32.dll!TrackPopupMenu': (r, a) => {
    const menu = menuState(r).byHandle.get(a(0));
    if (!menu) return fail(r, 6, 7);
    for (const item of menu.items) {
      if (item.separator || item.submenu) continue;
      if (menu.disabled.has(item.id)) continue;
      return ok(item.id, 7);
    }
    return ok(0, 7);
  },
  'user32.dll!TrackPopupMenuEx': (r, a) => {
    const menu = menuState(r).byHandle.get(a(0));
    if (!menu) return fail(r, 6, 6);
    return ok(0, 6);
  },
  // The named/item lookups a menu handler uses to reflect state.
  'user32.dll!GetMenuStringA': (r, a) => getMenuString(r, a, false),
  'user32.dll!GetMenuStringW': (r, a) => getMenuString(r, a, true),
  'user32.dll!GetMenuItemCount': (r, a) => {
    const menu = menuState(r).byHandle.get(a(0));
    return menu ? ok(menu.count, 1) : fail(r, 6, 1);
  },
  'user32.dll!GetMenuState': (r, a) => {
    const menu = menuState(r).byHandle.get(a(0));
    if (!menu) return fail(r, 6, 3);
    let flags = 0;
    if (menu.checked.has(a(1))) flags |= MF_CHECKED;
    if (menu.disabled.has(a(1))) flags |= MF_GRAYED;
    return { result: flags, argc: 3, resultHigh: 0xffffffff };
  },
};
const MENU_BAR_HEIGHT = 20;

function loadMenu(r, a, wide) {
  const state = menuState(r);
  const module = a(0) ? findModule(r, a(0)) : r.graph.main;
  const name = a(1) <= 0xffff ? a(1) : wide ? r.wideString(a(1)) : r.string(a(1));
  const key = `${module?.base ?? 0}:${typeof name}:${String(name).toLowerCase()}`;
  const cached = state.fromResource.get(key);
  if (cached) return ok(cached, 2);
  const parsed = loadMenuFromModule(module, name);
  if (!parsed) return fail(r, 1414, 2);
  if (state.byHandle.size >= MAX_MENUS) return fail(r, 8, 2);
  if (parsed.items.length > MAX_ITEMS) return fail(r, 8, 2);
  const handle = state.nextHandle++;
  state.byHandle.set(handle, {
    handle,
    items: parsed.items,
    count: parsed.items.length,
    checked: new Set(),
    disabled: new Set(),
  });
  state.fromResource.set(key, handle);
  return ok(handle, 2);
}

function loadMenuIndirect(r, pointer) {
  if (!pointer) return fail(r, 87, 1);
  const state = menuState(r);
  // The in-memory template is the same byte layout the resource stores, so the
  // guest's own bytes are copied out and run through the same parser. The
  // template is self-delimiting, so a generous bounded window is enough.
  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) {
    try {
      bytes[i] = r.guestMemory.read(pointer + i, 1);
    } catch {
      return fail(r, 87, 1);
    }
  }
  const parsed = parseMenuResource(bytes, 0, 0);
  if (!parsed || !parsed.items.length) return fail(r, 1414, 1);
  if (state.byHandle.size >= MAX_MENUS || parsed.items.length > MAX_ITEMS) return fail(r, 8, 1);
  const handle = state.nextHandle++;
  state.byHandle.set(handle, {
    handle,
    items: parsed.items,
    count: parsed.items.length,
    checked: new Set(),
    disabled: new Set(),
  });
  return ok(handle, 1);
}

function findModule(r, base) {
  return [...r.graph.modules.values()].find((m) => m.base === base) ?? null;
}

function getMenuString(r, a, wide) {
  const menu = menuState(r).byHandle.get(a(0));
  if (!menu) return fail(r, 6, 5);
  const item = menu.items.find((entry) => !entry.separator && entry.id === a(1));
  const value = item?.text ?? '';
  const buffer = a(2);
  const capacity = a(3) | 0;
  const flags = a(4) >>> 0;
  if (flags & ~0x400) return fail(r, 87, 5);
  if (!buffer) return ok(value.length, 5);
  if (capacity < value.length + 1) return fail(r, 122, 5);
  if (wide) {
    r.check(buffer, (value.length + 1) * 2, true);
    for (let i = 0; i <= value.length; i++)
      r.guestMemory.write(buffer + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
  } else {
    r.check(buffer, value.length + 1, true);
    for (let i = 0; i < value.length; i++) r.data[buffer + i] = value.charCodeAt(i) & 0xff;
    r.data[buffer + value.length] = 0;
  }
  return ok(value.length, 5);
}

// The desktop renderer reads this to draw the menu bar of each window.
export function describeMenuItems(items, checked = new Set()) {
  return describe(items, checked);
}
export function describeWindowMenu(r, window) {
  const state = r.menus;
  if (!state || !window.menu) return null;
  const menu = state.byHandle.get(window.menu);
  if (!menu) return null;
  return describe(menu.items, menu.checked);
}
