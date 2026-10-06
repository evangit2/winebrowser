// Standard PE32 OPENFILENAMEA/W dialogs. Native code still reads/writes the
// chosen files using ordinary shared filesystem APIs; Save As creates no file.
import { decodeAnsi, encodeAnsi } from './encoding.js';
import { resolveGuestPath, packageDosPath } from './guest-paths.js';
import { normalizePath } from './package.js';
import { touchFile, fileMetadata } from './file-metadata.js';
import { setProcessDirectory } from './process-directory.js';
import {
  OFN,
  parentPath,
  baseName,
  fileDialogDirectories,
  fileDialogSelection,
} from './file-dialog-model.js';
const ok = (result) => ({ result, argc: 1 });
function error(r, code, lastError = 87) {
  r.commonDialogError = code;
  r.lastError = lastError;
  return ok(0);
}
function text(r, pointer, wide, capacity = 65536) {
  if (!pointer) return '';
  const step = wide ? 2 : 1;
  let value = '';
  const bytes = [];
  for (let i = 0; i < capacity; i++) {
    r.check(pointer + i * step, step);
    const unit = wide ? r.view.getUint16(pointer + i * step, true) : r.data[pointer + i];
    if (!unit) return wide ? value : decodeAnsi(new Uint8Array(bytes));
    if (wide) value += String.fromCharCode(unit);
    else bytes.push(unit);
  }
  throw Error('Unterminated dialog string');
}
function filters(r, pointer, wide, limit = 65536) {
  const entries = [],
    step = wide ? 2 : 1;
  let used = 0;
  while (pointer && used < limit) {
    const label = text(r, pointer + used * step, wide, limit - used);
    used += label.length + 1;
    if (!label) return entries;
    const pattern = text(r, pointer + used * step, wide, limit - used);
    used += pattern.length + 1;
    if (!pattern) throw Error('Missing filter pattern');
    entries.push({ label, pattern });
    if (entries.length > 256) throw Error('Too many filters');
  }
  if (pointer) throw Error('Unterminated dialog filters');
  return entries;
}
function units(value, wide) {
  return wide
    ? Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
    : encodeAnsi(value).bytes;
}
function write(r, pointer, value, wide, capacity) {
  const data = units(value, wide),
    count = Math.min(data.length, capacity);
  for (let i = 0; i < count; i++) {
    if (wide) r.view.setUint16(pointer + i * 2, data[i], true);
    else r.data[pointer + i] = data[i];
  }
}
export async function chooseBrowserFile(r, a, wide, save) {
  r.commonDialogError = 0;
  const p = a(0) >>> 0;
  if (!p) return error(r, 1);
  r.check(p, 4);
  const size = r.read32(p);
  if (size !== 76 && size !== 88) return error(r, 1);
  r.check(p, size, true);
  const owner = r.read32(p + 4),
    flags = r.read32(p + 52);
  if (owner && !r.windows.windows.has(owner)) return error(r, 2, 1400);
  // Native HWND hooks, custom templates/help and old 8.3 multiselect need a
  // native dialog implementation. Do not masquerade these as a user cancel.
  const supported =
    0x00800000 | // ENABLESIZING: browser resize grip
    0x02000000 | // DONTADDTORECENT: no host MRU
    0x10000000 | // FORCESHOWHIDDEN: guest inventory is visible
    0x00100000 | // NODEREFERENCELINKS: guest namespace has no links
    0x00200000 | // LONGNAMES
    0x00040000 | // NOLONGNAMES: ignored with EXPLORER
    0x00020000 | // NONETWORKBUTTON: no network namespace
    0x00008000 | // NOREADONLYRETURN: guest files are writable
    0x00010000 | // NOTESTFILECREATE: the dialog never creates output
    0x00002000 |
    0x00001000 |
    0x00000800 |
    0x00000400 |
    0x00000200 |
    0x00080000 |
    0xf;
  if (flags & ~supported || (flags & (OFN.ALLOWMULTISELECT | 0x40000) && !(flags & OFN.EXPLORER)))
    return error(r, 2, 120);
  const buffer = r.read32(p + 28),
    capacity = r.read32(p + 32),
    titleBuffer = r.read32(p + 36),
    titleCapacity = r.read32(p + 40);
  if (!buffer || capacity < 1 || capacity > 1048576 || titleCapacity > 1048576) return error(r, 1);
  r.check(buffer, capacity * (wide ? 2 : 1), true);
  if (titleBuffer && titleCapacity) r.check(titleBuffer, titleCapacity * (wide ? 2 : 1), true);
  let initial,
    filterList,
    custom,
    defaultExtension,
    title,
    directory = r.cwd.replace(/\/$/, '');
  const customPointer = r.read32(p + 16),
    customCapacity = r.read32(p + 20);
  try {
    initial = text(r, buffer, wide, capacity);
    filterList = filters(r, r.read32(p + 12), wide).map((f, i) => ({ ...f, index: i + 1 }));
    if (customPointer && customCapacity) {
      if (customCapacity > 65536) throw Error('Invalid custom filter');
      r.check(customPointer, customCapacity * (wide ? 2 : 1), true);
      const label = text(r, customPointer, wide, customCapacity);
      const pattern = text(
        r,
        customPointer + (label.length + 1) * (wide ? 2 : 1),
        wide,
        customCapacity - label.length - 1,
      );
      custom = { label, pattern, index: 0 };
      if (label && pattern) filterList.unshift(custom);
    }
    defaultExtension = text(r, r.read32(p + 60), wide);
    if (/[\\/:*?\0]/.test(defaultExtension)) throw Error('Invalid extension');
    title = text(r, r.read32(p + 48), wide) || (save ? 'Save As' : 'Open');
    const dir = text(r, r.read32(p + 44), wide);
    if (dir) {
      try {
        const resolved = resolveGuestPath(dir, r.cwd, { allowRoot: true });
        if (fileMetadata(r, resolved).directory) directory = resolved;
      } catch {
        /* Use current directory. */
      }
    }
    if (initial.includes('\\') || initial.includes('/')) {
      const path = resolveGuestPath(initial, r.cwd);
      if (fileMetadata(r, parentPath(path)).directory) {
        directory = parentPath(path);
        initial = baseName(path);
      }
    }
  } catch {
    return error(r, 0x3002);
  }
  const fileList = [...r.files].map(([path, bytes]) => ({ path, size: bytes.length }));
  const directories = fileDialogDirectories(fileList, [...r.virtualDirectories]);
  let root = '_opened',
    suffix = 0;
  while (r.files.has(root)) root = `_opened-${++suffix}`;
  let batch = r.fileDialogImportBatch ?? 0,
    importPrefix;
  do {
    importPrefix = `${root}/${++batch}/`;
  } while (
    directories.includes(importPrefix.slice(0, -1)) ||
    r.files.has(importPrefix.slice(0, -1))
  );
  const request = {
    owner,
    save,
    flags,
    title,
    initial,
    directory,
    filters: filterList.length ? filterList : [{ label: 'All files', pattern: '*.*', index: 1 }],
    filterIndex: r.read32(p + 24),
    defaultExtension,
    files: fileList,
    directories,
    importPrefix,
  };
  const selected = await r.request('choose-file', request);
  if (selected == null) return ok(0);
  if (typeof selected !== 'object') return error(r, 0x3002);
  // Validate imported snapshots before committing them. They are inputs, with
  // fresh names that cannot overwrite loaded modules or existing open files.
  const imports = [],
    used = new Set();
  let total = 0;
  try {
    if (!Array.isArray(selected.imports ?? []) || (selected.imports?.length ?? 0) > 2048)
      throw Error('Invalid imports');
    for (const file of selected.imports ?? []) {
      if (
        typeof file.path !== 'string' ||
        !file.path.startsWith(importPrefix) ||
        !(file.bytes instanceof Uint8Array)
      )
        throw Error('Invalid imported file');
      const path = normalizePath(file.path);
      if (
        path !== file.path ||
        parentPath(path) !== importPrefix.slice(0, -1) ||
        r.files.has(path) ||
        used.has(path)
      )
        throw Error('Import collision');
      total += file.bytes.length;
      if (total > 128 * 1024 * 1024) throw Error('Import too large');
      imports.push({ path, bytes: file.bytes.slice() });
      used.add(path);
    }
  } catch {
    return error(r, 0x3002);
  }
  const allFiles = [...fileList, ...imports],
    allDirs = fileDialogDirectories(allFiles, [...r.virtualDirectories]);
  const selection = fileDialogSelection(request, selected, allFiles, allDirs);
  if (selection.error || (selection.confirmation && selected.confirmed !== true))
    return error(r, 0x3002);
  const paths = selection.paths,
    multi = paths.length > 1;
  const path = packageDosPath(parentPath(paths[0]), true) + selection.names[0],
    directoryPath = packageDosPath(parentPath(paths[0])).replace(/\\$/, '');
  const output = multi
    ? directoryPath + '\0' + selection.names.join('\0') + '\0\0'
    : path + '\0' + (flags & OFN.ALLOWMULTISELECT ? '\0' : '');
  if (!wide && encodeAnsi(output).usedDefault) return error(r, 0x3002, 1113);
  const length = units(output, wide).length;
  if (length > capacity) {
    if (capacity * (wide ? 2 : 1) >= 2) r.view.setUint16(buffer, Math.min(length, 65535), true);
    return error(r, 0x3003, 122);
  }
  const previousTimes = new Map();
  for (const file of imports) {
    let path = file.path;
    for (;;) {
      if (!previousTimes.has(path)) previousTimes.set(path, r.fileTimes?.get(path));
      if (!path) break;
      path = parentPath(path);
    }
  }
  for (const file of imports) {
    r.files.set(file.path, file.bytes);
    touchFile(r, file.path, { created: true });
  }
  const appliedTimes = new Map(
    [...previousTimes.keys()].map((path) => [path, r.fileTimes?.get(path)]),
  );
  if (!(flags & OFN.NOCHANGEDIR)) {
    const directoryError = await setProcessDirectory(r, parentPath(paths[0]));
    if (directoryError) {
      for (const file of imports)
        if (r.files.get(file.path) === file.bytes) r.files.delete(file.path);
      // Restore only our own timestamp writes; unrelated guest work may have
      // run while Wine's directory setter was waiting on its process lock.
      for (const [path, previous] of previousTimes)
        if (r.fileTimes?.get(path) === appliedTimes.get(path)) {
          if (previous) r.fileTimes.set(path, previous);
          else r.fileTimes.delete(path);
        }
      return error(r, 0x3002, directoryError);
    }
  }
  if (imports.length) r.fileDialogImportBatch = batch;
  // All output pointers were checked before requesting the picker; writes are
  // committed only after selection and capacity validation have succeeded.
  write(r, buffer, output, wide, capacity);
  if (!multi && titleBuffer && titleCapacity) {
    const value = units(selection.names[0], wide).slice(0, titleCapacity - 1);
    for (let i = 0; i <= value.length; i++) {
      if (wide) r.view.setUint16(titleBuffer + i * 2, value[i] ?? 0, true);
      else r.data[titleBuffer + i] = value[i] ?? 0;
    }
  }
  const fileOffset = multi
    ? units(directoryPath, wide).length + 1
    : units(path.slice(0, path.lastIndexOf('\\') + 1), wide).length;
  const dot = path.lastIndexOf('.'),
    extensionOffset =
      multi || dot < path.lastIndexOf('\\') ? 0 : units(path.slice(0, dot + 1), wide).length;
  r.view.setUint16(p + 56, fileOffset, true);
  r.view.setUint16(p + 58, extensionOffset, true);
  r.write32(p + 24, selection.filterIndex);
  let outFlags = flags & ~(OFN.READONLY | OFN.EXTENSIONDIFFERENT);
  if (selected.readonly) outFlags |= OFN.READONLY;
  if (
    defaultExtension &&
    (baseName(paths[0]).includes('.')
      ? baseName(paths[0]).slice(baseName(paths[0]).lastIndexOf('.') + 1)
      : ''
    ).toLowerCase() !== defaultExtension.toLowerCase()
  )
    outFlags |= OFN.EXTENSIONDIFFERENT;
  r.write32(p + 52, outFlags);
  if (custom && customPointer && customCapacity) {
    const pattern =
      request.filters.find((f) => f.index === selection.filterIndex)?.pattern ?? custom.pattern;
    const value = custom.label + '\0' + pattern + '\0';
    if (units(value, wide).length <= customCapacity)
      write(r, customPointer, value, wide, customCapacity);
  }
  return ok(1);
}
