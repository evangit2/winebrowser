import { buildDialog, initializeDialog, readDialogTemplate, runDialog } from './win32-dialogs.js';
import { createWindowFromHost, registerHostWindowProcedure, windowApis } from './win32-windows.js';
import { readPEResource } from './pe-resources.js';

// PE32 PROPSHEETHEADER V1 is 40 bytes; PROPSHEETPAGE V1 is 40 bytes.
// Pages retain copied descriptors and templates, and are instantiated lazily.
const APPLY = 0x3021,
  TAB = 0x3020;
const ok = (value = 0, argc = 1) => ({ result: value >>> 0, argc });
const fail = (r, code = 87, value = 0) => {
  r.lastError = code;
  return ok(value);
};
class PropertySheetFailure extends Error {
  constructor(message, code = 87) {
    super(message);
    this.code = code;
  }
}
const state = (r) => (r.propertySheets ??= { pages: new Map(), next: 0x73000000 });
const text = (r, p, wide) => (p ? (wide ? r.wideString(p) : r.string(p)) : '');
const moduleAt = (r, base) => [...r.graph.modules.values()].find((m) => m.base === base);
const child = (r, id, control) =>
  [...r.windows.windows.values()].find((w) => w.parentId === id && w.controlId === control);

async function pageCallback(r, page, message) {
  if (page.callback) return r.callGuest(page.callback, [0, message, page.pointer]);
  return 1;
}
async function createPage(r, pointer, wide) {
  if (!pointer) return fail(r);
  r.check(pointer, 40);
  const size = r.read32(pointer),
    flags = r.read32(pointer + 4);
  if (![40, 48, 52, 56].includes(size)) return fail(r);
  // Icons, help, wizard headers, activation contexts and RTL require providers.
  if (flags & ~(1 | 8 | 0x40 | 0x80 | 0x400)) return fail(r, 120);
  r.check(pointer, size);
  const instance = r.read32(pointer + 8),
    resource = r.read32(pointer + 12),
    proc = r.read32(pointer + 24);
  if (!resource || !proc) return fail(r);
  let template;
  if (flags & 1) {
    const bytes = new Uint8Array(65536);
    let length = 0;
    for (; length < bytes.length; length++) {
      try {
        bytes[length] = r.guestMemory.read(resource + length, 1);
      } catch {
        break;
      }
    }
    template = readDialogTemplate(bytes.subarray(0, length));
  } else {
    const name = resource <= 0xffff ? resource : text(r, resource, wide);
    const module = moduleAt(r, instance || r.pe.imageBase);
    const bytes = module ? readPEResource(module.bytes, 5, name) : null;
    template = bytes ? readDialogTemplate(bytes) : null;
  }
  if (!template) return fail(r, 1813);
  const titlePointer = flags & 8 ? r.read32(pointer + 20) : 0;
  if (titlePointer && titlePointer <= 0xffff) return fail(r, 120);
  const copy = r.allocate(size),
    allocations = [copy];
  r.data.set(r.data.slice(pointer, pointer + size), copy);
  // Copy pointed-to descriptor strings so a stack descriptor is safe to release.
  for (const offset of [12, 20]) {
    if ((offset === 12 && flags & 1) || (offset === 20 && !(flags & 8))) continue;
    const p = r.read32(copy + offset);
    if (p > 0xffff) {
      const owned = r.allocString(text(r, p, wide), wide);
      allocations.push(owned);
      r.write32(copy + offset, owned);
    }
  }
  const ref = flags & 0x40 ? r.read32(copy + 36) : 0;
  if (ref) r.check(ref, 4, true);
  const page = {
    handle: state(r).next++,
    pointer: copy,
    allocations,
    flags,
    instance,
    resourceId: flags & 1 ? 0 : resource <= 0xffff ? resource : text(r, resource, wide),
    template,
    title: flags & 8 ? text(r, titlePointer, wide) : template.title,
    proc,
    callback: flags & 0x80 ? r.read32(copy + 32) : 0,
    ref,
    wide,
    hwnd: 0,
    sheet: 0,
    dirty: false,
  };
  if (ref) r.write32(ref, r.read32(ref) + 1);
  state(r).pages.set(page.handle, page);
  try {
    await pageCallback(r, page, 0); // PSPCB_ADDREF
  } catch (error) {
    state(r).pages.delete(page.handle);
    if (ref) r.write32(ref, r.read32(ref) - 1);
    for (const p of allocations) r.free(p);
    throw error;
  }
  return ok(page.handle);
}
async function releasePage(r, page) {
  if (!state(r).pages.delete(page.handle)) return;
  try {
    await pageCallback(r, page, 1);
  } finally {
    if (page.ref) r.write32(page.ref, r.read32(page.ref) - 1);
    for (const p of page.allocations) r.free(p);
    if (page.hwnd) r.dialogs?.byWindow.delete(page.hwnd);
  }
}
async function ensurePage(r, sheet, index) {
  const page = sheet.pages[index];
  if (!page) return null;
  if (page.hwnd && r.windows.windows.has(page.hwnd)) return page;
  await pageCallback(r, page, 2); // PSPCB_CREATE (Wine ignores the return value)
  const template = {
    ...page.template,
    x: 8,
    y: 24,
    style: (page.template.style & ~0x98cc0080) | 0x40010400,
    exStyle: (page.template.exStyle & ~0x100) | 0x10000,
  };
  const built = await buildDialog(
    r,
    template,
    sheet.id,
    page.proc,
    page.instance || r.pe.imageBase,
    page.wide,
    true,
  );
  if (built.error) {
    r.lastError = built.error;
    return null;
  }
  page.hwnd = built.dialog.id;
  // Property pages sit above the tab control's body, as sibling native windows.
  await windowApis['user32.dll!SetWindowPos'](r, (i) => [page.hwnd, 0, 0, 0, 0, 0, 0x13][i]);
  await initializeDialog(r, built.dialog, page.pointer, false);
  return page;
}
async function notify(r, sheet, page, code, param = 0) {
  if (!page?.hwnd || !r.windows.windows.has(page.hwnd)) return 0;
  const p = r.allocate(16);
  try {
    [sheet.id, 0, code, param].forEach((v, i) => r.write32(p + 4 * i, v));
    return await r.windows.send(page.hwnd, 0x4e, 0, p);
  } finally {
    r.free(p);
  }
}
async function visibility(r, page, visible) {
  if (page?.hwnd && r.windows.windows.has(page.hwnd))
    await windowApis['user32.dll!ShowWindow'](r, (i) => [page.hwnd, visible ? 5 : 0][i]);
}
async function selectPage(r, sheet, index, kill = true) {
  if (index < 0 || index >= sheet.pages.length || sheet.finished) return 0;
  if (index === sheet.active) return 1;
  const old = sheet.pages[sheet.active];
  if (kill && (await notify(r, sheet, old, -201))) return 0;
  const target = await ensurePage(r, sheet, index);
  if (!target) return 0;
  const rejected = (await notify(r, sheet, target, -200)) | 0;
  if (rejected) return 0; // Page validation may reject activation.
  await visibility(r, old, false);
  sheet.active = index;
  await r.windows.send(sheet.tab, 0x130c, index, 0);
  await visibility(r, target, true);
  const focus = [...r.windows.windows.values()].find(
    (w) => w.parentId === target.hwnd && w.visible && w.enabled && w.style & 0x10000,
  );
  if (focus) await r.windows.setFocus(focus.id);
  return 1;
}
function updateApply(r, sheet) {
  const button = child(r, sheet.id, APPLY);
  if (button) {
    button.enabled = sheet.pages.some((p) => p.dirty);
    r.windows.emit(button);
  }
}
async function finish(r, sheet, result) {
  sheet.finished = true;
  sheet.result = result;
  // Modeless sheets stay alive for their application's DestroyWindow call.
  // PSM_GETCURRENTPAGEHWND now returns NULL so its message loop can detect closure.
  const dialog = r.dialogs.byWindow.get(sheet.id);
  if (dialog) {
    dialog.finished = true;
    dialog.result = result;
  }
  r.windows.wake?.();
}
async function apply(r, sheet, closing) {
  if (sheet.finished || (await notify(r, sheet, sheet.pages[sheet.active], -201))) return 0;
  for (let i = 0; i < sheet.pages.length; i++) {
    const page = sheet.pages[i];
    const result = await notify(r, sheet, page, -202, +closing);
    if (result) {
      if (result === 1) await selectPage(r, sheet, i, false);
      return 0;
    }
    page.dirty = false;
  }
  updateApply(r, sheet);
  if (closing) await finish(r, sheet, sheet.result || 1);
  else await notify(r, sheet, sheet.pages[sheet.active], -200);
  return 1;
}
async function cancel(r, sheet, closingWindow = false) {
  if (sheet.finished || (await notify(r, sheet, sheet.pages[sheet.active], -209))) return 0;
  for (const page of sheet.pages) await notify(r, sheet, page, -203, +closingWindow);
  await finish(r, sheet, 0);
  return 1;
}
async function sheetMessage(r, sheet, msg, wp, lp) {
  if (msg === 0x110) {
    for (let i = 0; i < sheet.pages.length; i++)
      if (sheet.pages[i].flags & 0x400) await ensurePage(r, sheet, i);
    if (!(await selectPage(r, sheet, sheet.start, false))) await finish(r, sheet, -1);
    if (sheet.callback) await r.callGuest(sheet.callback, [sheet.id, 1, 0]);
    return 0; // Keep the focus chosen by selectPage.
  }
  if (msg === 0x82) {
    for (const page of sheet.pages) await releasePage(r, page);
    r.dialogs.byWindow.delete(sheet.id);
    return 0;
  }
  if (msg === 0x10) return cancel(r, sheet, true);
  if (msg === 0x111) {
    const id = wp & 0xffff;
    if (id === 1 || id === APPLY) return apply(r, sheet, id === 1);
    if (id === 2) return cancel(r, sheet);
  }
  if (msg === 0x4e && lp && r.read32(lp) === sheet.tab) {
    const code = r.read32(lp + 8) | 0;
    if (code === -552) return (await notify(r, sheet, sheet.pages[sheet.active], -201)) ? 1 : 0;
    if (code === -551) {
      const index = await r.windows.send(sheet.tab, 0x130b);
      if (!(await selectPage(r, sheet, index, false)))
        await r.windows.send(sheet.tab, 0x130c, sheet.active);
      return 0;
    }
  }
  if (msg === 0x465)
    return selectPage(r, sheet, lp ? sheet.pages.findIndex((p) => p.handle === lp) : wp | 0);
  if (msg === 0x468 || msg === 0x46d) {
    const page = sheet.pages.find((p) => p.hwnd === wp);
    if (page) {
      page.dirty = msg === 0x468;
      updateApply(r, sheet);
    }
    return 0;
  }
  if (msg === 0x46e) return apply(r, sheet, false);
  if (msg === 0x471) {
    if (wp === 0) return apply(r, sheet, true);
    if (wp === 3) return cancel(r, sheet);
    if (wp === 4) return apply(r, sheet, false);
    throw Error('Unsupported property sheet button');
  }
  if (msg === 0x472)
    return selectPage(
      r,
      sheet,
      sheet.pages.findIndex((p) => p.resourceId === lp),
    );
  if (msg === 0x474) return sheet.tab;
  if (msg === 0x475)
    return (await windowApis['user32.dll!IsDialogMessageW'](r, (i) => [sheet.id, lp][i])).result;
  if (msg === 0x476) return sheet.finished ? 0 : sheet.pages[sheet.active]?.hwnd || 0;
  if (msg === 0x46c) {
    for (const page of sheet.pages) {
      const result = page.hwnd ? await r.windows.send(page.hwnd, msg, wp, lp) : 0;
      if (result) return result;
    }
    return 0;
  }
  if (msg === 0x481) return sheet.pages.findIndex((p) => p.hwnd === wp);
  if (msg === 0x482) return sheet.pages[wp]?.hwnd || 0;
  if (msg === 0x483) return sheet.pages.findIndex((p) => p.handle === lp);
  if (msg === 0x484) return sheet.pages[wp]?.handle || 0;
  if (msg === 0x485) return sheet.pages.findIndex((p) => p.resourceId === lp);
  if (msg === 0x486) return sheet.pages[wp]?.resourceId || 0;
  if (msg === 0x487) return sheet.result;
  if (msg === 0x46f || msg === 0x478) {
    if (wp & ~1) throw Error('Unsupported property sheet title flags');
    const w = r.windows.windows.get(sheet.id);
    w.title = text(r, lp, msg === 0x478);
    if (wp & 1) w.title = `Properties for ${w.title}`;
    r.windows.emit(w);
    return 1;
  }
  if (msg >= 0x465 && msg <= 0x488)
    throw Error(`Unsupported property sheet message 0x${msg.toString(16)}`);
  return null;
}
function hostProc(r, wide) {
  return registerHostWindowProcedure(r, `property-sheet:${wide}`, {
    kind: 'window-proc',
    name: `PropertySheet${wide ? 'W' : 'A'}`,
    wide,
    invoke: async (r, a) => {
      const w = r.windows.windows.get(a(0));
      if (!w?.propertySheet) return ok(0, 4);
      const value = await sheetMessage(r, w.propertySheet, a(1), a(2), a(3));
      if (value === null) return ok(0, 4);
      if (w.extra.byteLength >= 4) w.extra.setUint32(0, value >>> 0, true);
      return ok(a(1) === 0x110 ? value : 1, 4);
    },
  });
}
async function propertySheet(r, pointer, wide) {
  if (!pointer) return fail(r, 87, -1);
  r.check(pointer, 40);
  const size = r.read32(pointer),
    flags = r.read32(pointer + 4),
    owner = r.read32(pointer + 8),
    instance = r.read32(pointer + 12),
    count = r.read32(pointer + 24),
    array = r.read32(pointer + 32);
  if (![40, 52].includes(size) || !count || count > 64 || !array) return fail(r, 87, -1);
  if (flags & ~(1 | 8 | 0x40 | 0x80 | 0x100 | 0x400 | 0x2000000)) return fail(r, 120, -1);
  if (owner && !r.windows.windows.has(owner)) return fail(r, 1400, -1);
  const pages = [];
  let sheet;
  try {
    let at = array;
    for (let i = 0; i < count; i++) {
      let page;
      if (flags & 8) {
        const created = await createPage(r, at, wide);
        if (!created.result) throw new PropertySheetFailure('Invalid property page', r.lastError);
        page = state(r).pages.get(created.result);
        at += r.read32(at);
      } else {
        r.check(at, 4);
        page = state(r).pages.get(r.read32(at));
        at += 4;
      }
      if (!page || page.sheet || pages.includes(page))
        throw new PropertySheetFailure('Invalid or already owned property page');
      pages.push(page);
    }
    const start = r.read32(pointer + 28);
    const startIndex =
      flags & 0x40
        ? pages.findIndex((p) => p.resourceId === (start <= 0xffff ? start : text(r, start, wide)))
        : start;
    const captionPointer = r.read32(pointer + 20);
    if (captionPointer && captionPointer <= 0xffff) {
      throw new PropertySheetFailure('Property caption resources are not implemented', 120);
    }
    const caption = text(r, captionPointer, wide);
    const cx = Math.max(160, ...pages.map((p) => p.template.cx)) + 16,
      cy = Math.max(80, ...pages.map((p) => p.template.cy)) + 50;
    const callback = flags & 0x100 ? r.read32(pointer + 36) : 0;
    const header = r.allocate(24);
    let template;
    try {
      r.data.fill(0, header, header + 24);
      r.write32(header, 0x90c80080);
      r.view.setUint16(header + 10, 20, true);
      r.view.setUint16(header + 12, 20, true);
      r.view.setUint16(header + 14, cx, true);
      r.view.setUint16(header + 16, cy, true);
      if (callback) await r.callGuest(callback, [0, 2, header]);
      template = readDialogTemplate(r.data.slice(header, header + 24));
    } finally {
      r.free(header);
    }
    if (!template) throw new PropertySheetFailure('Invalid property sheet callback template');
    template.title = flags & 1 ? `Properties for ${caption}` : caption;
    const built = await buildDialog(
      r,
      template,
      owner,
      hostProc(r, wide),
      instance || r.pe.imageBase,
      wide,
    );
    if (built.error) {
      throw new PropertySheetFailure('Property sheet creation failed', built.error);
    }
    sheet = {
      id: built.dialog.id,
      pages,
      active: -1,
      start: startIndex < count && startIndex >= 0 ? startIndex : 0,
      callback,
      result: 0,
      finished: false,
      modeless: !!(flags & 0x400),
      tab: 0,
    };
    r.windows.windows.get(sheet.id).propertySheet = sheet;
    for (const page of pages) page.sheet = sheet.id;
    const tab = await createWindowFromHost(r, {
      className: 'SysTabControl32',
      x: 8,
      y: 8,
      width: cx * 2 - 16,
      height: (cy - 22) * 2,
      parent: sheet.id,
      style: 0x50010000,
      controlId: TAB,
      wide,
    });
    if (tab.error) throw new PropertySheetFailure('Property tab creation failed', tab.error);
    sheet.tab = tab.id;
    for (let i = 0; i < pages.length; i++) {
      const item = r.allocate(28),
        title = r.allocString(pages[i].title, wide);
      try {
        r.data.fill(0, item, item + 28);
        r.write32(item, 1);
        r.write32(item + 12, title);
        await r.windows.send(sheet.tab, wide ? 0x133e : 0x1307, i, item);
      } finally {
        r.free(item);
        r.free(title);
      }
    }
    const actions = [[1, 'OK'], [2, 'Cancel'], ...(flags & 0x80 ? [] : [[APPLY, 'Apply']])];
    for (let i = 0; i < actions.length; i++) {
      const [id, title] = actions[i];
      const button = await createWindowFromHost(r, {
        className: 'BUTTON',
        title,
        x: cx * 2 - (actions.length - i) * 92 - 8,
        y: cy * 2 - 36,
        width: 84,
        height: 28,
        parent: sheet.id,
        style: 0x50010000 | (id === 1 ? 1 : 0),
        controlId: id,
        wide,
      });
      if (button.error)
        throw new PropertySheetFailure('Property button creation failed', button.error);
    }
    updateApply(r, sheet);
    if (sheet.modeless) {
      await initializeDialog(r, built.dialog, 0);
      return ok(sheet.id);
    }
    const result = await runDialog(r, built.dialog, 0);
    return ok(result.result);
  } catch (error) {
    if (sheet && r.windows.windows.has(sheet.id)) await r.windows.destroy(sheet.id);
    else for (const page of pages) if (flags & 8) await releasePage(r, page);
    // Only expected Win32 data/creation failures become -1. A guest CPU/API
    // failure must remain visible rather than being mistaken for cancellation.
    if (!(error instanceof PropertySheetFailure)) throw error;
    return fail(r, error.code, -1);
  }
}
export const propertySheetApis = {
  'comctl32.dll!PropertySheetA': (r, a) => propertySheet(r, a(0), false),
  'comctl32.dll!PropertySheetW': (r, a) => propertySheet(r, a(0), true),
  'comctl32.dll!CreatePropertySheetPageA': (r, a) => createPage(r, a(0), false),
  'comctl32.dll!CreatePropertySheetPageW': (r, a) => createPage(r, a(0), true),
  'comctl32.dll!DestroyPropertySheetPage': async (r, a) => {
    const page = state(r).pages.get(a(0));
    if (!page || page.sheet) return fail(r, 6);
    await releasePage(r, page);
    return ok(1);
  },
};
