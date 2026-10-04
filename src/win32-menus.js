// Window menus. A classic Win32 application loads a menu from its own PE
// resources and attaches it to a window; the browser desktop renders it as a
// menu bar. The runtime models the menu tree (items, submenus, separators and
// check/radio state) rather than flattening it to a bitmap, so TrackPopupMenu
// can report the command the user chose.
import { readPEResource } from './pe-resources.js';
import { resizeWindowSurface } from './win32-gdi.js';
import { encodeAnsi } from './encoding.js';

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
  };
  return r.menus;
}

// Standard MENUHEADER + recursively nested MENUITEMTEMPLATE lists. Zero flags
// are a valid command item; MF_END terminates each level, and popup items omit
// the command-id WORD. Reject malformed input instead of publishing partial menus.
export function parseMenuResource(bytes, offset = 0) {
  if (!(bytes instanceof Uint8Array)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = offset,
    count = 0;
  const word = () => {
    if (at < 0 || at + 2 > bytes.length) throw Error('Truncated menu');
    const value = view.getUint16(at, true);
    at += 2;
    return value;
  };
  const string = () => {
    let text = '',
      unit;
    while ((unit = word())) text += String.fromCharCode(unit);
    return text;
  };
  const list = (depth) => {
    if (depth > 8) throw Error('Menu nesting limit');
    const items = [];
    for (;;) {
      if (++count > MAX_ITEMS) throw Error('Menu item limit');
      const raw = word(),
        flags = raw & ~0x80;
      const id = flags & MF_POPUP ? 0 : word();
      const text = string();
      const item = {
        flags,
        id,
        text,
        separator: !!(flags & MF_SEPARATOR) || (!(flags & MF_POPUP) && !id && !text),
      };
      if (flags & MF_POPUP) item.submenu = { items: list(depth + 1) };
      items.push(item);
      if (raw & 0x80) return items;
    }
  };
  try {
    if (word() !== 0) return null; // MENUEX requires its own layout.
    const extra = word();
    at += extra;
    if (at > bytes.length) return null;
    return { items: list(0), end: at };
  } catch {
    return null;
  }
}

function describe(items) {
  return items.map((item) => ({
    text: item.text,
    separator: !!item.separator,
    id: item.id,
    enabled: !(item.flags & (MF_GRAYED | MF_DISABLED)),
    checked: !!(item.flags & MF_CHECKED),
    radio: !!(item.flags & MF_RADIOCHECK),
    default: !!(item.flags & 0x1000),
    submenu: item.submenu ? describe(item.submenu.items) : null,
  }));
}

function findItem(menu, value, byPosition = false) {
  if (byPosition) return menu.items[value] ?? null;
  for (const item of menu.items) {
    if (!item.submenu && item.id === value) return item;
    const found = item.submenu && findItem(item.submenu, value);
    if (found) return found;
  }
  return null;
}
function locateItem(menu, value, byPosition) {
  if (byPosition) {
    const item = menu.items[value];
    return item ? { menu, item, index: value } : null;
  }
  for (let index = 0; index < menu.items.length; index++) {
    const item = menu.items[index];
    if (item.id === value) return { menu, item, index };
    const found = item.submenu && locateItem(item.submenu, value, false);
    if (found) return found;
  }
  return null;
}
function containsMenu(items, target, depth = 0) {
  return (
    depth > 8 ||
    items === target ||
    items.some((item) => item.submenu && containsMenu(item.submenu.items, target, depth + 1))
  );
}
function emitMenus(r) {
  for (const window of r.windows.windows.values()) if (window.menu) r.windows.emit(window);
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

// ---------------------------------------------------------------------------
// Dynamic menus. CreateMenu/CreatePopupMenu allocate an empty tree that
// AppendMenu/InsertMenu build up, which is how applications construct their
// menu bars at runtime (and how a context menu is assembled).
const MF_STRING = 0x0;
const MF_OWNERDRAW = 0x100;
const MF_BITMAP = 0x4;

function createDynamicMenu(r, popup) {
  const state = menuState(r);
  if (state.byHandle.size >= MAX_MENUS) return fail(r, 8, 0);
  const handle = state.nextHandle++;
  state.byHandle.set(handle, {
    handle,
    items: [],
    count: 0,
    checked: new Set(),
    disabled: new Set(),
    popup: !!popup,
  });
  return ok(handle, 0);
}
function readMenuText(r, pointer, wide) {
  if (!pointer) return '';
  return wide ? r.wideString(pointer) : r.string(pointer);
}
// AppendMenu/InsertMenu share one implementation: MF_BYPOSITION selects a slot
// by index, MF_BYCOMMAND by command id.
function addMenuItem(r, a, wide, insert) {
  const state = menuState(r),
    menu = state.byHandle.get(a(0));
  const argc = insert ? 5 : 4;
  if (!menu) return fail(r, 1401, argc);
  const flags = a(insert ? 2 : 1) >>> 0;
  if (flags & (MF_OWNERDRAW | MF_BITMAP)) return fail(r, 120, argc);
  const id = a(insert ? 3 : 2) >>> 0,
    data = a(insert ? 4 : 3) >>> 0;
  const entry = {
    flags: flags & ~0x400,
    id,
    text: flags & MF_SEPARATOR ? '' : readMenuText(r, data, wide),
    separator: !!(flags & MF_SEPARATOR),
  };
  if (flags & MF_POPUP) {
    const child = state.byHandle.get(id);
    if (!child) return fail(r, 1401, argc);
    // Reject cycles before serializing a menu tree.
    if (containsMenu(child.items, menu.items)) return fail(r, 87, argc);
    entry.submenu = child;
  }
  if (menu.items.length >= MAX_ITEMS) return fail(r, 8, argc);
  let index = menu.items.length;
  if (insert && a(1) !== 0xffffffff) {
    index = flags & 0x400 ? a(1) : menu.items.findIndex((i) => i.id === a(1));
    if (index < 0 || index > menu.items.length) return fail(r, 1456, argc);
  }
  menu.items.splice(index, 0, entry);
  menu.count = menu.items.length;
  emitMenus(r);
  return ok(1, argc);
}
function destroyMenuTree(state, handle) {
  const menu = state.byHandle.get(handle);
  if (!menu) return;
  state.byHandle.delete(handle);
  for (const item of menu.items)
    if (item.submenu?.handle) destroyMenuTree(state, item.submenu.handle);
}
function deleteMenuItem(r, a, destroy) {
  const menu = menuState(r).byHandle.get(a(0));
  if (!menu) return fail(r, 1401, 3);
  const index = a(2) & 0x400 ? a(1) : menu.items.findIndex((i) => i.id === a(1));
  if (index < 0 || index >= menu.items.length) return fail(r, 1456, 3);
  const [removed] = menu.items.splice(index, 1);
  if (destroy && removed.submenu?.handle) destroyMenuTree(menuState(r), removed.submenu.handle);
  menu.count = menu.items.length;
  emitMenus(r);
  return ok(1, 3);
}
function attachMenu(r, window, handle) {
  const old = !!window.menu;
  window.menu = handle;
  const difference = (Number(!!handle) - Number(old)) * MENU_BAR_HEIGHT;
  if (difference) {
    const height = Math.max(1, window.height - difference);
    resizeWindowSurface(r, window.id, window.width, height);
    window.height = height;
    r.windows.invalidate(window, null, true);
    r.windows.post(window.id, 5, 0, ((height << 16) | window.width) >>> 0);
  }
  r.windows.emit(window);
}
function getSystemMenu(r, a) {
  // The system menu is the window-menu the browser desktop draws itself, so the
  // runtime hands back a real handle it can answer further queries about.
  const window = r.windows.windows.get(a(0));
  if (!window) return fail(r, 1400, 2);
  const state = menuState(r);
  window.systemMenu ??= state.nextHandle++;
  const handle = window.systemMenu;
  if (!state.byHandle.has(handle))
    state.byHandle.set(handle, {
      handle,
      items: [
        { flags: 0, id: 0xf020, text: '&Size' },
        { flags: 0, id: 0xf030, text: '&Move' },
        { flags: 0, id: 0xf060, text: '&Close' },
      ],
      count: 3,
      checked: new Set(),
      disabled: new Set(),
      system: true,
    });
  return ok(handle, 2);
}

// PE32 MENUITEMINFO is 48 bytes (44 for the pre-hbmpItem layout). Keep
// unrequested fields intact and validate updates before mutating the menu tree.
const ITEM_TYPE = MF_RADIOCHECK | MF_SEPARATOR;
const ITEM_STATE = 3 | MF_CHECKED | 0x1000;
function itemInfo(r, pointer) {
  if (!pointer) return null;
  r.check(pointer, 4);
  const size = r.read32(pointer);
  if (size !== 44 && size !== 48) return null;
  r.check(pointer, size);
  const mask = r.read32(pointer + 4);
  if (mask & ~0x1ff || (size === 44 && mask & 0x80) || (mask & 0x10 && mask & 0x1c0)) return null;
  return { pointer, size, mask, read: (offset) => r.read32(pointer + offset) };
}
function updateItemInfo(r, a, wide, insert) {
  const root = menuState(r).byHandle.get(a(0));
  if (!root) return fail(r, 1401, 4);
  const info = itemInfo(r, a(3));
  if (!info) return fail(r, 87, 4);
  const { mask, read } = info;
  const location = locateItem(root, a(1), !!a(2));
  if (!insert && !location) return fail(r, 1456, 4);
  const menu = location?.menu ?? root;
  if (insert && menu.items.length >= MAX_ITEMS) return fail(r, 8, 4);
  const next = { ...(insert ? { flags: 0, id: 0, text: null } : location.item) };
  if (mask & 0x110) {
    const type = read(8);
    if (type & ~ITEM_TYPE) return fail(r, 120, 4);
    next.flags = (next.flags & ~ITEM_TYPE) | type;
    next.separator = !!(type & MF_SEPARATOR);
  }
  if (mask & 1) {
    const state = read(12);
    if (state & ~ITEM_STATE) return fail(r, 120, 4);
    next.flags = (next.flags & ~ITEM_STATE) | state;
  }
  if (mask & 2) next.id = read(16);
  if (mask & 4) {
    const handle = read(20),
      child = menuState(r).byHandle.get(handle);
    if (handle && !child) return fail(r, 1401, 4);
    if (child && containsMenu(child.items, menu.items)) return fail(r, 87, 4);
    next.submenu = child ?? null;
    next.flags = (next.flags & ~MF_POPUP) | (child ? MF_POPUP : 0);
  }
  if ((mask & 8 && (read(24) || read(28))) || (mask & 0x80 && read(44))) return fail(r, 120, 4); // Custom checkmark/bitmap painting needs a renderer.
  if (mask & 0x20) next.data = read(32);
  if (mask & 0x50) {
    next.text = readMenuText(r, read(36), wide);
    if (!read(36)) {
      next.flags |= MF_SEPARATOR;
      next.separator = true;
    }
  }
  if (next.text === null) {
    next.text = '';
    next.flags |= MF_SEPARATOR;
    next.separator = true;
  }
  if (insert) menu.items.splice(location?.index ?? menu.items.length, 0, next);
  else Object.assign(location.item, next);
  menu.count = menu.items.length;
  emitMenus(r);
  return ok(1, 4);
}
function queryItemInfo(r, a, wide) {
  const menu = menuState(r).byHandle.get(a(0));
  if (!menu) return fail(r, 1401, 4);
  const info = itemInfo(r, a(3));
  if (!info) return fail(r, 87, 4);
  const item = locateItem(menu, a(1), !!a(2))?.item;
  if (!item) return fail(r, 1456, 4);
  const { mask, pointer, size, read } = info;
  r.check(pointer, size, true);
  const write = (offset, value) => r.write32(pointer + offset, value);
  if (mask & 0x110) write(8, item.flags & ITEM_TYPE);
  if (mask & 1) write(12, item.flags & ITEM_STATE);
  if (mask & 2) write(16, item.id);
  write(20, mask & 4 ? (item.submenu?.handle ?? 0) : 0);
  if (mask & 8) {
    write(24, 0);
    write(28, 0);
  }
  if (mask & 0x20) write(32, item.data ?? 0);
  if (mask & 0x80) write(44, 0);
  if (mask & 0x50) {
    let buffer = read(36),
      capacity = read(40);
    if (mask & 0x10 && item.separator) {
      write(36, 0);
      buffer = 0;
      capacity = 0;
    }
    const text = item.text ?? '',
      bytes = wide ? null : encodeAnsi(text).bytes;
    const length = wide ? text.length : bytes.length;
    let copied = length;
    if (buffer && capacity) {
      copied = Math.min(length, capacity - 1);
      const width = wide ? 2 : 1;
      r.check(buffer, (copied + 1) * width, true);
      for (let i = 0; i < copied; i++)
        r.guestMemory.write(buffer + i * width, wide ? text.charCodeAt(i) : bytes[i], width);
      r.guestMemory.write(buffer + copied * width, 0, width);
    }
    write(40, copied);
  }
  return ok(1, 4);
}
function checkMenuRadioItem(r, a) {
  const root = menuState(r).byHandle.get(a(0));
  if (!root) return fail(r, 1401, 5);
  const first = a(1) >>> 0,
    last = a(2) >>> 0,
    checked = a(3) >>> 0,
    flags = a(4);
  if (flags & ~0x400 || first > last) return fail(r, 87, 5);
  // Enumerate existing IDs rather than looping over an arbitrary UINT range.
  const values = new Set();
  const collect = (menu) => {
    menu.items.forEach((item, index) => {
      values.add(flags ? index : item.id);
      if (!flags && item.submenu) collect(item.submenu);
    });
  };
  collect(root);
  let group,
    done = false;
  for (const value of [...values].filter((id) => id >= first && id <= last).sort((a, b) => a - b)) {
    const found = locateItem(root, value, !!flags);
    if (!found) continue;
    group ??= found.menu;
    if (found.menu !== group || found.item.separator) continue;
    const item = found.item;
    item.flags &= ~MF_CHECKED;
    if (value === checked) {
      item.flags |= MF_RADIOCHECK | MF_CHECKED;
      done = true;
    }
  }
  emitMenus(r);
  return ok(done ? 1 : 0, 5);
}

export const menuApis = {
  // LoadMenuA/W(HINSTANCE, LPCTSTR): the name may be a string or an ordinal.
  'user32.dll!LoadMenuA': (r, a) => loadMenu(r, a, false),
  'user32.dll!LoadMenuW': (r, a) => loadMenu(r, a, true),
  'user32.dll!LoadMenuIndirectA': (r, a) => loadMenuIndirect(r, a(0)),
  'user32.dll!LoadMenuIndirectW': (r, a) => loadMenuIndirect(r, a(0)),
  'user32.dll!CreateMenu': (r) => createDynamicMenu(r, false),
  'user32.dll!CreatePopupMenu': (r) => createDynamicMenu(r, true),
  'user32.dll!AppendMenuA': (r, a) => addMenuItem(r, a, false, false),
  'user32.dll!AppendMenuW': (r, a) => addMenuItem(r, a, true, false),
  'user32.dll!InsertMenuA': (r, a) => addMenuItem(r, a, false, true),
  'user32.dll!InsertMenuW': (r, a) => addMenuItem(r, a, true, true),
  'user32.dll!InsertMenuItemA': (r, a) => updateItemInfo(r, a, false, true),
  'user32.dll!InsertMenuItemW': (r, a) => updateItemInfo(r, a, true, true),
  'user32.dll!SetMenuItemInfoA': (r, a) => updateItemInfo(r, a, false, false),
  'user32.dll!SetMenuItemInfoW': (r, a) => updateItemInfo(r, a, true, false),
  'user32.dll!GetMenuItemInfoA': (r, a) => queryItemInfo(r, a, false),
  'user32.dll!GetMenuItemInfoW': (r, a) => queryItemInfo(r, a, true),
  'user32.dll!CheckMenuRadioItem': checkMenuRadioItem,
  'user32.dll!DeleteMenu': (r, a) => deleteMenuItem(r, a, true),
  'user32.dll!RemoveMenu': (r, a) => deleteMenuItem(r, a, false),
  'user32.dll!GetSubMenu': (r, a) => {
    const menu = menuState(r).byHandle.get(a(0));
    return menu ? ok(menu.items[a(1)]?.submenu?.handle ?? 0, 2) : fail(r, 1401, 2);
  },
  'user32.dll!GetMenuItemID': (r, a) => {
    const item = menuState(r).byHandle.get(a(0))?.items[a(1)];
    return ok(!item || item.submenu ? 0xffffffff : item.id, 2);
  },
  'user32.dll!GetSystemMenu': getSystemMenu,
  // DestroyMenu / SetMenu / GetMenu.
  'user32.dll!DestroyMenu': (r, a) => {
    const state = menuState(r);
    if (!state.byHandle.has(a(0))) return fail(r, 6, 1);
    destroyMenuTree(state, a(0));
    for (const window of r.windows.windows.values())
      if (window.menu === a(0)) attachMenu(r, window, 0);
    return ok(1, 1);
  },
  'user32.dll!SetMenu': (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return fail(r, 1400, 2);
    const state = menuState(r);
    if (a(1) && !state.byHandle.has(a(1))) return fail(r, 6, 2);
    attachMenu(r, window, a(1));
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
    const menu = menuState(r).byHandle.get(a(0));
    const item = menu && findItem(menu, a(1), !!(a(2) & 0x400));
    if (!item) return fail(r, 1456, 3, 0xffffffff);
    const previous = item.flags & MF_CHECKED;
    item.flags = (item.flags & ~MF_CHECKED) | (a(2) & MF_CHECKED);
    emitMenus(r);
    return ok(previous, 3);
  },
  'user32.dll!EnableMenuItem': (r, a) => {
    const menu = menuState(r).byHandle.get(a(0));
    const item = menu && findItem(menu, a(1), !!(a(2) & 0x400));
    if (!item) return fail(r, 1456, 3, 0xffffffff);
    const previous = item.flags & 3;
    item.flags = (item.flags & ~3) | (a(2) & 3);
    emitMenus(r);
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
  'user32.dll!TrackPopupMenu': (r, a) => trackPopup(r, a, false),
  'user32.dll!TrackPopupMenuEx': (r, a) => trackPopup(r, a, true),
  // The named/item lookups a menu handler uses to reflect state.
  'user32.dll!GetMenuStringA': (r, a) => getMenuString(r, a, false),
  'user32.dll!GetMenuStringW': (r, a) => getMenuString(r, a, true),
  'user32.dll!GetMenuItemCount': (r, a) => {
    const menu = menuState(r).byHandle.get(a(0));
    return menu ? ok(menu.count, 1) : fail(r, 6, 1);
  },
  // CheckRadioButton(hDlg, first, last, check): exactly one id in the range
  // becomes checked and the rest clear, which is what a radio group means.
  'user32.dll!CheckRadioButton': (r, a) => {
    const first = a(1) | 0,
      last = a(2) | 0,
      check = a(3) | 0;
    if (last < first) return fail(r, 87, 4);
    let changed = false;
    for (const window of r.windows.windows.values()) {
      if (window.parentId !== a(0) || window.controlType !== 'button') continue;
      const id = window.controlId ?? 0;
      if (id < first || id > last) continue;
      const next = id === check ? 1 : 0;
      if ((window.checkState ?? 0) !== next) {
        window.checkState = next;
        r.windows.emit(window);
        changed = true;
      }
    }
    if (!changed && ![...r.windows.windows.values()].some((w) => w.parentId === a(0)))
      return fail(r, 1400, 4);
    return ok(1, 4);
  },
  'user32.dll!GetMenuState': (r, a) => {
    const menu = menuState(r).byHandle.get(a(0));
    const item = menu && findItem(menu, a(1), !!(a(2) & 0x400));
    return item
      ? ok(item.flags | (item.submenu ? item.submenu.items.length << 8 : 0), 3)
      : ok(0xffffffff, 3);
  },
};
export const MENU_BAR_HEIGHT = 20;

function registerMenuTree(r, parsed, argc) {
  const state = menuState(r);
  const count = (menu) =>
    1 + menu.items.reduce((n, item) => n + (item.submenu ? count(item.submenu) : 0), 0);
  if (state.byHandle.size + count(parsed) > MAX_MENUS) return fail(r, 8, argc);
  const register = (menu, popup) => {
    menu.handle = state.nextHandle++;
    menu.count = menu.items.length;
    menu.popup = popup;
    state.byHandle.set(menu.handle, menu);
    for (const item of menu.items) if (item.submenu) register(item.submenu, true);
    return menu.handle;
  };
  return ok(register(parsed, false), argc);
}

function loadMenu(r, a, wide) {
  const module = a(0) ? findModule(r, a(0)) : r.graph.main;
  const name = a(1) <= 0xffff ? a(1) : wide ? r.wideString(a(1)) : r.string(a(1));

  const parsed = loadMenuFromModule(module, name);
  if (!parsed) return fail(r, 1414, 2);
  return registerMenuTree(r, parsed, 2);
}

function loadMenuIndirect(r, pointer) {
  if (!pointer) return fail(r, 87, 1);
  // The in-memory template is the same byte layout the resource stores, so the
  // guest's own bytes are copied out and run through the same parser. The
  // template is self-delimiting, so a generous bounded window is enough.
  const bytes = new Uint8Array(4096);
  let length = 0;
  for (; length < bytes.length; length++) {
    try {
      bytes[length] = r.guestMemory.read(pointer + length, 1);
    } catch {
      break;
    }
  }
  const parsed = parseMenuResource(bytes.subarray(0, length));
  if (!parsed || !parsed.items.length) return fail(r, 1414, 1);
  return registerMenuTree(r, parsed, 1);
}

function findModule(r, base) {
  return [...r.graph.modules.values()].find((m) => m.base === base) ?? null;
}

function getMenuString(r, a, wide) {
  const menu = menuState(r).byHandle.get(a(0));
  if (!menu) return fail(r, 6, 5);
  const item = findItem(menu, a(1), !!(a(4) & 0x400));
  let value = item?.text ?? '';
  const buffer = a(2);
  const capacity = a(3) | 0;
  const flags = a(4) >>> 0;
  if (flags & ~0x400) return fail(r, 87, 5);
  if (!buffer) return ok(value.length, 5);
  if (capacity <= 0) return ok(0, 5);
  value = value.slice(0, capacity - 1);
  if (wide) {
    r.check(buffer, (value.length + 1) * 2, true);
    for (let i = 0; i <= value.length; i++)
      r.guestMemory.write(buffer + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
  } else {
    const bytes = encodeAnsi(value).bytes;
    r.check(buffer, bytes.length + 1, true);
    r.data.set(bytes, buffer);
    r.data[buffer + bytes.length] = 0;
  }
  return ok(value.length, 5);
}

// The desktop renderer reads this to draw the menu bar of each window.
export function describeMenuItems(items, checked = new Set()) {
  return describe(items);
}
export function describeWindowMenu(r, window) {
  const state = r.menus;
  if (!state || !window.menu) return null;
  const menu = state.byHandle.get(window.menu);
  if (!menu) return null;
  return describe(menu.items);
}

export function loadClassMenu(r, instance, name, wide) {
  let pointer = name;
  if (typeof name === 'string') pointer = r.allocString(name, wide);
  try {
    return loadMenu(r, (i) => [instance, pointer][i], wide).result;
  } finally {
    if (typeof name === 'string') r.free(pointer);
  }
}
export function menuCommandAllowed(r, window, id) {
  const menu = r.menus?.byHandle.get(window.menu);
  const item = menu && findItem(menu, id);
  return !!item && !item.separator && !item.submenu && !(item.flags & 3);
}

async function trackPopup(r, a, extended) {
  const argc = extended ? 6 : 7,
    handle = a(0),
    flags = a(1),
    owner = a(extended ? 4 : 5);
  const menu = menuState(r).byHandle.get(handle);
  if (!menu) return fail(r, 1401, argc);
  const window = r.windows.windows.get(owner);
  if (!window) return fail(r, 1400, argc);
  // Left/top aligned textual menus, both mouse buttons, explicit return-command
  // and non-notify modes. Exclusion rectangles/alignment styles need layout support.
  if ((!extended && a(4)) || flags & ~0x182 || (extended ? a(5) : a(6))) return fail(r, 120, argc);
  await r.windows.send(owner, 0x211, 1, 0);
  try {
    await r.windows.send(owner, 0x117, handle, 0);
    const selected = await r.request('popup-menu', {
      owner,
      x: a(2) | 0,
      y: a(3) | 0,
      items: describe(menu.items),
    });
    const item = findItem(menu, selected >>> 0);
    const command =
      selected && item && !item.separator && !item.submenu && !(item.flags & 3)
        ? selected >>> 0
        : 0;
    if (!(flags & 0x180) && command) r.windows.post(owner, 0x111, command, 0);
    return ok(flags & 0x100 ? command : command ? 1 : 0, argc);
  } finally {
    await r.windows.send(owner, 0x212, 1, 0);
  }
}
