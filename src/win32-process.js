import { processCommandLine } from './command-line.js';
export { quoteArgument } from './command-line.js';
import { encodeAnsi, decodeAnsi } from './encoding.js';
// Browser host services needed by ordinary PE startup and Wine's guest helpers.
// This file owns no guest instruction execution or PE parsing.
import { callWineHeap } from './wine-process.js';
import { normalizePath } from './package.js';
import { parsePE } from './pe.js';
const ok = (result = 0, argc = 0) => ({ result, argc });
const fail = (r, error, argc = 0) => {
  r.lastError = error;
  return ok(0, argc);
};
function writeString(r, address, value, wide = false) {
  for (let i = 0; i <= value.length; i++)
    r.guestMemory.write(
      address + i * (wide ? 2 : 1),
      i === value.length ? 0 : value.charCodeAt(i),
      wide ? 2 : 1,
    );
  return address;
}
function moduleHandle(r, a, wide) {
  if (!a(0)) return ok(r.pe.imageBase, 1);
  const name = (wide ? r.wideString(a(0)) : r.string(a(0)))
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    .toLowerCase();
  const module = r.graph.modules.get(name) || r.graph.modules.get(name + '.dll');
  return module ? ok(module.base, 1) : fail(r, 126, 1);
}
async function procAddress(r, a) {
  const module = [...r.graph.modules.values()].find((m) => m.base === a(0));
  if (!module) return fail(r, 6, 2);
  const symbol = a(1) < 65536 ? a(1) : r.string(a(1));
  try {
    return ok(await r.resolveExport(module, symbol), 2);
  } catch (error) {
    if (!error.win32Error) throw error;
    return fail(r, error.win32Error, 2);
  }
}
async function loadLibrary(r, a, wide) {
  const name = wide ? r.wideString(a(0)) : r.string(a(0));
  try {
    return ok(await r.loadLibrary(name), 1);
  } catch (e) {
    if (!e.win32Error) throw e;
    r.emit({ type: 'log', text: e.message });
    return fail(r, e.win32Error, 1);
  }
}
async function freeLibrary(r, a) {
  return ok((await r.freeLibrary(a(0))) ? 1 : 0, 1);
}
function localAlloc(r, a) {
  if (a(0) & ~0x40) return fail(r, 87, 2);
  return ok(r.allocate(a(1), !!(a(0) & 0x40)), 2);
}
function localFree(r, a) {
  if (!a(0)) return ok(0, 1);
  if (!r.free(a(0))) {
    r.lastError = 6;
    return ok(a(0), 1);
  }
  return ok(0, 1);
}
async function heapAlloc(r, a) {
  if (r.wineProcess && a(0) !== 0x50000000)
    return ok(await callWineHeap(r, 'RtlAllocateHeap', [a(0), a(1), a(2)]), 3);
  if (a(0) !== 0x50000000 || a(1) & ~0xc) return fail(r, 87, 3);
  return ok(r.allocate(a(2), !!(a(1) & 8)), 3);
}
async function heapFree(r, a) {
  if (r.wineProcess && a(0) !== 0x50000000)
    return ok((await callWineHeap(r, 'RtlFreeHeap', [a(0), a(1), a(2)])) & 0xff, 3);
  if (a(0) !== 0x50000000 || a(1)) return fail(r, 87, 3);
  return r.free(a(2)) ? ok(1, 3) : fail(r, 6, 3);
}
function commandLine(r, wide) {
  const name = wide ? 'commandLineW' : 'commandLineA';
  r[name] ??= r.allocString(processCommandLine(r), wide);
  return ok(r[name]);
}
function moduleFilename(r, a, wide) {
  if (a(0) && a(0) !== r.pe.imageBase) return fail(r, 126, 3);
  if (!a(2)) return fail(r, 122, 3);
  const value = r.exe.replaceAll('/', '\\'),
    length = Math.min(value.length, a(2) - 1);
  writeString(r, a(1), value.slice(0, length), wide);
  if (value.length >= a(2)) {
    r.lastError = 122;
    return ok(a(2), 3);
  }
  return ok(value.length, 3);
}
function wideToMulti(r, a) {
  const cp = a(0),
    flags = a(1),
    input = a(2),
    count = a(3) | 0,
    out = a(4),
    capacity = a(5);
  if (![0, 1252, 65001].includes(cp) || flags)
    throw Error('Unsupported WideCharToMultiByte codepage/flags');
  if (count === 0 || count < -1) return fail(r, 87, 8);
  if (count > 1048576) throw Error('WideCharToMultiByte input limit');
  let value;
  if (count === -1) value = r.wideString(input) + '\0';
  else {
    value = '';
    for (let i = 0; i < count; i++)
      value += String.fromCharCode(r.guestMemory.read(input + i * 2, 2));
  }
  let bytes,
    used = false;
  if (cp === 65001) {
    if (a(6) || a(7)) return fail(r, 87, 8);
    bytes = new TextEncoder().encode(value);
  } else {
    const converted = encodeAnsi(value, a(6) ? r.guestMemory.read(a(6), 1) : 63);
    bytes = converted.bytes;
    used = converted.usedDefault;
  }
  if (a(7)) r.write32(a(7), +used);
  if (!capacity) return ok(bytes.length, 8);
  if (bytes.length > capacity) return fail(r, 122, 8);
  r.check(out, bytes.length, true);
  r.data.set(bytes, out);
  return ok(bytes.length, 8);
}
function multiToWide(r, a) {
  const cp = a(0),
    flags = a(1),
    input = a(2),
    count = a(3) | 0;
  const output = a(4),
    capacity = a(5) | 0;
  if (![0, 1252, 65001].includes(cp) || (flags !== 0 && !(cp === 65001 && flags === 8)))
    throw Error('Unsupported MultiByteToWideChar codepage/flags');
  if (!input || count === 0 || count < -1 || capacity < 0 || (capacity && !output))
    return fail(r, 87, 6);
  let length = count;
  if (length === -1) {
    length = 0;
    do {
      if (length >= 1048576) throw Error('MultiByteToWideChar input limit');
    } while (r.guestMemory.read(input + length++, 1));
  }
  if (length > 1048576) throw Error('MultiByteToWideChar input limit');
  r.check(input, length);
  const bytes = r.data.subarray(input, input + length);
  let value;
  try {
    value =
      cp === 65001
        ? new TextDecoder('utf-8', { fatal: !!flags, ignoreBOM: true }).decode(bytes)
        : decodeAnsi(bytes);
  } catch {
    return fail(r, 1113, 6);
  }
  if (!capacity) return ok(value.length, 6);
  if (capacity < value.length) return fail(r, 122, 6);
  r.check(output, value.length * 2, true);
  for (let i = 0; i < value.length; i++)
    r.guestMemory.write(output + i * 2, value.charCodeAt(i), 2);
  return ok(value.length, 6);
}
function groupIconCount(bytes) {
  const pe = parsePE(bytes, { allowDll: true });
  const directory = pe.directories[2];
  if (!directory?.rva || !directory.size) return 0;
  const end = directory.rva + directory.size;
  const offsetOf = (rva, size) => {
    if (rva < pe.headersSize && rva + size <= pe.headersSize) return rva;
    const section = pe.sections.find(
      (item) => rva >= item.rva && rva + size <= item.rva + item.rawSize,
    );
    if (!section) throw Error('Shell32 resource data is not file-backed');
    return section.rawOffset + rva - section.rva;
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = (rva) => {
    if (rva < directory.rva || rva + 16 > end) throw Error('Malformed PE resource directory');
    const offset = offsetOf(rva, 16);
    const count = view.getUint16(offset + 12, true) + view.getUint16(offset + 14, true);
    if (count > 4096 || rva + 16 + count * 8 > end) throw Error('Malformed PE resource entries');
    const result = [];
    for (let i = 0; i < count; i++) {
      const name = view.getUint32(offset + 16 + i * 8, true),
        target = view.getUint32(offset + 20 + i * 8, true);
      result.push({ id: name & 0x80000000 ? null : name & 0xffff, target });
    }
    return result;
  };
  for (const type of entries(directory.rva)) {
    if (type.id !== 14 || !(type.target & 0x80000000)) continue; // RT_GROUP_ICON
    const typeRva = directory.rva + (type.target & 0x7fffffff);
    let count = 0;
    for (const group of entries(typeRva)) {
      if (!(group.target & 0x80000000)) continue;
      const languageRva = directory.rva + (group.target & 0x7fffffff);
      if (entries(languageRva).length) count++;
    }
    return count;
  }
  return 0;
}
function iconFile(r, path, wide) {
  let relative;
  try {
    relative = normalizePath(wide ? r.wideString(path) : r.string(path));
  } catch {
    r.lastError = 2;
    return null;
  }
  for (const candidate of [r.cwd + relative, relative]) {
    const basename = candidate.split('/').at(-1).toLowerCase();
    const loaded = r.graph.modules.get(basename);
    if (loaded?.bytes) return loaded.bytes;
    const builtin = r.graph.builtinFiles.get(candidate);
    if (builtin) return builtin;
    const found = [...r.files].find(([name]) => name.toLowerCase() === candidate.toLowerCase());
    if (found) return found[1];
  }
  r.lastError = 2;
  return null;
}
function extractIcon(r, a, wide) {
  const bytes = iconFile(r, a(1), wide);
  if (!bytes) return ok(0, 3);
  let count;
  try {
    count = groupIconCount(bytes);
  } catch {
    r.lastError = 193; // ERROR_BAD_EXE_FORMAT
    return ok(0, 3);
  }
  const index = a(2);
  if (index === 0xffffffff) return ok(count, 3);
  if (index >= count) return ok(0, 3);
  // Do not fabricate an HICON until the runtime has a real icon object.
  throw Error('PE icon resources are not supported');
}
export const processApis = {
  'kernel32.dll!GetProcessHeap': (r) => ok(r.wineProcess?.heap ?? 0x50000000),
  'kernel32.dll!HeapAlloc': heapAlloc,
  'kernel32.dll!HeapFree': heapFree,
  'kernel32.dll!LocalAlloc': localAlloc,
  'kernel32.dll!LocalFree': localFree,
  'kernel32.dll!GetCommandLineW': (r) => commandLine(r, true),
  'kernel32.dll!GetCommandLineA': (r) => commandLine(r, false),
  'kernel32.dll!GetModuleHandleW': (r, a) => moduleHandle(r, a, true),
  'kernel32.dll!GetModuleHandleA': (r, a) => moduleHandle(r, a, false),
  'kernel32.dll!GetProcAddress': procAddress,
  'kernel32.dll!LoadLibraryW': (r, a) => loadLibrary(r, a, true),
  'kernel32.dll!LoadLibraryA': (r, a) => loadLibrary(r, a, false),
  'kernel32.dll!FreeLibrary': freeLibrary,
  'kernel32.dll!GetModuleFileNameW': (r, a) => moduleFilename(r, a, true),
  'kernel32.dll!GetModuleFileNameA': (r, a) => moduleFilename(r, a, false),
  'kernel32.dll!WideCharToMultiByte': wideToMulti,
  'kernel32.dll!MultiByteToWideChar': multiToWide,
  'kernel32.dll!IsDBCSLeadByte': () => ok(0, 1),
  'winebrowser-shell32.dll!ExtractIconA': (r, a) => extractIcon(r, a, false),
  'winebrowser-shell32.dll!ExtractIconW': (r, a) => extractIcon(r, a, true),
  'kernel32.dll!lstrlenW': (r, a) => ok(r.wideString(a(0)).length, 1),
  'kernel32.dll!lstrlenA': (r, a) => ok(r.string(a(0)).length, 1),
  'kernel32.dll!lstrcpyA': (r, a) => ok(writeString(r, a(0), r.string(a(1))), 2),
  'kernel32.dll!lstrcpyW': (r, a) => ok(writeString(r, a(0), r.wideString(a(1)), true), 2),
};
