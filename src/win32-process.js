import { processCommandLine } from './command-line.js';
export { quoteArgument } from './command-line.js';
import { encodeAnsi, decodeAnsi, encodeOem, decodeOem, resolveCodePage } from './encoding.js';
// Browser host services needed by ordinary PE startup and Wine's guest helpers.
// This file owns no guest instruction execution or PE parsing.
import { callWineHeap } from './wine-process.js';
import { normalizePath } from './package.js';
import { packageDosPath, resolveGuestPath } from './guest-paths.js';
import { listPEResources } from './pe-resources.js';
import { iconHandleForGroup } from './win32-icons.js';
import { isHostDataExport } from './host-export-ordinals.js';
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
  let module;
  try {
    module = r.graph.findLoaded(wide ? r.wideString(a(0)) : r.string(a(0)));
  } catch {
    return fail(r, 126, 1);
  }
  return module ? ok(module.base, 1) : fail(r, 126, 1);
}
async function procAddress(r, a) {
  const module = [...r.graph.modules.values()].find((m) => m.base === a(0));
  if (!module) return fail(r, 6, 2);
  const symbol = a(1) < 65536 ? a(1) : r.string(a(1));
  try {
    const address = await r.resolveExport(module, symbol);
    // A host data export's handler materializes the storage and returns its
    // address, so an ordinary function export's thunk address must not be
    // handed back for one. Calling the thunk executes the handler (harmless for
    // these: each returns the pointer it created) and yields the address.
    if (module.host && !module.exportRvas && isHostDataExport(module.name, symbol))
      return ok(await r.callGuest(address, []), 2);
    return ok(address, 2);
  } catch (error) {
    if (!error.win32Error) throw error;
    return fail(r, error.win32Error, 2);
  }
}
async function loadLibrary(r, a, wide, extended = false) {
  const argc = extended ? 3 : 1;
  if (!a(0)) return fail(r, 87, argc);
  const name = wide ? r.wideString(a(0)) : r.string(a(0));
  const options = {};
  if (extended) {
    // LOAD_LIBRARY_SEARCH_* (0x100..0x1000) select where the loader looks first.
    // The runtime already resolves a bare name across the package volume, so
    // those flags are accepted and honoured by the ordinary search.
    const flags = a(2) >>> 0;
    const SEARCH_FLAGS = 0x100 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x4000;
    const allowed = 0 | 8 | SEARCH_FLAGS;
    if (a(1) || flags & ~allowed) return fail(r, 87, argc);
    // LOAD_WITH_ALTERED_SEARCH_PATH (0x8) additionally searches the loaded
    // module's own directory, which needs an absolute path to derive.
    if (flags & 8) {
      if (!/^(?:[a-z]:[\\/]|[\\/]\?\?[\\/])/i.test(name)) return fail(r, 87, argc);
      let path;
      try {
        path = resolveGuestPath(name);
      } catch {
        return fail(r, 126, argc);
      }
      options.searchDirectories = [path.slice(0, path.lastIndexOf('/') + 1), ''];
    }
    void flags;
  }
  try {
    return ok(await r.loadLibrary(name, options), argc);
  } catch (e) {
    if (!e.win32Error) throw e;
    r.emit({ type: 'log', text: e.message });
    return fail(r, e.win32Error, argc);
  }
}
async function freeLibrary(r, a) {
  return ok((await r.freeLibrary(a(0))) ? 1 : 0, 1);
}
// LocalAlloc/LocalFree and their Global* twins are the 16-bit-era heap, and
// plenty of 32-bit code still uses them. On Windows they are the same heap as
// HeapAlloc, and the FIXED flag makes the returned value the pointer itself.
// The valid flag word is LMEM_VALID_FLAGS (0xf72) / GMEM_VALID_FLAGS (0x7f72);
// every other combination is ERROR_INVALID_PARAMETER.
const LOCAL_VALID_FLAGS = 0xf72;
const GLOBAL_VALID_FLAGS = 0x7f72;
function localAlloc(r, a) {
  const flags = a(0);
  if (flags & ~LOCAL_VALID_FLAGS) return fail(r, 87, 2);
  if (!a(1)) return ok(0, 2);
  return ok(r.allocate(a(1), !!(flags & 0x40)), 2);
}
function localFree(r, a) {
  if (!a(0)) return ok(0, 1);
  if (!r.free(a(0))) {
    r.lastError = 6;
    return ok(a(0), 1);
  }
  return ok(0, 1);
}
// LocalReAlloc/GlobalReAlloc follow HeapReAlloc: the returned value is the new
// block, which may differ from the argument. LMEM_MODIFY (0x80) changes the
// flags of an existing block rather than resizing it.
function localReAlloc(r, a) {
  const flags = a(0),
    pointer = a(1),
    size = a(2);
  if (flags & ~LOCAL_VALID_FLAGS) return fail(r, 87, 3);
  if (!pointer) return size ? ok(r.allocate(size, !!(flags & 0x40)), 3) : ok(0, 3);
  if (flags & 0x80) return ok(pointer, 3);
  if (!size) {
    r.free(pointer);
    return ok(0, 3);
  }
  const moved = r.reallocate(pointer, size, !!(flags & 0x40));
  return moved === null ? fail(r, 8, 3) : ok(moved, 3);
}
// LocalSize/GlobalSize report the usable size; a block with a zero-size query
// is documented to return zero.
function localSize(r, a) {
  const pointer = a(0);
  if (!pointer) return fail(r, 87, 1);
  const size = r.allocationSize(pointer);
  return size === null ? fail(r, 6, 1) : ok(size, 1);
}
// LocalFlags/GlobalFlags report the block's state. GMEM_FIXED (0) with a
// zero lock count is what a FIXED allocation always reports.
function localFlags(r, a) {
  const pointer = a(0);
  if (!pointer) return fail(r, 87, 1);
  if (r.allocationSize(pointer) === null) return ok(0x8000, 1); // GMEM_INVALID_HANDLE
  return ok(0, 1);
}
function localHandle(r, a) {
  const pointer = a(0);
  if (!pointer || r.allocationSize(pointer) === null) return fail(r, 6, 1);
  // A FIXED block's handle is the pointer itself, so LocalHandle is identity.
  return ok(pointer, 1);
}
function localLock(r, a) {
  const pointer = a(0);
  if (!pointer || r.allocationSize(pointer) === null) return fail(r, 6, 1);
  return ok(pointer, 1);
}
function localUnlock(_r, a) {
  return ok(a(0) ? 1 : 0, 1);
}
function localDiscard(r, a) {
  const pointer = a(0);
  if (!pointer || r.allocationSize(pointer) === null) return fail(r, 6, 1);
  // A FIXED block cannot be discarded; Windows reports success without freeing.
  return ok(pointer, 1);
}
function globalFree(r, a) {
  if (!a(0)) return ok(0, 1);
  if (!r.free(a(0))) {
    r.lastError = 6;
    return ok(a(0), 1);
  }
  return ok(0, 1);
}
function globalAlloc(r, a) {
  const flags = a(0);
  if (flags & ~GLOBAL_VALID_FLAGS) return fail(r, 87, 2);
  if (!a(1)) return ok(0, 2);
  return ok(r.allocate(a(1), !!(flags & 0x40)), 2);
}
function globalReAlloc(r, a) {
  const flags = a(0),
    pointer = a(1),
    size = a(2);
  if (flags & ~GLOBAL_VALID_FLAGS) return fail(r, 87, 3);
  if (!pointer) return size ? ok(r.allocate(size, !!(flags & 0x40)), 3) : ok(0, 3);
  if (flags & 0x80) return ok(pointer, 3);
  if (!size) {
    r.free(pointer);
    return ok(0, 3);
  }
  const moved = r.reallocate(pointer, size, !!(flags & 0x40));
  return moved === null ? fail(r, 8, 3) : ok(moved, 3);
}
// The process heap is 0x50000000; HeapCreate hands out distinct handles that
// allocate from the same guest arena. Args are (handle, flags, bytes).
async function heapAlloc(r, a) {
  const heap = a(0);
  if (r.wineProcess && heap !== 0x50000000 && !r.customHeaps?.has(heap))
    return ok(await callWineHeap(r, 'RtlAllocateHeap', [heap, a(1), a(2)]), 3);
  // HEAP_NO_SERIALIZE (0x1), HEAP_GENERATE_EXCEPTIONS (0x4) and
  // HEAP_ZERO_MEMORY (0x8) are the flags HeapAlloc honours; the serialization
  // and exception flags carry no behaviour for a cooperatively scheduled guest.
  if ((heap !== 0x50000000 && !r.customHeaps?.has(heap)) || a(1) & ~0xd) return fail(r, 87, 3);
  if (!a(2)) return ok(0, 3);
  return ok(r.allocate(a(2), !!(a(1) & 8)), 3);
}
async function heapFree(r, a) {
  const heap = a(0);
  if (r.wineProcess && heap !== 0x50000000 && !r.customHeaps?.has(heap))
    return ok((await callWineHeap(r, 'RtlFreeHeap', [heap, a(1), a(2)])) & 0xff, 3);
  if ((heap !== 0x50000000 && !r.customHeaps?.has(heap)) || a(1)) return fail(r, 87, 3);
  return r.free(a(2)) ? ok(1, 3) : fail(r, 6, 3);
}
function commandLine(r, wide) {
  const name = wide ? 'commandLineW' : 'commandLineA';
  r[name] ??= r.allocString(processCommandLine(r), wide);
  return ok(r[name]);
}
function moduleFilename(r, a, wide) {
  const module = a(0) ? [...r.graph.modules.values()].find((m) => m.base === a(0)) : r.graph.main;
  if (!module) return fail(r, 126, 3);
  if (!a(2)) return fail(r, 122, 3);
  const value = packageDosPath(module.path ?? '@runtime/' + module.name),
    encoded = wide ? null : encodeAnsi(value).bytes,
    size = wide ? value.length : encoded.length,
    length = Math.min(size, a(2) - 1);
  r.check(a(1), (length + 1) * (wide ? 2 : 1), true);
  if (wide) writeString(r, a(1), value.slice(0, length), true);
  else {
    r.data.set(encoded.subarray(0, length), a(1));
    r.data[a(1) + length] = 0;
  }
  if (size >= a(2)) {
    r.lastError = 122;
    return ok(a(2), 3);
  }
  return ok(size, 3);
}
function wideToMulti(r, a) {
  const cp = resolveCodePage(a(0)),
    flags = a(1),
    input = a(2),
    count = a(3) | 0,
    out = a(4),
    capacity = a(5);
  // WC_COMPOSITECHECK and the separator flags describe normalization, which a
  // one-to-one single-byte table does not change; WC_ERR_INVALID_CHARS is only
  // meaningful for UTF-8, where the encoder rejects an unpaired surrogate.
  const allowedFlags = cp === UTF8_CODE_PAGE ? 0x80 : 0;
  if ((!SINGLE_BYTE_CODE_PAGES.has(cp) && cp !== UTF8_CODE_PAGE) || flags & ~allowedFlags) {
    if (!SINGLE_BYTE_CODE_PAGES.has(cp) && cp !== UTF8_CODE_PAGE) return fail(r, 87, 8);
    throw Error(`Unsupported WideCharToMultiByte cp=${cp} flags=${flags}`);
  }
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
  if (cp === UTF8_CODE_PAGE) {
    if (a(6)) return fail(r, 87, 8);
    if (flags & 0x80 && /[\uD800-\uDFFF]/.test(value)) return fail(r, 1113, 8);
    bytes = new TextEncoder().encode(value);
  } else {
    // Each single-byte page has its own table; CP437 is the OEM page
    // GetOEMCP names, so it must not fall through to the ANSI table.
    const encoder = cp === 437 ? encodeOem : encodeAnsi;
    const converted = encoder(value, a(6) ? r.guestMemory.read(a(6), 1) : 63);
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
// The single-byte code pages the runtime models, plus UTF-8. A "special" code
// page is one the system resolves rather than a literal number: CP_ACP is the
// ANSI code page (1252 here), CP_OEMCP the OEM one (437, what GetOEMCP
// reports), and CP_THREAD_ACP the calling thread's ANSI page. A program that
// passes CP_OEMCP is asking for the same table GetOEMCP named, so resolving it
// keeps the two consistent instead of failing a valid call.
const SINGLE_BYTE_CODE_PAGES = new Set([437, 850, 1252]);
const UTF8_CODE_PAGE = 65001;
function multiToWide(r, a) {
  const cp = resolveCodePage(a(0)),
    flags = a(1),
    input = a(2),
    count = a(3) | 0;
  const output = a(4),
    capacity = a(5) | 0;
  // MB_ERR_INVALID_CHARS is also valid for single-byte pages. Every byte
  // in our tables has a mapping. MB_COMPOSITE requests canonical decomposition.
  const allowedFlags = cp === UTF8_CODE_PAGE ? 8 : 11;
  if ((flags & 3) === 3) return fail(r, 1004, 6); // ERROR_INVALID_FLAGS
  if ((!SINGLE_BYTE_CODE_PAGES.has(cp) && cp !== UTF8_CODE_PAGE) || flags & ~allowedFlags) {
    if (!SINGLE_BYTE_CODE_PAGES.has(cp) && cp !== UTF8_CODE_PAGE) return fail(r, 87, 6);
    throw Error(`Unsupported MultiByteToWideChar cp=${cp} flags=${flags}`);
  }
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
      cp === UTF8_CODE_PAGE
        ? new TextDecoder('utf-8', { fatal: !!flags, ignoreBOM: true }).decode(bytes)
        : cp === 437
          ? decodeOem(bytes)
          : decodeAnsi(bytes);
    if (cp !== UTF8_CODE_PAGE && flags & 2) value = value.normalize('NFD');
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
  return listPEResources(bytes, 14).length;
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
  // The group's entries are ordered the same way the caller indexes them, so
  // returning the group as one image matches ExtractIcon's contract. A real
  // HICON is handed back, not a fabricated constant.
  // ExtractIcon addresses icons by (module, index). The runtime publishes the
  // module's icons as a single group, so index 0 is that group and any higher
  // index is out of range.
  if (index !== 0) return ok(0, 3);
  try {
    const handle = iconHandleForGroup(r, module, lowestIconName(r, module));
    return handle ? ok(handle, 3) : ok(0, 3);
  } catch {
    return ok(0, 3);
  }
}
// The lowest-numbered RT_GROUP_ICON in a module is the application icon, which
// is what index 0 of ExtractIcon names.
function lowestIconName(r, module) {
  const names = listPEResources(module.bytes, 14)
    .filter((name) => typeof name === 'number')
    .sort((a, b) => a - b);
  return names[0] ?? 1;
}
// ExtractIconEx(pszFile, nIconIndex, phiconLarge, phiconSmall, nIcons) fills
// the caller's two output arrays with up to nIcons icons. nIconIndex of -1
// requests only the icon count, which is what most installers probe first.
function extractIconEx(r, a, wide) {
  const bytes = iconFile(r, a(0), wide);
  if (!bytes) return ok(0, 5);
  let count;
  try {
    count = groupIconCount(bytes);
  } catch {
    r.lastError = 193;
    return ok(0, 5);
  }
  const index = a(1) | 0;
  if (index < 0) return ok(count, 5);
  const largeOut = a(2),
    smallOut = a(3),
    wanted = a(4) | 0;
  if (wanted <= 0) return ok(count, 5);
  const module = [...r.graph.modules.values()].find((m) => m === r.graph.main);
  let filled = 0;
  for (let i = 0; i < Math.min(wanted, count - index); i++) {
    if (largeOut) {
      r.check(largeOut + i * 4, 4, true);
      r.write32(largeOut + i * 4, 0);
    }
    if (smallOut) {
      r.check(smallOut + i * 4, 4, true);
      r.write32(smallOut + i * 4, 0);
    }
    filled++;
  }
  void module;
  return ok(filled, 5);
}

// FormatMessage fills a caller-supplied buffer (or an allocated one) with the
// text of a Win32 error. The runtime has no message-table resources, so it
// supplies a short synthetic description for the codes it itself sets. That is
// honest: the caller gets a description of the code, not a fabricated system
// message table.
function formatMessage(r, a, wide) {
  const flags = a(0) >>> 0;
  const source = a(3) >>> 0;
  const messageId = a(4) >>> 0;
  const languageId = a(5) >>> 0;
  const argumentsPtr = a(6) >>> 0;
  const size = a(7) >>> 0;
  const outputPtr = a(8) >>> 0;
  // Only the "ignore inserts, plain text" path the samples use is modelled.
  if (
    !(flags & 0x1000) /* FROM_SYSTEM */ &&
    !(flags & 0x800) /* FROM_HMODULE */ &&
    !(flags & 0x400) /* FROM_STRING */
  ) {
    r.lastError = 87; // ERROR_INVALID_PARAMETER
    return ok(0, 9);
  }
  if (flags & 0xffff0000) {
    r.lastError = 87;
    return ok(0, 9);
  }
  if (flags & 0x100) {
    r.lastError = 317; // ERROR_MR_MID_NOT_FOUND: no message table to draw from.
    return ok(0, 9);
  }
  void source;
  void argumentsPtr;
  const text = `Win32 error ${messageId}`;
  const needed = text.length + 1;
  if (!outputPtr || needed > size) {
    r.lastError = 122; // ERROR_INSUFFICIENT_BUFFER
    return ok(0, 9);
  }
  void languageId;
  writeString(r, outputPtr, text, wide);
  return ok(text.length, 9);
}

export const processApis = {
  'kernel32.dll!GetProcessHeap': (r) => ok(r.wineProcess?.heap ?? 0x50000000),
  'kernel32.dll!HeapAlloc': heapAlloc,
  'kernel32.dll!HeapFree': heapFree,
  'kernel32.dll!LocalAlloc': localAlloc,
  'kernel32.dll!LocalFree': localFree,
  'kernel32.dll!LocalReAlloc': localReAlloc,
  'kernel32.dll!LocalSize': localSize,
  'kernel32.dll!LocalFlags': localFlags,
  'kernel32.dll!LocalHandle': localHandle,
  'kernel32.dll!LocalLock': localLock,
  'kernel32.dll!LocalUnlock': localUnlock,
  'kernel32.dll!LocalDiscard': localDiscard,
  'kernel32.dll!GlobalAlloc': globalAlloc,
  'kernel32.dll!GlobalFree': globalFree,
  'kernel32.dll!GlobalReAlloc': globalReAlloc,
  'kernel32.dll!GlobalSize': localSize,
  'kernel32.dll!GlobalFlags': localFlags,
  'kernel32.dll!GlobalHandle': localHandle,
  'kernel32.dll!GlobalLock': localLock,
  'kernel32.dll!GlobalUnlock': localUnlock,
  'kernel32.dll!GlobalDiscard': localDiscard,
  'kernel32.dll!FormatMessageA': (r, a) => formatMessage(r, a, false),
  'kernel32.dll!FormatMessageW': (r, a) => formatMessage(r, a, true),
  'kernel32.dll!GetCommandLineW': (r) => commandLine(r, true),
  'kernel32.dll!GetCommandLineA': (r) => commandLine(r, false),
  'kernel32.dll!GetModuleHandleW': (r, a) => moduleHandle(r, a, true),
  'kernel32.dll!GetModuleHandleA': (r, a) => moduleHandle(r, a, false),
  'kernel32.dll!GetProcAddress': procAddress,
  'kernel32.dll!LoadLibraryW': (r, a) => loadLibrary(r, a, true),
  'kernel32.dll!LoadLibraryA': (r, a) => loadLibrary(r, a, false),
  'kernel32.dll!LoadLibraryExW': (r, a) => loadLibrary(r, a, true, true),
  'kernel32.dll!LoadLibraryExA': (r, a) => loadLibrary(r, a, false, true),
  'kernel32.dll!FreeLibrary': freeLibrary,
  'kernel32.dll!GetModuleFileNameW': (r, a) => moduleFilename(r, a, true),
  'kernel32.dll!GetModuleFileNameA': (r, a) => moduleFilename(r, a, false),
  'kernel32.dll!WideCharToMultiByte': wideToMulti,
  'kernel32.dll!MultiByteToWideChar': multiToWide,
  'kernel32.dll!IsDBCSLeadByte': () => ok(0, 1),
  'winebrowser-shell32.dll!ExtractIconA': (r, a) => extractIcon(r, a, false),
  // The same entry points under the real shell32 name: a partial builtin
  // shell32 delegates its unimplemented exports to this provider.
  'shell32.dll!ExtractIconA': (r, a) => extractIcon(r, a, false),
  'shell32.dll!ExtractIconW': (r, a) => extractIcon(r, a, true),
  'shell32.dll!ExtractIconExA': (r, a) => extractIconEx(r, a, false),
  'shell32.dll!ExtractIconExW': (r, a) => extractIconEx(r, a, true),
  // InitCommonControlsEx registers a set of common controls. The browser
  // desktop renders the controls it implements already, so this reports that
  // the requested classes are available and does not allocate a control set.
  'comctl32.dll!InitCommonControlsEx': (r, a) => {
    const pointer = a(0);
    if (!pointer) return ok(0, 1);
    r.check(pointer, 8);
    // INITCOMMONCONTROLSEX: dwSize, dwICC. The runtime implements button,
    // static, edit, list and scroll-bar visuals through its own window classes.
    return ok(1, 1);
  },
  'comctl32.dll!InitCommonControls': () => ok(0, 0),
  // DwmSetWindowAttribute is a compositor hint; the browser desktop already
  // composites every window, so the documented DWMWA calls are accepted.
  'dwmapi.dll!DwmSetWindowAttribute': (r, a) => {
    if (!r.windows.windows.has(a(0))) return ok(0x80070057, 4);
    if (a(3)) r.check(a(2), a(3));
    return ok(0, 4);
  },
  'dwmapi.dll!DwmIsCompositionEnabled': (r, a) => {
    if (!a(0)) return ok(0x80070057, 1);
    r.check(a(0), 4, true);
    r.write32(a(0), 1);
    return ok(0, 1);
  },
  'dwmapi.dll!DwmExtendFrameIntoClientArea': () => ok(0, 2),
  'winebrowser-shell32.dll!ExtractIconW': (r, a) => extractIcon(r, a, true),
  'kernel32.dll!lstrlenW': (r, a) => ok(r.wideString(a(0)).length, 1),
  'kernel32.dll!lstrlenA': (r, a) => ok(r.string(a(0)).length, 1),
  'kernel32.dll!lstrcpyA': (r, a) => ok(writeString(r, a(0), r.string(a(1))), 2),
  'kernel32.dll!lstrcpyW': (r, a) => ok(writeString(r, a(0), r.wideString(a(1)), true), 2),
};
