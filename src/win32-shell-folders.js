import { ComObjects } from './com.js';
import { packageDosPath, resolveGuestPath } from './guest-paths.js';
import { createWindowFromHost } from './win32-windows.js';
import { shellFileInfoApis } from './win32-shell-file-info.js';
const ok = (result, argc) => ({ result: result >>> 0, argc });
const states = new WeakMap();
function state(r) {
  let s = states.get(r);
  if (!s) {
    s = { allocations: new Set(), allocator: null };
    states.set(r, s);
  }
  return s;
}
function alloc(r, size) {
  if (size > 16 * 1024 * 1024) return 0;
  let p;
  try {
    p = r.allocate(Math.max(1, size));
  } catch (error) {
    if (error.message === 'Guest heap exhausted') return 0;
    throw error;
  }
  state(r).allocations.add(p);
  return p;
}
function free(r, p) {
  if (!p) return;
  if (state(r).allocations.delete(p)) r.free(p);
}
function realloc(r, old, size) {
  if (!old) return alloc(r, size);
  const s = state(r);
  if (!s.allocations.has(old)) return 0;
  if (!size) {
    free(r, old);
    return 0;
  }
  if (size > 16 * 1024 * 1024) return 0;
  let next;
  try {
    next = r.reallocate(old, size);
  } catch (error) {
    if (error.message === 'Guest heap exhausted') return 0;
    throw error;
  }
  if (next) {
    s.allocations.delete(old);
    s.allocations.add(next);
  }
  return next;
}
// Shell PIDLs, SHGetMalloc and COM's task allocator share ownership. A caller
// may release a shell-allocated item through CoTaskMemFree or IMalloc::Free.
export const taskMemoryApis = {
  'ole32.dll!CoTaskMemAlloc': (r, a) => ok(alloc(r, a(0)), 1),
  'ole32.dll!CoTaskMemRealloc': (r, a) => ok(realloc(r, a(0), a(1)), 2),
  'ole32.dll!CoTaskMemFree': (r, a) => {
    free(r, a(0));
    return ok(0, 1);
  },
};
function allocator(r) {
  const s = state(r);
  if (s.allocator?.refs) {
    r.comObjects.retain(s.allocator);
    return s.allocator.pointer;
  }
  r.comObjects ??= new ComObjects(r);
  s.allocator = r.comObjects.create({
    name: 'IMalloc',
    iid: '00000002-0000-0000-c000-000000000046',
    methodNames: [
      'QueryInterface',
      'AddRef',
      'Release',
      'Alloc',
      'Realloc',
      'Free',
      'GetSize',
      'DidAlloc',
      'HeapMinimize',
    ],
    methods: {
      3: { argc: 2, invoke: (r, a) => alloc(r, a(1)) },
      4: {
        argc: 3,
        invoke: (r, a) => realloc(r, a(1), a(2)),
      },
      5: {
        argc: 2,
        invoke: (r, a) => {
          free(r, a(1));
          return 0;
        },
      },
      6: {
        argc: 2,
        invoke: (r, a) => (s.allocations.has(a(1)) ? r.allocationSize(a(1)) : 0xffffffff),
      },
      7: { argc: 2, invoke: (_r, a) => (a(1) ? Number(s.allocations.has(a(1))) : -1) },
      8: { argc: 1, invoke: () => 0 },
    },
  });
  return s.allocator.pointer;
}
// The isolated package is a shell namespace of its own. PIDLs contain one
// filesystem item with a bounded UTF-16 DOS path, followed by the terminator.
// Parsing the bytes (rather than a pointer map) also accepts caller-made copies.
function pidl(r, path) {
  const text = packageDosPath(path),
    size = 4 + (text.length + 1) * 2,
    p = alloc(r, size + 2);
  r.view.setUint16(p, size, true);
  r.view.setUint16(p + 2, 0x4257, true);
  for (let i = 0; i < text.length; i++) r.view.setUint16(p + 4 + i * 2, text.charCodeAt(i), true);
  return p;
}
function pathFromPidl(r, p) {
  if (!p) return null;
  r.check(p, 4);
  const size = r.view.getUint16(p, true);
  if (size < 6 || size > 524 || r.view.getUint16(p + 2, true) !== 0x4257) return null;
  r.check(p, size + 2);
  if (r.view.getUint16(p + size, true) !== 0) return null;
  const path = r.wideString(p + 4);
  if (4 + (path.length + 1) * 2 !== size) return null;
  try {
    return resolveGuestPath(path, '', { allowRoot: true });
  } catch {
    return null;
  }
}
function write(r, p, text, wide, limit) {
  const width = wide ? 2 : 1;
  r.check(p, limit * width, true);
  text = text.slice(0, limit - 1);
  for (let i = 0; i <= text.length; i++)
    r.guestMemory.write(p + i * width, i === text.length ? 0 : text.charCodeAt(i), width);
}
function folders(r) {
  const set = new Set(['']);
  for (const file of r.files.keys()) {
    let path = file;
    while (path.includes('/')) {
      path = path.slice(0, path.lastIndexOf('/'));
      set.add(path);
    }
  }
  for (const path of r.virtualDirectories ?? []) set.add(path.replace(/\/$/, ''));
  return [...set].sort();
}
async function browse(r, a, wide) {
  const p = a(0);
  if (!p) {
    r.lastError = 87;
    return ok(0, 1);
  }
  r.check(p, 32);
  const owner = r.read32(p),
    rootPointer = r.read32(p + 4),
    display = r.read32(p + 8),
    titlePointer = r.read32(p + 12),
    flags = r.read32(p + 16),
    callback = r.read32(p + 20),
    param = r.read32(p + 24);
  if (owner && !r.windows.windows.has(owner)) {
    r.lastError = 1400;
    return ok(0, 1);
  }
  const root = rootPointer ? pathFromPidl(r, rootPointer) : '';
  if (root === null) {
    r.lastError = 87;
    return ok(0, 1);
  }
  // Non-filesystem objects (printers/computers) do not belong to this namespace.
  if (flags & (0x1000 | 0x2000)) {
    r.lastError = 50;
    return ok(0, 1);
  }
  const choices = folders(r).filter(
    (path) => !root || path === root || path.startsWith(root + '/'),
  );
  const title = titlePointer
    ? wide
      ? r.wideString(titlePointer)
      : r.string(titlePointer)
    : 'Choose a folder';
  const created = await createWindowFromHost(r, {
    className: 'winebrowser-dialog',
    title,
    parent: owner,
    owner: true,
    x: 40,
    y: 40,
    width: 360,
    height: 160,
    style: 0x80c80000,
  });
  if (!created.id) return ok(0, 1);
  const w = r.windows.windows.get(created.id);
  w.browseFolder = {
    choices,
    selection: choices.includes(r.cwd.replace(/\/$/, '')) ? r.cwd.replace(/\/$/, '') : root,
    enabled: true,
  };
  try {
    if (callback) await r.callGuest(callback, [w.id, 1, 0, param]); // BFFM_INITIALIZED
    const result = await r.request('browse-folder', {
      title,
      folders: choices.map((path) => ({ path, label: packageDosPath(path) })),
      selected: w.browseFolder.selection,
      enabled: w.browseFolder.enabled,
    });
    if (typeof result !== 'string' || !choices.includes(result)) return ok(0, 1);
    const item = pidl(r, result);
    if (callback) await r.callGuest(callback, [w.id, 2, item, param]); // BFFM_SELCHANGED
    if (display) write(r, display, result.split('/').at(-1) || 'winebrowser', wide, 260);
    r.check(p + 28, 4, true);
    r.write32(p + 28, 0);
    return ok(item, 1);
  } finally {
    await r.windows.destroy(w.id);
  }
}
export const shellFolderApis = {
  ...shellFileInfoApis,
  'shell32.dll!SHGetMalloc': (r, a) => {
    if (!a(0)) return ok(0x80004003, 1);
    r.check(a(0), 4, true);
    r.write32(a(0), allocator(r));
    return ok(0, 1);
  },
  'shell32.dll!SHBrowseForFolderA': (r, a) => browse(r, a, false),
  'shell32.dll!SHBrowseForFolderW': (r, a) => browse(r, a, true),
  'shell32.dll!SHGetPathFromIDListA': (r, a) => {
    const path = pathFromPidl(r, a(0));
    if (path === null || !a(1) || packageDosPath(path).length >= 260) return ok(0, 2);
    write(r, a(1), packageDosPath(path), false, 260);
    return ok(1, 2);
  },
  'shell32.dll!SHGetPathFromIDListW': (r, a) => {
    const path = pathFromPidl(r, a(0));
    if (path === null || !a(1) || packageDosPath(path).length >= 260) return ok(0, 2);
    write(r, a(1), packageDosPath(path), true, 260);
    return ok(1, 2);
  },
  'shell32.dll!ILFree': (r, a) => {
    free(r, a(0));
    return ok(0, 1);
  },
  'shell32.dll!SHAlloc': (r, a) => ok(alloc(r, a(0)), 1),
  'shell32.dll!SHFree': (r, a) => {
    free(r, a(0));
    return ok(0, 1);
  },
};
