import { decodeAnsi, encodeAnsi } from './encoding.js';
import { packageDosPath } from './guest-paths.js';
import { normalizePath } from './package.js';
import { touchFile } from './file-metadata.js';
import { processApis } from './win32-process.js';

const ok = (result, argc) => ({ result: result >>> 0, argc });
// HDROP is an ordinary guest HGLOBAL, including ones allocated by native DLLs.
// Keep parsing bounded by GlobalSize; never walk beyond the allocation looking
// for MULTI_SZ terminators. The package ACP is Windows-1252.
function block(r, handle) {
  const size = r.allocationSize(handle);
  if (size === null || size < 20) return null;
  r.check(handle, size);
  return { size, offset: r.read32(handle), wide: !!r.read32(handle + 16) };
}
function paths(r, handle) {
  const b = block(r, handle);
  if (!b || b.offset < 20 || b.offset >= b.size || (b.wide && b.offset % 2)) return null;
  const step = b.wide ? 2 : 1,
    end = handle + b.size,
    list = [];
  let p = handle + b.offset;
  const unit = (at) => (b.wide ? r.view.getUint16(at, true) : r.data[at]);
  while (p + step <= end) {
    if (!unit(p)) {
      // Empty lists still have two NULs. Nonempty lists already consumed the
      // preceding filename terminator.
      if (!list.length && (p + 2 * step > end || unit(p + step))) return null;
      return list;
    }
    const start = p;
    while (p + step <= end && unit(p)) p += step;
    if (p + step > end) return null;
    list.push(
      b.wide
        ? new TextDecoder('utf-16le').decode(r.data.subarray(start, p))
        : decodeAnsi(r.data.subarray(start, p)),
    );
    p += step;
  }
  return null;
}
function query(r, a, wide) {
  const list = paths(r, a(0)),
    index = a(1) >>> 0;
  if (!list) return ok(0, 4);
  if (index === 0xffffffff) return ok(list.length, 4);
  if (index >= list.length) return ok(0, 4);
  const value = list[index],
    units = wide
      ? Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
      : encodeAnsi(value).bytes;
  const out = a(2),
    capacity = a(3) >>> 0;
  if (!out || !capacity) return ok(units.length, 4);
  const count = Math.min(units.length, capacity - 1);
  r.check(out, (count + 1) * (wide ? 2 : 1), true);
  for (let i = 0; i <= count; i++) {
    if (wide) r.view.setUint16(out + i * 2, i === count ? 0 : units[i], true);
    else r.data[out + i] = i === count ? 0 : units[i];
  }
  return ok(count, 4);
}

// Browser drops are imported input files, not app-generated output. Every
// batch gets a fresh directory so duplicate names cannot replace executables,
// open files, or another batch. Applications may subsequently edit/export them.
export function receiveDroppedFiles(r, window, event) {
  if (
    !(window.exStyle & 0x10) ||
    !Array.isArray(event.files) ||
    !event.files.length ||
    event.files.length > 2048 ||
    !Number.isFinite(event.x) ||
    !Number.isFinite(event.y)
  )
    return false;
  let total = 0;
  const files = [];
  try {
    for (const file of event.files) {
      if (typeof file.name !== 'string' || /[\\/:\0]/.test(file.name) || !file.name.trim())
        return false;
      const name = normalizePath(file.name);
      if (name.includes('/') || !(file.bytes instanceof Uint8Array)) return false;
      total += file.bytes.length;
      if (total > 128 * 1024 * 1024) return false;
      files.push({ name, display: file.name, bytes: file.bytes });
    }
  } catch {
    return false;
  }
  let batch = r.dropBatch ?? 0,
    prefix;
  do {
    prefix = `_dropped/${++batch}/`;
  } while (
    [...r.files.keys()].some((p) => p.startsWith(prefix)) ||
    r.virtualDirectories.has(prefix)
  );
  const used = new Set(),
    imported = [];
  for (const file of files) {
    let name = file.name,
      display = file.display,
      duplicate = 1;
    while (used.has(name)) {
      name = `${++duplicate}-${file.name}`;
      display = `${duplicate}-${file.display}`;
    }
    used.add(name);
    imported.push({ path: prefix + name, display: prefix + display, bytes: file.bytes });
  }
  const list = imported.map((f) => packageDosPath(f.display) + '\0').join('') + '\0';
  const handle = r.allocate(20 + list.length * 2);
  r.write32(handle, 20);
  r.write32(handle + 4, Math.round(event.x));
  r.write32(handle + 8, Math.round(event.y));
  r.write32(handle + 12, 0);
  r.write32(handle + 16, 1);
  for (let i = 0; i < list.length; i++)
    r.view.setUint16(handle + 20 + i * 2, list.charCodeAt(i), true);
  try {
    if (!r.windows.post(window.id, 0x233, handle, 0)) {
      r.free(handle);
      return false;
    }
  } catch (error) {
    r.free(handle);
    throw error;
  }
  for (const file of imported) {
    r.files.set(file.path, file.bytes.slice());
    touchFile(r, file.path, { created: true });
  }
  r.dropBatch = batch;
  return true;
}
export const dropFileApis = {
  'shell32.dll!DragQueryFileA': (r, a) => query(r, a, false),
  'shell32.dll!DragQueryFileW': (r, a) => query(r, a, true),
  'shell32.dll!DragQueryPoint': (r, a) => {
    if (!block(r, a(0)) || !a(1)) return ok(0, 2);
    r.check(a(1), 8, true);
    r.write32(a(1), r.read32(a(0) + 4));
    r.write32(a(1) + 4, r.read32(a(0) + 8));
    return ok(!r.read32(a(0) + 12), 2);
  },
  'shell32.dll!DragFinish': (r, a) => {
    processApis['kernel32.dll!GlobalFree'](r, a);
    return ok(0, 1);
  },
  'shell32.dll!DragAcceptFiles': (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (window) {
      window.exStyle = (window.exStyle & ~0x10) | (a(1) ? 0x10 : 0);
      r.windows.emit(window);
    }
    return ok(0, 2);
  },
};
