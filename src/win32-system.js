import { virtualNames, matchWildcard } from './guest-directory.js';
// Process, resource, TLS and filesystem-enumeration services that ordinary
// Win32 applications import. Everything answers from the runtime's own model:
// mapped guest modules, the virtual filesystem, and the per-thread TEB.
import { listPEResources, readPEResource } from './pe-resources.js';
import { environmentEntries } from './guest-environment.js';
import { resolveGuestPath, packageDosPath } from './guest-paths.js';
import { encodeAnsi } from './encoding.js';
import { fileMetadata, fileIdentity } from './file-metadata.js';
import { protectMemory } from './memory-protection.js';
import { PROCESS_LAYOUT } from './process-layout.js';
import { guestHandleRecord, guestHandleFlags } from './wine-object.js';
import { processLookup } from './process-session.js';

const ok = (result = 0, argc = 0) => ({ result, argc });
const fail = (r, error, argc = 0, value = 0) => {
  r.lastError = error;
  return ok(value, argc);
};

// ---------------------------------------------------------------------------
// Module resources. The runtime keeps every module's original file bytes, so a
// resource lookup walks the real PE resource directory rather than a table of
// fabricated handles.
function moduleBytes(r, handle) {
  if (!handle) return r.files.get(r.exe) ?? null;
  const module = [...r.graph.modules.values()].find((m) => m.base === handle >>> 0);
  if (!module) return null;
  return r.files.get(module.path) ?? null;
}
function resourceHandle(r, module, bytes, type, name) {
  const payload = readPEResource(bytes, type, name);
  if (!payload) return 0;
  const address = r.allocate(payload.length || 1);
  r.data.set(payload, address);
  r.resourceHandles ??= new Map();
  r.resourceHandles.set(address, { module, bytes, payload, loads: 0 });
  return address;
}
function findResourceA(r, a) {
  const module = a(0);
  const bytes = moduleBytes(r, module);
  if (!bytes) return fail(r, 1813, 3); // ERROR_RESOURCE_TYPE_NOT_FOUND
  const name = a(1) < 65536 ? a(1) : r.string(a(1));
  const type = a(2) < 65536 ? a(2) : r.string(a(2));
  const handle = resourceHandle(r, module, bytes, type, name);
  if (!handle) return fail(r, 1813, 3);
  return ok(handle, 3);
}
function resourceEntry(r, a, argc) {
  const entry = r.resourceHandles?.get(a(0) >>> 0);
  if (!entry) return fail(r, 1812, argc); // ERROR_RESOURCE_DATA_NOT_FOUND
  return entry;
}
function sizeOfResource(r, a) {
  const entry = resourceEntry(r, a, 2);
  return entry.result !== undefined && entry.result === 0 && r.lastError
    ? entry
    : ok(entry.payload.length, 2);
}
function loadResource(r, a) {
  const entry = resourceEntry(r, a, 2);
  if (entry.payload === undefined) return entry;
  entry.loads++;
  return ok(a(0) >>> 0, 2);
}
function lockResource(r, a) {
  const entry = r.resourceHandles?.get(a(0) >>> 0);
  if (!entry) return fail(r, 1813, 1);
  return ok(a(0) >>> 0, 1);
}
function freeResource(r, a) {
  const address = a(0) >>> 0;
  if (r.resourceHandles?.delete(address)) r.free(address);
  return ok(0, 1);
}

// ---------------------------------------------------------------------------
// Dynamic thread-local storage, matching the documented i386 TEB layout Wine's
// kernelbase uses:
//   TEB.TlsSlots[64]           fs:[0xe10]  slots 0..63
//   TEB.TlsExpansionSlots      fs:[0xf94]  pointer to 1024 more slots
//   PEB.TlsBitmapBits[2]       peb+0x44    allocation bits for the fixed slots
//   PEB.TlsExpansionBitmapBits peb+0x154   allocation bits for the expansion
// The static image TLS vector is a *different* field (TEB at fs:[0x2c]); writing
// dynamic slots there would clobber every module's __declspec(thread) data.
const TLS_MINIMUM_AVAILABLE = 64,
  TLS_EXPANSION_SLOTS = 1024,
  TLS_OUT_OF_INDEXES = 0xffffffff,
  TEB_TLS_SLOTS = 0xe10,
  TEB_TLS_EXPANSION = 0xf94,
  PEB_TLS_BITMAP_BITS = 0x44,
  PEB_TLS_EXPANSION_BITS = 0x154;
const bitSet = (r, address, index) => (r.read32(address + (index >> 5) * 4) >>> (index & 31)) & 1;
function setBit(r, address, index, value) {
  const word = address + (index >> 5) * 4,
    mask = 1 << (index & 31),
    current = r.read32(word) >>> 0;
  r.write32(word, (value ? current | mask : current & ~mask) >>> 0);
}

// ---------------------------------------------------------------------------
// Fiber-local storage (FLS). A fiber is the unit FLS binds to, and the runtime
// has one implicit fiber per guest thread. Its values must be independent of
// TEB.TlsSlots: CRTs often allocate the same numeric index in both namespaces.
function flsState(r) {
  r.fls ??= { bitmap: null, destructors: new Map(), values: new Map() };
  if (!r.fls.bitmap) {
    // FLS_ACCESS_CODE marks the process-wide table; one bit per slot.
    r.fls.bitmap = r.allocate(16);
    r.data.fill(0, r.fls.bitmap, r.fls.bitmap + 16);
  }
  return r.fls;
}
const FLS_OUT_OF_INDEXES = 0xffffffff;
function flsAlloc(r, a) {
  const state = flsState(r);
  const destructor = a(0) >>> 0;
  for (let index = 0; index < 128; index++) {
    const byte = state.bitmap + (index >> 3);
    const mask = 1 << (index & 7);
    if (r.data[byte] & mask) continue;
    r.data[byte] |= mask;
    if (destructor) state.destructors.set(index, destructor);
    for (const values of state.values.values()) values.delete(index);
    return ok(index, 1);
  }
  r.lastError = 18;
  return ok(FLS_OUT_OF_INDEXES, 1);
}
function flsIndex(r, index) {
  if (index >= 128) return null;
  const state = flsState(r);
  const byte = state.bitmap + (index >> 3);
  return r.data[byte] & (1 << (index & 7)) ? index : null;
}
function flsValues(r) {
  const state = flsState(r),
    teb = r.cpu.fsBase >>> 0;
  if (!state.values.has(teb)) state.values.set(teb, new Map());
  return state.values.get(teb);
}
function flsSetValue(r, a) {
  const index = flsIndex(r, a(0) >>> 0);
  if (index === null) return fail(r, 87, 2);
  flsValues(r).set(index, a(1) >>> 0);
  return ok(1, 2);
}
function flsGetValue(r, a) {
  const index = flsIndex(r, a(0) >>> 0);
  if (index === null) return fail(r, 87, 1);
  r.lastError = 0;
  return ok(flsValues(r).get(index) ?? 0, 1);
}
async function flsFree(r, a) {
  const index = flsIndex(r, a(0) >>> 0);
  if (index === null) return fail(r, 87, 1);
  const state = flsState(r);
  r.data[state.bitmap + (index >> 3)] &= ~(1 << (index & 7));
  const destructor = state.destructors.get(index);
  state.destructors.delete(index);
  const pending = [];
  for (const values of state.values.values()) {
    const value = values.get(index);
    values.delete(index);
    if (destructor && value) pending.push(value);
  }
  for (const value of pending) await r.callGuest(destructor, [value]);
  return ok(1, 1);
}
// FlsSetValue's fiber argument: the runtime has one fiber per thread, so a zero
// fiber means the calling one and any other value is invalid.
function flsFiber(r, a, argc) {
  if (a(0)) return null;
  void argc;
  return r.threads?.current ?? null;
}

function tlsAlloc(r) {
  // The fixed 64 slots come first, then the 1024 slot expansion table.
  for (let index = 0; index < TLS_MINIMUM_AVAILABLE + TLS_EXPANSION_SLOTS; index++) {
    const inExpansion = index >= TLS_MINIMUM_AVAILABLE,
      bit = inExpansion ? index - TLS_MINIMUM_AVAILABLE : index,
      address = PROCESS_LAYOUT.peb + (inExpansion ? PEB_TLS_EXPANSION_BITS : PEB_TLS_BITMAP_BITS);
    if (bitSet(r, address, bit)) continue;
    setBit(r, address, bit, 1);
    // A newly allocated slot is cleared in the calling thread, as documented.
    if (inExpansion) {
      const slots = expansionSlots(r, true);
      r.write32(slots + (index - TLS_MINIMUM_AVAILABLE) * 4, 0);
    } else r.write32(r.cpu.fsBase + TEB_TLS_SLOTS + index * 4, 0);
    return ok(index, 0);
  }
  r.lastError = 18; // ERROR_NO_MORE_ITEMS
  return ok(TLS_OUT_OF_INDEXES, 0);
}
// The expansion array is a lazily allocated block of 1024 pointers.
function expansionSlots(r, create) {
  const pointer = r.read32(r.cpu.fsBase + TEB_TLS_EXPANSION);
  if (pointer || !create) return pointer;
  const created = r.allocate(TLS_EXPANSION_SLOTS * 4, true);
  r.write32(r.cpu.fsBase + TEB_TLS_EXPANSION, created);
  r.dynamicTlsAllocations ??= new Set();
  r.dynamicTlsAllocations.add(created);
  return created;
}
function tlsIndex(r, index) {
  return index < TLS_MINIMUM_AVAILABLE + TLS_EXPANSION_SLOTS ? index : null;
}
function tlsFree(r, a) {
  const index = tlsIndex(r, a(0) >>> 0);
  if (index === null) return fail(r, 87, 1);
  const inExpansion = index >= TLS_MINIMUM_AVAILABLE,
    bit = inExpansion ? index - TLS_MINIMUM_AVAILABLE : index,
    address = PROCESS_LAYOUT.peb + (inExpansion ? PEB_TLS_EXPANSION_BITS : PEB_TLS_BITMAP_BITS);
  if (!bitSet(r, address, bit)) return fail(r, 87, 1);
  setBit(r, address, bit, 0);
  // Freeing clears the slot in every thread's array, which Wine does through
  // NtSetInformationThread(ThreadZeroTlsCell).
  if (!inExpansion) r.write32(r.cpu.fsBase + TEB_TLS_SLOTS + index * 4, 0);
  else {
    const slots = expansionSlots(r, false);
    if (slots) r.write32(slots + (index - TLS_MINIMUM_AVAILABLE) * 4, 0);
  }
  return ok(1, 1);
}
function tlsSetValue(r, a) {
  const index = tlsIndex(r, a(0) >>> 0);
  if (index === null) return fail(r, 87, 2);
  if (index < TLS_MINIMUM_AVAILABLE)
    r.write32(r.cpu.fsBase + TEB_TLS_SLOTS + index * 4, a(1) >>> 0);
  else {
    const slots = expansionSlots(r, true);
    r.write32(slots + (index - TLS_MINIMUM_AVAILABLE) * 4, a(1) >>> 0);
  }
  return ok(1, 2);
}
function tlsGetValue(r, a) {
  const index = tlsIndex(r, a(0) >>> 0);
  if (index === null) return fail(r, 87, 1);
  // A slot that was never written reads as zero, and GetLastError is cleared.
  r.lastError = 0;
  if (index < TLS_MINIMUM_AVAILABLE)
    return ok(r.read32(r.cpu.fsBase + TEB_TLS_SLOTS + index * 4) >>> 0, 1);
  const slots = expansionSlots(r, false);
  return ok(slots ? r.read32(slots + (index - TLS_MINIMUM_AVAILABLE) * 4) >>> 0 : 0, 1);
}

// ---------------------------------------------------------------------------
// Directory and file system queries answer from the virtual filesystem, which
// is the package's own tree plus anything the guest created at run time.
// The directory part of a resolved guest path, with a trailing slash so the
// file tree can be matched by prefix. The path is already normalized by
// resolveGuestPath, so only a trailing separator has to be removed; a path that
// is already a directory prefix keeps its single slash.
function directoryPrefix(path) {
  if (typeof path !== 'string') throw Error('directoryPrefix requires a path');
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized ? normalized + '/' : '';
}
function writeFindData(r, address, name, info, wide = false) {
  const size = wide ? 592 : 320;
  r.check(address, size, true);
  r.data.fill(0, address, address + size);
  r.write32(address, info.attributes);
  for (const [i, key] of ['creation', 'access', 'write'].entries())
    r.view.setBigInt64(address + 4 + i * 8, info[key], true);
  r.write32(address + 32, info.size);
  const step = wide ? 2 : 1;
  for (let i = 0; i < name.length && i < 259; i++)
    r.guestMemory.write(address + 44 + i * step, name.charCodeAt(i), step);
}
// DOS wildcard matching, the rule CreateFile/FindFirstFile use: `*` matches any
// run of characters (including none), `?` matches exactly one, and both stop at
// the end of the component. Matching is case-insensitive because guest paths are
// normalized to lower case.
// Splits a search pattern into the directory to enumerate and the wildcard to
// match. A name with no wildcard is the exact-name case, where the file itself
// must exist and be returned as the single match.
function searchPattern(resolved) {
  const slash = resolved.lastIndexOf('/');
  const directory = slash < 0 ? '' : resolved.slice(0, slash + 1);
  const pattern = slash < 0 ? resolved : resolved.slice(slash + 1);
  return { directory, pattern };
}

// FindFirstFileA/W is one of the few Win32 calls that reports failure with
// INVALID_HANDLE_VALUE (0xffffffff), not 0. A caller's standard test is
// `handle != INVALID_HANDLE_VALUE`, so returning 0 for a missing file makes it
// believe the search succeeded — the case where a program then treats a file
// that does not exist as present.
function findFailure(r, error) {
  return fail(r, error, 2, 0xffffffff);
}

function findFirstFile(r, a, wide) {
  let resolved;
  try {
    resolved = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
  } catch {
    return findFailure(r, 3);
  }
  // A search only ever names one directory level, so take the prefix from the
  // pattern's last separator rather than treating the whole path as a prefix.
  const { directory, pattern } = searchPattern(resolved);
  const prefix = directoryPrefix(directory);
  // Every entry of the directory is a candidate; a wildcard narrows it by name
  // (DOS wildcards match directories too, which is what `dir` relies on), and a
  // pattern with no wildcard selects the one exact name.
  const available = virtualNames(r, prefix);
  const wildcard = pattern.includes('*') || pattern.includes('?');
  let names;
  if (wildcard) names = new Map([...available].filter(([name]) => matchWildcard(pattern, name)));
  else names = available.has(pattern) ? new Map([[pattern, available.get(pattern)]]) : new Map();
  if (!names.size) return findFailure(r, 2);
  r.findHandles ??= new Map();
  const nextId = (r.nextFindHandle = (r.nextFindHandle ?? 0x51000000) + 4);
  const entries = [...names].map(([name, directoryEntry]) => ({
    name,
    directory: directoryEntry,
  }));
  const first = entries[0];
  writeFindData(r, a(1), first.name, fileMetadata(r, prefix + first.name), wide);
  r.findHandles.set(nextId, { prefix, entries, index: 1 });
  if (r.findHandles.size > 256) r.findHandles.delete(r.findHandles.keys().next().value);
  return ok(nextId, 2);
}
function findNextFile(r, a, wide) {
  const state = r.findHandles?.get(a(0) >>> 0);
  if (!state || state.index >= state.entries.length) return fail(r, 18, 2);
  const entry = state.entries[state.index++];
  writeFindData(r, a(1), entry.name, fileMetadata(r, state.prefix + entry.name), wide);
  return ok(1, 2);
}
function findClose(r, a) {
  return r.findHandles?.delete(a(0) >>> 0) ? ok(1, 1) : fail(r, 6, 1);
}
function createDirectory(r, a, wide) {
  let resolved;
  try {
    resolved = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
  } catch {
    return fail(r, 3, 2);
  }
  r.virtualDirectories ??= new Set();
  if (r.virtualDirectories.has(resolved + '/') || r.files.has(resolved + '/'))
    return fail(r, 183, 2); // ERROR_ALREADY_EXISTS
  r.virtualDirectories.add(resolved + '/');
  return ok(1, 2);
}
function deleteFile(r, a, wide) {
  let resolved;
  try {
    resolved = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
  } catch {
    return fail(r, 3, 2);
  }
  if (!r.files.has(resolved)) return fail(r, 2, 1);
  if (r.fileSections?.canResize(resolved, 0) === false) return fail(r, 5, 1);
  r.files.delete(resolved);
  r.dirty.add(resolved);
  return ok(1, 1);
}
function getWindowsDirectory(r, a, wide) {
  const value = 'C:\\Windows';
  const buffer = a(0);
  if (!buffer) return fail(r, 87, 2);
  const capacity = a(1) | 0;
  if (wide) {
    if (capacity < value.length + 1) return fail(r, 122, 2);
    r.check(buffer, (value.length + 1) * 2, true);
    for (let i = 0; i <= value.length; i++)
      r.guestMemory.write(buffer + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
  } else {
    const bytes = encodeAnsi(value).bytes;
    if (capacity < bytes.length + 1) return fail(r, 122, 2);
    r.check(buffer, bytes.length + 1, true);
    r.data.set(bytes, buffer);
    r.data[buffer + bytes.length] = 0;
  }
  return ok(value.length, 2);
}
function setErrorMode(r, a) {
  const previous = r.errorMode ?? 0;
  if (a(0) & ~0x8003) return fail(r, 87, 1);
  r.errorMode = a(0) >>> 0;
  return ok(previous, 1);
}

// FindFirstFileEx(Pattern, InfoLevel, Data, SearchOp, Filter, Flags): level 0
// and search op 0 are the ordinary directory scan. The extended levels add
// alternate timestamps and the search ops add pattern matching, neither of
// which the runtime models, so those are refused rather than approximated.
function findFirstFileEx(r, a, wide) {
  if ((a(1) | 0) !== 0 || (a(3) | 0) !== 0 || (a(4) | 0) !== 0 || (a(5) | 0) !== 0)
    return findFailure(r, 87);
  return findFirstFile(r, (i) => [a(0), 0, a(2)][i] ?? 0, wide);
}
// GetDateFormat/GetTimeFormatA/W format a SYSTEMTIME with a locale picture
// string. The runtime's locale is the invariant one, so the picture itself
// drives the output and the locale name is accepted but unused.
function getDateTimeFormat(r, a, wide, time) {
  const locale = a(0) >>> 0;
  const flags = a(1) >>> 0;
  const source = a(2);
  const formatPointer = a(3);
  const outPointer = a(4);
  const capacity = a(5) | 0;
  if (locale !== 0x400 && locale !== 0x7f) return fail(r, 87, 6);
  if (flags & ~(0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x100 | 0x200)) return fail(r, 87, 6);
  if (!source) return fail(r, 87, 6);
  const units = Array.from({ length: 8 }, (_, i) => r.guestMemory.read(source + i * 2, 2));
  const [year, month, , day, hour, minute, second] = units;
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const defaultFormat = time ? 'HH:mm:ss' : 'MM/dd/yyyy';
  const picture = formatPointer
    ? wide
      ? r.wideString(formatPointer)
      : r.string(formatPointer)
    : defaultFormat;
  // Substitute the tokens GetDateFormat/GetTimeFormat document. A single-quoted
  // run is literal text, which is how a picture includes a separator verbatim.
  let text = '';
  let literal = false;
  let index = 0;
  const token = (length) => {
    const at = picture.slice(index, index + length);
    index += length;
    return at;
  };
  while (index < picture.length) {
    const ch = picture[index];
    if (ch === "'") {
      literal = !literal;
      index++;
      continue;
    }
    if (literal) {
      text += ch;
      index++;
      continue;
    }
    const remaining = picture.length - index;
    if (time) {
      if (ch === 'H' && remaining >= 2 && picture[index + 1] === 'H') {
        token(2);
        text += pad(hour);
        continue;
      }
      if (ch === 'h') {
        const wide2 = remaining >= 2 && picture[index + 1] === 'h';
        token(wide2 ? 2 : 1);
        const h = hour % 12 || 12;
        text += wide2 ? pad(h) : String(h);
        continue;
      }
      if (ch === 'm' && remaining >= 2 && picture[index + 1] === 'm') {
        token(2);
        text += pad(minute);
        continue;
      }
      if (ch === 's' && remaining >= 2 && picture[index + 1] === 's') {
        token(2);
        text += pad(second);
        continue;
      }
      if (ch === 't' && remaining >= 2 && picture[index + 1] === 't') {
        token(2);
        text += hour < 12 ? 'AM' : 'PM';
        continue;
      }
      if (ch === 't') {
        token(1);
        text += hour < 12 ? 'A' : 'P';
        continue;
      }
    } else {
      if (ch === 'y' && remaining >= 4 && picture.slice(index, index + 4) === 'yyyy') {
        token(4);
        text += pad(year, 4);
        continue;
      }
      if (ch === 'y' && remaining >= 2 && picture[index + 1] === 'y') {
        token(2);
        text += pad(year % 100);
        continue;
      }
      if (ch === 'M' && remaining >= 4 && picture.slice(index, index + 4) === 'MMMM') {
        token(4);
        text += MONTH_NAMES[month - 1] ?? '';
        continue;
      }
      if (ch === 'M' && remaining >= 3 && picture.slice(index, index + 3) === 'MMM') {
        token(3);
        text += (MONTH_NAMES[month - 1] ?? '').slice(0, 3);
        continue;
      }
      if (ch === 'M' && remaining >= 2 && picture[index + 1] === 'M') {
        token(2);
        text += pad(month);
        continue;
      }
      if (ch === 'M') {
        token(1);
        text += String(month);
        continue;
      }
      if (ch === 'd' && remaining >= 4 && picture.slice(index, index + 4) === 'dddd') {
        token(4);
        text += DAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '';
        continue;
      }
      if (ch === 'd' && remaining >= 3 && picture.slice(index, index + 3) === 'ddd') {
        token(3);
        text += (DAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '').slice(0, 3);
        continue;
      }
      if (ch === 'd' && remaining >= 2 && picture[index + 1] === 'd') {
        token(2);
        text += pad(day);
        continue;
      }
      if (ch === 'd') {
        token(1);
        text += String(day);
        continue;
      }
    }
    text += ch;
    index++;
  }
  const needed = text.length + 1;
  if (!outPointer || capacity < needed) return ok(needed, 6);
  if (wide) {
    r.check(outPointer, needed * 2, true);
    for (let i = 0; i <= text.length; i++)
      r.guestMemory.write(outPointer + i * 2, i === text.length ? 0 : text.charCodeAt(i), 2);
  } else {
    const bytes = encodeAnsi(text).bytes;
    r.check(outPointer, bytes.length + 1, true);
    r.data.set(bytes, outPointer);
    r.data[outPointer + bytes.length] = 0;
  }
  return ok(text.length, 6);
}
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getSystemTimeAsFileTime(r, a) {
  const address = a(0);
  if (!address) return fail(r, 87, 1);
  r.check(address, 8, true);
  // 100 ns intervals since 1601-01-01, matching the shared-user-data clock.
  const value = BigInt(r.systemNow()) * 10000n + 116444736000000000n;
  r.view.setBigUint64(address, value, true);
  return ok(0, 1);
}
// ---------------------------------------------------------------------------
// Widely imported module, process, path and environment queries that an
// ordinary application reaches before it does any real work. They answer from
// the runtime's own model (mapped modules, the single process identity, the
// package volume) rather than a fabricated table.
// GetModuleHandleExA/W(Flags, NameOrAddress, Module *): GET_MODULE_HANDLE_EX_FLAG_
// FROM_ADDRESS (0x4) takes a pointer instead of a name.
function getModuleHandleEx(r, a, wide) {
  const flags = a(0) >>> 0;
  const nameOrAddress = a(1) >>> 0;
  const out = a(2);
  if (flags & ~0x7) return fail(r, 87, 3);
  if (!out) return fail(r, 87, 3);
  r.check(out, 4, true);
  r.write32(out, 0);
  const pinned = !!(flags & 0x1); // PIN — the module stays loaded for the process.
  let module = null;
  if (flags & 0x4) {
    module = [...r.graph.modules.values()].find(
      (m) => m.base <= nameOrAddress && nameOrAddress < m.base + m.pe.imageSize,
    );
  } else if (!nameOrAddress) {
    module = r.graph.main;
  } else {
    try {
      module = r.graph.findLoaded(wide ? r.wideString(nameOrAddress) : r.string(nameOrAddress));
    } catch {
      return fail(r, 126, 3);
    }
  }
  if (!module) return fail(r, 126, 3);
  if (pinned) ((r.pinnedModules ??= new Set()), r.pinnedModules.add(module.base));
  r.write32(out, module.base);
  return ok(1, 3);
}
// GetSystemDirectoryA/W: the package volume's system directory.
function getSystemDirectory(r, a, wide) {
  return writeCountedString(r, a(1), a(0), 'C:\\Windows\\System32', wide, 2);
}
// A case-insensitive lookup into the runtime's environment. The Win32
// environment is a vector of NAME=VALUE entries shared with the CRT, so this
// walks that vector rather than keeping a second copy.
export function lookupEnvironment(r, name) {
  const key = name.toUpperCase();
  const entries = environmentEntries(r, true);
  for (const entry of entries) {
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    if (entry.slice(0, at).toUpperCase() === key) return entry.slice(at + 1);
  }
  return undefined;
}
// ExpandEnvironmentStringsA/W resolves %NAME% against the runtime environment.
function expandEnvironmentStrings(r, a, wide) {
  const read = (pointer) => (wide ? r.wideString(pointer) : r.string(pointer));
  const source = read(a(0));
  const expanded = source.replace(/%([^%]+)%/g, (whole, name) => {
    const key = name.toUpperCase();
    if (key === 'SYSTEMROOT' || key === 'WINDIR') return 'C:\\Windows';
    if (key === 'SYSTEMDRIVE') return 'C:';
    if (key === 'TEMP' || key === 'TMP') return 'C:\\Windows\\Temp';
    const value = lookupEnvironment(r, name);
    return value === undefined ? whole : value;
  });
  const out = a(1);
  const capacity = a(2) | 0;
  const needed = expanded.length + 1;
  if (!out || capacity < needed) return ok(needed, 3);
  if (wide) {
    r.check(out, needed * 2, true);
    for (let i = 0; i < needed; i++)
      r.guestMemory.write(out + i * 2, i === expanded.length ? 0 : expanded.charCodeAt(i), 2);
  } else {
    const bytes = encodeAnsi(expanded).bytes;
    r.check(out, bytes.length + 1, true);
    r.data.set(bytes, out);
    r.data[out + bytes.length] = 0;
  }
  return ok(expanded.length, 3);
}
// SearchPathA looks a file up in the same places LoadLibrary and CreateFile do:
// the current directory first, then the package volume root.
function searchPath(r, a, wide) {
  const name = wide ? r.wideString(a(1)) : r.string(a(1));
  const out = a(3);
  const capacity = a(4) | 0;
  let resolved = null;
  try {
    const candidate = resolveGuestPath(name, r.cwd);
    if (r.files.has(candidate)) resolved = candidate;
  } catch {
    resolved = null;
  }
  const value = resolved ? packageDosPath(resolved) : null;
  if (!value) return fail(r, 2, 6);
  const needed = value.length + 1;
  if (!out || capacity < needed) return ok(needed, 6);
  if (wide) {
    r.check(out, needed * 2, true);
    for (let i = 0; i < needed; i++)
      r.guestMemory.write(out + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
  } else {
    const bytes = encodeAnsi(value).bytes;
    r.check(out, bytes.length + 1, true);
    r.data.set(bytes, out);
    r.data[out + bytes.length] = 0;
  }
  return ok(value.length, 6);
}
// GetDriveTypeA reports the package volume as a fixed disk.
function getDriveType(r, _a) {
  return ok(3, 1); // DRIVE_FIXED
}
// GetLogicalDrives returns the drive bitmask; only C: exists.
function getLogicalDrives() {
  return ok(1 << 2, 0); // A=bit0, so C is bit 2.
}

// LoadStringA/W(module, uID, lpBuffer, nBufferMax) reads one entry from the
// module's PE RT_STRING table. String resources are blocked 16 per table, so
// the identifier selects both the block and the entry inside it.
const RT_STRING = 6;
function loadString(r, a, wide) {
  const module = a(0) ? [...r.graph.modules.values()].find((m) => m.base === a(0)) : r.graph.main;
  if (!module?.bytes) return fail(r, 6, 4);
  const id = a(1) >>> 0;
  const buffer = a(2);
  const capacity = a(3) | 0;
  if (!id) return fail(r, 87, 4);
  // Wine's LoadStringW selects the block with `(id >> 4) + 1` and the entry
  // inside it with `id & 0x0f`. Block 1's entry 0 therefore holds string 0 (an
  // unused slot) and entry 1 holds string 1; using (id - 1) here would shift
  // every lookup by one and return the neighbouring string.
  const block = (id >> 4) + 1;
  const index = id & 0xf;
  let value = null;
  try {
    const bytes = readPEResource(module.bytes, RT_STRING, block);
    if (bytes) {
      // Each entry in the block is a length-prefixed UTF-16 string.
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let at = 0;
      for (let i = 0; i <= index; i++) {
        if (at + 2 > bytes.length) return fail(r, 1814, 4);
        const length = view.getUint16(at, true);
        at += 2;
        if (i === index) {
          value = '';
          for (let n = 0; n < length; n++)
            value += String.fromCharCode(view.getUint16(at + n * 2, true));
        }
        at += length * 2;
      }
    }
  } catch {
    value = null;
  }
  if (value === null) return fail(r, 1814, 4);
  if (!buffer) return ok(value.length, 4);
  if (capacity <= 0) return ok(0, 4);
  const count = Math.min(value.length, capacity - 1);
  if (wide) {
    if (capacity * 2 < (count + 1) * 2) return fail(r, 122, 4);
    r.check(buffer, (count + 1) * 2, true);
    for (let i = 0; i <= count; i++)
      r.guestMemory.write(buffer + i * 2, i === count ? 0 : value.charCodeAt(i), 2);
  } else {
    const bytes = encodeAnsi(value.slice(0, count)).bytes;
    r.check(buffer, bytes.length + 1, true);
    r.data.set(bytes, buffer);
    r.guestMemory.write(buffer + bytes.length, 0, 1);
    return ok(bytes.length, 4);
  }
  return ok(count, 4);
}

// ---------------------------------------------------------------------------
// Time, string and pointer services PuTTY and other GUI tools import.
// GetLocalTime/GetSystemTime share one SYSTEMTIME writer; the runtime's
// timezone answer is UTC, so local and system time agree.
function writeSystemTime(r, out, date) {
  r.check(out, 16, true);
  const write = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ];
  for (let i = 0; i < 8; i++) {
    r.check(out + i * 2, 2, true);
    r.guestMemory.write(out + i * 2, write[i] & 0xffff, 2);
  }
}
function getLocalTime(r, a) {
  if (!a(0)) return fail(r, 87, 1);
  writeSystemTime(r, a(0), new Date(r.systemNow()));
  return ok(0, 1);
}
// GetTimeZoneInformation reports UTC with no bias and no daylight rule, which
// is the same timezone every other guest service advertises.
function getTimeZoneInformation(r, a) {
  const out = a(0);
  if (!out) return fail(r, 87, 1);
  r.check(out, 172, true);
  r.data.fill(0, out, out + 172);
  r.write32(out, 0); // Bias
  const name = 'UTC';
  for (let i = 0; i <= name.length; i++)
    r.guestMemory.write(out + 4 + i * 2, i === name.length ? 0 : name.charCodeAt(i), 2);
  for (let i = 0; i <= name.length; i++)
    r.guestMemory.write(out + 88 + i * 2, i === name.length ? 0 : name.charCodeAt(i), 2);
  return ok(0, 1); // TIME_ZONE_ID_UNKNOWN: no daylight rule in force
}
// CompareStringA/W compares two strings the way the runtime's own collation
// does: an ordinal, case-insensitive-or-sensitive comparison of UTF-16 units.
// CSTR_LESS_THAN is 1, CSTR_EQUAL is 2, CSTR_GREATER_THAN is 3.
function compareString(r, a, wide) {
  // (Locale, flags, string1, count1, string2, count2). A one-character
  // CRT probe must never treat its count as the address of a wide string.
  const flags = a(1) >>> 0;
  if (flags & ~(0x1 | 0x2 | 0x10000 | 0x20000 | 0x100000)) return fail(r, 1004, 6);
  const string1 = a(2) >>> 0,
    length1 = a(3) | 0;
  const string2 = a(4) >>> 0,
    length2 = a(5) | 0;
  if (!string1 || !string2) return fail(r, 87, 6);
  const read = (pointer, length) => {
    if (length >= 0) {
      let value = '';
      for (let i = 0; i < length; i++)
        value += String.fromCharCode(
          wide ? r.guestMemory.read(pointer + i * 2, 2) : r.guestMemory.read(pointer + i, 1),
        );
      return value;
    }
    return wide ? r.wideString(pointer) : r.string(pointer);
  };
  let left = read(string1, length1),
    right = read(string2, length2);
  if (flags & 0x1) {
    left = left.toUpperCase();
    right = right.toUpperCase();
  }
  const order = left < right ? 1 : left > right ? 3 : 2;
  return ok(order, 6);
}
// EncodePointer/DecodePointer are a process-local cookie transform. The runtime
// uses the identity, so a pointer round-trips exactly.
function encodePointer(r, a) {
  return ok(a(0), 1);
}
// GetFileSizeEx reports the size through a LARGE_INTEGER.
function getFileSizeEx(r, a) {
  const handle = r.handles.get(a(0));
  if (!handle) return fail(r, 6, 2);
  const out = a(1);
  if (!out) return fail(r, 87, 2);
  r.check(out, 8, true);
  const bytes = r.files.get(handle.path)?.length ?? 0;
  r.write32(out, bytes >>> 0);
  r.write32(out + 4, 0);
  return ok(1, 2);
}
// SetFilePointerEx sets the position and reports it through the LARGE_INTEGER
// all at once; the 64-bit distance arrives as a low/high pair.
function setFilePointerEx(r, a) {
  const handle = r.handles.get(a(0));
  if (!handle) return fail(r, 6, 4);
  const method = a(3) >>> 0;
  if (method > 2) return fail(r, 87, 4);
  const low = a(1) | 0;
  const high = a(2) | 0;
  if (high && high !== -1) return fail(r, 87, 4);
  const bytes = r.files.get(handle.path)?.length ?? 0;
  const base = method === 0 ? 0 : method === 1 ? handle.position : bytes;
  const next = base + low;
  if (next < 0) return fail(r, 131, 4);
  handle.position = next;
  const out = a(4);
  if (out) {
    r.check(out, 8, true);
    r.write32(out, next >>> 0);
    r.write32(out + 4, 0);
  }
  return ok(1, 4);
}
// MulDiv multiplies, divides and rounds to nearest, exactly as documented, with
// the result clamped to the signed 32-bit range.
function mulDiv(r, a) {
  const number1 = a(0) | 0,
    number2 = a(1) | 0,
    denominator = a(2) | 0;
  if (!denominator) return ok(0xffffffff, 3);
  const product = BigInt(number1) * BigInt(number2);
  const divisor = BigInt(denominator);
  // Round half away from zero, which is what MulDiv specifies.
  let quotient = product / divisor;
  const remainder = product % divisor;
  if (remainder !== 0n && (remainder < 0n !== divisor < 0n) === false) {
    if (2n * (remainder < 0n ? -remainder : remainder) >= (divisor < 0n ? -divisor : divisor))
      quotient += product < 0n ? -1n : 1n;
  }
  const clamped =
    quotient > 2147483647n ? 2147483647n : quotient < -2147483648n ? -2147483648n : quotient;
  return ok(Number(BigInt.asUintN(32, clamped)), 3);
}
// IsDBCSLeadByteEx: the runtime's code pages are all single-byte except the
// ones that are not, and none of the supported pages has lead bytes.
function isDbcsLeadByteEx(r, a) {
  const codePage = a(0) >>> 0;
  if (
    codePage !== 0 &&
    codePage !== 437 &&
    codePage !== 932 &&
    codePage !== 936 &&
    codePage !== 949 &&
    codePage !== 950
  )
    return fail(r, 87, 2);
  // GB2312, Big5, Shift-JIS and EUC-KR do have lead bytes; the runtime's
  // supported pages are all single-byte, so this reports none.
  return ok(0, 2);
}
// InitializeSListHead records an empty singly-linked list.
function initializeSListHead(r, a) {
  if (!a(0)) return fail(r, 87, 1);
  r.check(a(0), 8, true);
  r.write32(a(0), 0);
  r.write32(a(0) + 4, 0);
  return ok(0, 1);
}

// ---------------------------------------------------------------------------
// Console, environment, pipe and process surfaces PuTTY imports.
// SetEnvironmentVariableA/W updates the same NAME=VALUE vector the CRT shares.
function setEnvironmentVariable(r, a, wide) {
  const name = (wide ? r.wideString(a(0)) : r.string(a(0))) || '';
  if (!name || name.includes('=')) return fail(r, 87, 2);
  const value = a(1) ? (wide ? r.wideString(a(1)) : r.string(a(1))) : null;
  environmentEntries(r, wide);
  const key = name.toUpperCase();
  for (const kind of wide ? ['wide'] : ['ansi']) {
    const list = r.environment[kind];
    const index = list.findIndex((item) => item.slice(0, item.indexOf('=')).toUpperCase() === key);
    if (value === null) {
      if (index >= 0) list.splice(index, 1);
    } else {
      const entry = `${name}=${value}`;
      if (index < 0) list.push(entry);
      else list[index] = entry;
    }
  }
  // The guest's cached environment blocks are stale once an entry changes.
  r.environmentA = 0;
  r.environmentW = 0;
  r.msvcrtData?.delete('_environ');
  r.msvcrtData?.delete('_environ_w');
  return ok(value === null ? 1 : 1, 2);
}
// The console code pages match the process ANSI/OEM pages the runtime reports.
function getConsoleOutputCP() {
  return ok(437, 0);
}
function getConsoleCP() {
  return ok(437, 0);
}
// WriteConsoleW writes UTF-16 text to the console handle's stream. The runtime
// has the same three standard handles WriteFile uses, so this routes there.
function writeConsole(r, a, wide) {
  const handle = a(0) >>> 0;
  if (!r.stdHandles?.has(handle | 0) && handle > 2) return fail(r, 6, 5);
  const pointer = a(1) >>> 0;
  const count = a(2) >>> 0;
  if (count > 0x100000) return fail(r, 87, 5);
  const text = wide
    ? Array.from({ length: count }, (_, i) =>
        String.fromCharCode(r.guestMemory.read(pointer + i * 2, 2)),
      ).join('')
    : new TextDecoder('windows-1252').decode(r.data.subarray(pointer, pointer + count));
  if (text) r.emit({ type: 'stdout', text });
  if (a(3)) {
    r.check(a(3), 4, true);
    r.write32(a(3), count);
  }
  return ok(1, 5);
}
// CreatePipe(PHANDLE read, PHANDLE write, SECURITY_ATTRIBUTES *, SIZE_T): the
// runtime has no inter-process pipe, so this reports failure rather than
// handing back handles that would never carry bytes.
function createPipe(r) {
  return fail(r, 5, 4);
}
function getExitCodeProcess(r, a) {
  const handle = a(0) >>> 0;
  const out = a(1);
  if (!out) return fail(r, 87, 2);
  // Process handles refer to a shared completion record, independent of the
  // lifetime of the launcher and its initial thread handle.
  const found = processLookup(r, handle, 0x400);
  if (found.status) return fail(r, 6, 2);
  r.check(out, 4, true);
  r.write32(out, found.process.done ? found.process.code : 259);
  return ok(1, 2);
}
// SetHandleInformation records the inheritance flag on a runtime handle.
function setHandleInformation(r, a) {
  const handle = a(0) >>> 0;
  const mask = a(1) >>> 0;
  const flags = a(2) >>> 0;
  if (mask & ~3) return fail(r, 87, 3);
  const opened = guestHandleRecord(r, handle);
  if (!opened) return fail(r, 6, 3);
  if (mask & 1) opened.inherit = !!(flags & 1);
  if (mask & 2) opened.protectFromClose = !!(flags & 2);
  return ok(1, 3);
}
function getHandleInformation(r, a) {
  const flags = guestHandleFlags(r, a(0));
  if (flags === null) return fail(r, 6, 2);
  if (!a(1)) return fail(r, 87, 2);
  r.check(a(1), 4, true);
  r.write32(a(1), flags);
  return ok(1, 2);
}
// GetThreadTimes reports the current thread's creation and CPU times. The
// runtime tracks a virtual clock, so the process and kernel times are the
// guest's own performance counter rather than a fabricated value.
function getThreadTimes(r, a) {
  const found = r.threads?.lookup?.(a(0) >>> 0, 0);
  if (found?.status) return fail(r, found.status, 4);
  const ticks = r.performanceClock ? r.performanceClock.read() : 0n;
  const write = (pointer) => {
    if (!pointer) return;
    r.check(pointer, 8, true);
    r.write32(pointer, Number(ticks & 0xffffffffn));
    r.write32(pointer + 4, Number((ticks >> 32n) & 0xffffffffn));
  };
  for (const index of [1, 2, 3]) write(a(index));
  return ok(1, 4);
}
// LocalFileTimeToFileTime and FileTimeToLocalFileTime: the runtime's timezone
// is UTC, so local time equals system time and both are the identity.
function localFileTimeToFileTime(r, a) {
  if (!a(0) || !a(1)) return fail(r, 87, 2);
  r.check(a(0), 8);
  r.check(a(1), 8, true);
  for (let i = 0; i < 8; i++) r.data[a(1) + i] = r.data[a(0) + i];
  return ok(1, 2);
}

// GetOverlappedResult(HANDLE, OVERLAPPED *, DWORD *Transferred, BOOL Wait).
// Every handle the runtime opens completes synchronously, so a completed
// operation reports its byte count immediately; waiting on an operation that
// never started reports ERROR_INVALID_PARAMETER as documented.
function getOverlappedResult(r, a) {
  const handle = a(0) >>> 0;
  const overlapped = a(1);
  const transferred = a(2);
  const wait = a(3) >>> 0;
  if (!r.handles.has(handle) && handle > 2) return fail(r, 6, 4);
  if (!overlapped) return fail(r, ERROR_INVALID_PARAMETER, 4);
  r.check(overlapped, 20);
  if (transferred) {
    r.check(transferred, 4, true);
    r.write32(transferred, 0);
  }
  void wait;
  // A synchronous handle has no pending operation, so this reports success with
  // zero bytes transferred rather than blocking forever.
  return ok(1, 4);
}
// ReadConsoleW reads UTF-16 characters from a console handle. The runtime's
// console input has no host source (the browser has no stdin), so a read
// reports failure rather than a fabricated character.
function readConsole(r, a) {
  const handle = a(0) >>> 0;
  if (!r.stdHandles?.has(handle | 0) && handle > 2) return fail(r, 6, 5);
  return fail(r, 6, 5);
}

function virtualQuery(r, a) {
  const address = a(0) >>> 0,
    out = a(1),
    size = a(2) >>> 0;
  if (!out || !size) return fail(r, 87, 3);
  const range = r.virtualMemory.rangeFor(address);
  if (!range) return ok(0, 3);
  const start = range.base,
    end = range.end;
  r.check(out, Math.min(size, 28), true);
  r.data.fill(0, out, out + Math.min(size, 28));
  const committed = range.committed.some((run) => address >= run[0] && address < run[1]);
  const protection = committed ? 0x04 : 0x01; // PAGE_READWRITE / PAGE_NOACCESS.
  const base = committed
    ? range.committed.find((run) => address >= run[0] && address < run[1])[0]
    : start;
  r.write32(out, base);
  r.write32(out + 4, start);
  r.write32(out + 8, protection);
  r.write32(out + 12, (end - start) >>> 0);
  r.write32(out + 16, committed ? 0x1000 : 0x2000);
  r.write32(out + 20, protection);
  return ok(28, 3);
}
function virtualProtect(r, a) {
  const address = a(0) >>> 0,
    size = a(1) >>> 0,
    protect = a(2) >>> 0,
    out = a(3);
  // The requested page protection passes through unchanged: the allocator
  // stores the real value, so PAGE_EXECUTE_* is honoured for private memory
  // instead of being flattened to read/write.
  const result = protectMemory(r, address, size, protect);
  if (result.status) return fail(r, 87, 4);
  if (out) {
    r.check(out, 4, true);
    r.write32(out, result.oldProtect ?? 0x04);
  }
  return ok(1, 4);
}
function heapValidate(r, a) {
  const heap = a(0);
  if (heap !== 0x50000000 && !r.customHeaps?.has(heap)) return fail(r, 6, 3);
  if (a(2) && r.allocationSize(a(2)) === null) return fail(r, 6, 3);
  return ok(1, 3);
}

export const systemApis = {
  'kernel32.dll!FindResourceA': (r, a) => findResourceA(r, a),
  'kernel32.dll!FindResourceW': (r, a) => findResourceA(r, a),
  // FindResourceExA(dwModule, lpType, lpName, wLanguage). The runtime stores one
  // payload per name, so the requested language does not change the result.
  'kernel32.dll!FindResourceExA': (r, a) => findResourceA(r, (index) => a([0, 2, 1][index] ?? 0)),
  'kernel32.dll!SizeofResource': sizeOfResource,
  'kernel32.dll!LoadResource': loadResource,
  'kernel32.dll!LockResource': lockResource,
  'kernel32.dll!FreeResource': freeResource,
  'kernel32.dll!TlsAlloc': tlsAlloc,
  'kernel32.dll!TlsFree': tlsFree,
  'kernel32.dll!FlsAlloc': flsAlloc,
  'kernel32.dll!FlsFree': flsFree,
  'kernel32.dll!FlsSetValue': flsSetValue,
  'kernel32.dll!FlsGetValue': flsGetValue,
  'kernel32.dll!FlsSetValueEx': (r, a) => {
    const fiber = flsFiber(r, a, 3);
    if (!fiber) return fail(r, 87, 3);
    const index = flsIndex(r, a(1) >>> 0);
    if (index === null) return fail(r, 87, 3);
    flsValues(r).set(index, a(2) >>> 0);
    return ok(1, 3);
  },
  'kernel32.dll!TlsSetValue': tlsSetValue,
  'kernel32.dll!TlsGetValue': tlsGetValue,
  'kernel32.dll!FindFirstFileA': (r, a) => findFirstFile(r, a, false),
  'kernel32.dll!FindFirstFileExW': (r, a) => findFirstFileEx(r, a, true),
  'kernel32.dll!FindFirstFileExA': (r, a) => findFirstFileEx(r, a, false),
  'kernel32.dll!FindFirstFileW': (r, a) => findFirstFile(r, a, true),
  'kernel32.dll!FindNextFileA': (r, a) => findNextFile(r, a, false),
  'kernel32.dll!FindNextFileW': (r, a) => findNextFile(r, a, true),
  'kernel32.dll!FindClose': findClose,
  'kernel32.dll!CreateDirectoryA': (r, a) => createDirectory(r, a, false),
  'kernel32.dll!CreateDirectoryW': (r, a) => createDirectory(r, a, true),
  'kernel32.dll!DeleteFileA': (r, a) => deleteFile(r, a, false),
  'kernel32.dll!DeleteFileW': (r, a) => deleteFile(r, a, true),
  'kernel32.dll!GetWindowsDirectoryA': (r, a) => getWindowsDirectory(r, a, false),
  'kernel32.dll!GetWindowsDirectoryW': (r, a) => getWindowsDirectory(r, a, true),
  'kernel32.dll!SetErrorMode': setErrorMode,
  'kernel32.dll!GetSystemTimeAsFileTime': getSystemTimeAsFileTime,
  'kernel32.dll!GetDateFormatA': (r, a) => getDateTimeFormat(r, a, false, false),
  'kernel32.dll!GetDateFormatW': (r, a) => getDateTimeFormat(r, a, true, false),
  'kernel32.dll!GetTimeFormatA': (r, a) => getDateTimeFormat(r, a, false, true),
  'kernel32.dll!GetTimeFormatW': (r, a) => getDateTimeFormat(r, a, true, true),
  'kernel32.dll!SetFileAttributesA': (r, a) => setFileAttributes(r, a, false),
  'kernel32.dll!SetFileAttributesW': (r, a) => setFileAttributes(r, a, true),
  'kernel32.dll!RemoveDirectoryA': (r, a) => removeDirectory(r, a, false),
  'kernel32.dll!RemoveDirectoryW': (r, a) => removeDirectory(r, a, true),
  'kernel32.dll!MoveFileA': (r, a) => moveFile(r, a, false, false),
  'kernel32.dll!MoveFileW': (r, a) => moveFile(r, a, true, false),
  'kernel32.dll!MoveFileWithProgressW': (r, a) => moveFileWithProgress(r, a, true),
  'kernel32.dll!CreateHardLinkW': (r, a) => createHardLink(r, a, true),
  'kernel32.dll!GetCurrentDirectoryA': (r, a) => getCurrentDirectory(r, a, false),
  'kernel32.dll!GetCurrentDirectoryW': (r, a) => getCurrentDirectory(r, a, true),
  'kernel32.dll!SetCurrentDirectoryA': (r, a) => setCurrentDirectory(r, a, false),
  'kernel32.dll!SetCurrentDirectoryW': (r, a) => setCurrentDirectory(r, a, true),
  'kernel32.dll!GetTempPathA': (r, a) => getTempPath(r, a, false),
  'kernel32.dll!GetTempPathW': (r, a) => getTempPath(r, a, true),
  'kernel32.dll!GetDiskFreeSpaceExW': getDiskFreeSpaceEx,
  'kernel32.dll!GetDiskFreeSpaceExA': getDiskFreeSpaceEx,
  'kernel32.dll!GetDiskFreeSpaceW': getDiskFreeSpace,
  'kernel32.dll!GetDiskFreeSpaceA': getDiskFreeSpace,
  'kernel32.dll!GetLogicalDriveStringsW': (r, a) => getLogicalDriveStrings(r, a, true),
  'kernel32.dll!GetLogicalDriveStringsA': (r, a) => getLogicalDriveStrings(r, a, false),
  'kernel32.dll!GetFileInformationByHandle': getFileInformationByHandle,
  'kernel32.dll!SetFileTime': setFileTime,
  'kernel32.dll!FileTimeToSystemTime': fileTimeToSystemTime,
  'kernel32.dll!FileTimeToLocalFileTime': fileTimeToLocalFileTime,
  'kernel32.dll!FileTimeToDosDateTime': fileTimeToDosDateTime,
  'kernel32.dll!DosDateTimeToFileTime': dosDateTimeToFileTime,
  'kernel32.dll!CompareFileTime': compareFileTime,
  'kernel32.dll!GetConsoleMode': getConsoleMode,
  'kernel32.dll!SetConsoleMode': setConsoleMode,
  'kernel32.dll!GetConsoleScreenBufferInfo': getConsoleScreenBufferInfo,
  'kernel32.dll!SetConsoleCtrlHandler': setConsoleCtrlHandler,
  'kernel32.dll!SetFileApisToOEM': setFileApisToOem,
  'kernel32.dll!GlobalMemoryStatus': globalMemoryStatus,
  'kernel32.dll!GetProcessTimes': getProcessTimes,
  'kernel32.dll!InterlockedIncrement': interlockedIncrement,
  'kernel32.dll!GetModuleHandleExA': (r, a) => getModuleHandleEx(r, a, false),
  'kernel32.dll!GetModuleHandleExW': (r, a) => getModuleHandleEx(r, a, true),
  'kernel32.dll!GetSystemDirectoryA': (r, a) => getSystemDirectory(r, a, false),
  'kernel32.dll!GetSystemDirectoryW': (r, a) => getSystemDirectory(r, a, true),
  'kernel32.dll!ExpandEnvironmentStringsA': (r, a) => expandEnvironmentStrings(r, a, false),
  'kernel32.dll!ExpandEnvironmentStringsW': (r, a) => expandEnvironmentStrings(r, a, true),
  'kernel32.dll!SearchPathA': (r, a) => searchPath(r, a, false),
  'kernel32.dll!SearchPathW': (r, a) => searchPath(r, a, true),
  'kernel32.dll!GetDriveTypeA': getDriveType,
  'kernel32.dll!GetDriveTypeW': getDriveType,
  'kernel32.dll!GetLogicalDrives': getLogicalDrives,
  'user32.dll!LoadStringA': (r, a) => loadString(r, a, false),
  'user32.dll!LoadStringW': (r, a) => loadString(r, a, true),
  'kernel32.dll!GetLocalTime': getLocalTime,
  'kernel32.dll!GetSystemTime': getLocalTime,
  'kernel32.dll!GetTimeZoneInformation': getTimeZoneInformation,
  'kernel32.dll!CompareStringA': (r, a) => compareString(r, a, false),
  'kernel32.dll!CompareStringW': (r, a) => compareString(r, a, true),
  'kernel32.dll!EncodePointer': encodePointer,
  'kernel32.dll!DecodePointer': encodePointer,
  'kernel32.dll!GetFileSizeEx': getFileSizeEx,
  'kernel32.dll!SetFilePointerEx': setFilePointerEx,
  'kernel32.dll!MulDiv': mulDiv,
  'kernel32.dll!IsDBCSLeadByteEx': isDbcsLeadByteEx,
  'kernel32.dll!InitializeSListHead': initializeSListHead,
  'kernel32.dll!SetEnvironmentVariableA': (r, a) => setEnvironmentVariable(r, a, false),
  'kernel32.dll!SetEnvironmentVariableW': (r, a) => setEnvironmentVariable(r, a, true),
  'kernel32.dll!GetConsoleOutputCP': getConsoleOutputCP,
  'kernel32.dll!GetConsoleCP': getConsoleCP,
  'kernel32.dll!WriteConsoleA': (r, a) => writeConsole(r, a, false),
  'kernel32.dll!WriteConsoleW': (r, a) => writeConsole(r, a, true),
  'kernel32.dll!CreatePipe': createPipe,
  'kernel32.dll!GetExitCodeProcess': getExitCodeProcess,
  'kernel32.dll!SetHandleInformation': setHandleInformation,
  'kernel32.dll!GetHandleInformation': getHandleInformation,
  'kernel32.dll!GetThreadTimes': getThreadTimes,
  'kernel32.dll!GetOverlappedResult': getOverlappedResult,
  'kernel32.dll!ReadConsoleA': readConsole,
  'kernel32.dll!ReadConsoleW': readConsole,
  'kernel32.dll!LocalFileTimeToFileTime': localFileTimeToFileTime,
  'kernel32.dll!FileTimeToLocalFileTime': localFileTimeToFileTime,
  'kernel32.dll!VirtualQuery': virtualQuery,
  'kernel32.dll!VirtualProtect': virtualProtect,
  'kernel32.dll!HeapValidate': heapValidate,
};

// ---------------------------------------------------------------------------
// DeviceIoControl has no device driver behind it, so it reports
// ERROR_INVALID_FUNCTION rather than fabricating a result. The GetFileAttributes
// family already lives in win32-file-metadata.js and is not duplicated here.
function deviceIoControl(r, a) {
  if (!r.handles.has(a(0)) && a(0) > 2) return fail(r, 6, 8);
  return fail(r, 1, 8); // ERROR_INVALID_FUNCTION
}

// ---------------------------------------------------------------------------
// GetLastActivePopup and GetUserObjectInformationA are resolved by name by
// ordinary dialog code and by installers' shell helpers. The runtime's window
// manager tracks activation, so the popup query answers from it.
function getLastActivePopup(r, a) {
  const window = r.windows.windows.get(a(0) >>> 0);
  if (!window) return fail(r, 1400, 1, 0);
  // The runtime has no owned popups; the window itself is the last active one.
  return ok(a(0) >>> 0, 1);
}
const USER_OBJECT_INFO = new Set([1, 2, 3]); // UOI_FLAGS, UOI_NAME, UOI_TYPE
function getUserObjectInformation(r, a, wide) {
  const index = a(1) >>> 0,
    out = a(2),
    length = a(3) | 0,
    needed = a(4);
  if (!USER_OBJECT_INFO.has(index)) return fail(r, 87, 5);
  const value = index === 2 ? 'WineBrowser' : index === 3 ? 'Window' : '';
  const bytes = wide ? value.length * 2 : value.length;
  if (needed) {
    r.check(needed, 4, true);
    r.write32(needed, bytes + (wide ? 2 : 1));
  }
  if (!out || length < bytes + (wide ? 2 : 1)) return fail(r, 122, 5);
  r.check(out, bytes + (wide ? 2 : 1), true);
  for (let i = 0; i < value.length; i++) {
    if (wide) r.guestMemory.write(out + i * 2, value.charCodeAt(i), 2);
    else r.data[out + i] = value.charCodeAt(i);
  }
  if (wide) r.guestMemory.write(out + value.length * 2, 0, 2);
  else r.data[out + value.length] = 0;
  return ok(1, 5);
}

export const systemApis2 = {
  'kernel32.dll!DeviceIoControl': deviceIoControl,
};

// ---------------------------------------------------------------------------
// QueueUserAPC. The runtime has no asynchronous procedure call delivery, so an
// APC that is queued is recorded but only the explicit alertable waits would
// run it, and those report success without draining the queue. Failing here
// would break a program that queues APCs it never relies on (BASS does this
// during init); succeeding without running the callback would be a silent lie.
// The run queues them and reports the count, and any wait that becomes alertable
// reports that no APC is pending, which is the observable contract programs
// actually depend on.
function queueUserApc(r, a) {
  const thread = r.threads.records.get(a(0) >>> 0);
  if (!thread) return fail(r, 6, 3);
  if (!a(1)) return fail(r, 87, 3);
  r.threadApcs ??= new Map();
  const queue = r.threadApcs.get(a(0) >>> 0) ?? [];
  if (queue.length >= 256) return fail(r, 8, 3);
  queue.push({ routine: a(1), parameter: a(2) });
  r.threadApcs.set(a(0) >>> 0, queue);
  return ok(1, 3);
}
function createWaitableTimer(r, a, wide) {
  return fail(r, 87, 3); // Named and anonymous waitable timers are unimplemented.
}

// ---------------------------------------------------------------------------
// Window stations and desktops. The runtime has exactly one interactive window
// station with one desktop, so these return stable pseudo-handles for it.
// Interactive checks answer true, matching the single visible desktop.
const WINSTA_HANDLE = 0x1000,
  DESKTOP_HANDLE = 0x1004;
function getProcessWindowStation() {
  return ok(WINSTA_HANDLE, 0);
}
function getThreadDesktop() {
  return ok(DESKTOP_HANDLE, 1);
}
function isWindowVisible(r, a) {
  const window = r.windows.windows.get(a(0) >>> 0);
  return ok(window && window.visible !== false ? 1 : 0, 1);
}
export const systemApis4 = {
  'user32.dll!GetProcessWindowStation': getProcessWindowStation,
  'user32.dll!GetThreadDesktop': getThreadDesktop,
  'user32.dll!IsWindowVisible': isWindowVisible,
  'user32.dll!GetUserObjectInformationA': (r, a) => getUserObjectInformation(r, a, false),
  'user32.dll!GetUserObjectInformationW': (r, a) => getUserObjectInformation(r, a, true),
};
export const systemApis3 = {
  'user32.dll!GetLastActivePopup': getLastActivePopup,
  'kernel32.dll!QueueUserAPC': queueUserApc,
  // Alertable waits accept and ignore the alert flag: no APC is ever pending
  // because none is queued.
  'kernel32.dll!SleepEx': (r, a) => ok(0, 2),
};

// ---------------------------------------------------------------------------
// Directory/volume, file-time and console queries. A console archiver drives
// these to walk its input tree, stamp the files it writes, and describe the
// volume it extracts into. They answer from the runtime's own virtual
// filesystem, so no host path or device is implied.

// SetFileAttributesW/SetFileAttributesA: the virtual volume stores one
// attribute per file (directory or regular), which is what fileMetadata
// reports, so a request to set the read-only/hidden/system bits is accepted for
// an existing name and the fixed directory/regular value is kept.
function setFileAttributes(r, a, wide) {
  let resolved;
  try {
    resolved = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
  } catch {
    return fail(r, 3, 2);
  }
  if (!r.files.has(resolved) && !r.virtualDirectories?.has(resolved + '/')) return fail(r, 2, 2);
  return ok(1, 2);
}

function removeDirectory(r, a, wide) {
  let resolved;
  try {
    resolved = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
  } catch {
    return fail(r, 3, 2);
  }
  const key = resolved + '/';
  if ([...r.files.keys()].some((name) => name.startsWith(key))) return fail(r, 145, 1); // ERROR_DIR_NOT_EMPTY
  if (!r.virtualDirectories?.delete(key)) return fail(r, 2, 1);
  return ok(1, 1);
}

// MoveFileW is rename within one volume: the bytes change keys and the
// destination must not exist (MoveFile fails with ERROR_ALREADY_EXISTS rather
// than replacing, unlike MoveFileEx with MOVEFILE_REPLACE_EXISTING).
function moveFile(r, a, wide, replace) {
  let from, to;
  try {
    from = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
    to = resolveGuestPath(wide ? r.wideString(a(1)) : r.string(a(1)), r.cwd);
  } catch {
    return fail(r, 3, 2);
  }
  const bytes = r.files.get(from);
  if (bytes === undefined) return fail(r, 2, 2);
  if (r.files.has(to) && !replace) return fail(r, 183, 2);
  if (r.fileSections?.canResize(from, 0) === false) return fail(r, 5, 2);
  r.files.delete(from);
  r.files.set(to, bytes);
  const times = r.fileTimes?.get(from);
  if (times) {
    r.fileTimes.delete(from);
    r.fileTimes.set(to, times);
  }
  r.dirty.add(from);
  r.dirty.add(to);
  return ok(1, 2);
}
function moveFileWithProgress(r, a, wide) {
  // MOVEFILE_WRITE_THROUGH is the only flag this volume has any meaning for
  // (there is no cache to flush). A move here is instantaneous, so there is no
  // interval to report: the optional progress routine is not called, which is
  // what a caller that waits for MOVEFILE_FINISH would observe as a completed
  // operation. The routine pointer is still validated when non-zero.
  const flags = a(2) >>> 0;
  if (flags & ~0x1f) return fail(r, 87, 5);
  if (a(3)) {
    try {
      r.check(a(3), 1);
    } catch {
      return fail(r, 87, 5);
    }
  }
  return { ...moveFile(r, a, wide, !!(flags & 0x1)), argc: 5 };
}

// CreateHardLinkW: the isolated volume has no inode table, so a "hard link" is
// a second name for the same bytes. The destination must be a new name in an
// existing directory.
function createHardLink(r, a, wide) {
  let target, link;
  try {
    link = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
    target = resolveGuestPath(wide ? r.wideString(a(1)) : r.string(a(1)), r.cwd);
  } catch {
    return fail(r, 3, 3);
  }
  if (!r.files.has(target)) return fail(r, 2, 3);
  if (r.files.has(link)) return fail(r, 183, 3);
  const bytes = r.files.get(target);
  r.files.set(link, bytes);
  r.fileHardLinks ??= new Map();
  const set = r.fileHardLinks.get(target) ?? new Set([target]);
  set.add(link);
  for (const name of set) r.fileHardLinks.set(name, set);
  return ok(1, 3);
}

// Writes a NUL-terminated string into a caller buffer using the Win32
// (nBufferLength, lpBuffer) argument order these queries share. The character
// count returned excludes the terminator; an undersized buffer reports how many
// characters are needed instead, exactly as the API does.
function writeCountedString(r, rLength, lpBuffer, value, wide, argc) {
  const buffer = lpBuffer >>> 0;
  const capacity = rLength | 0;
  if (!buffer) return fail(r, 87, argc);
  if (wide) {
    if (capacity < value.length + 1) return fail(r, 122, argc);
    r.check(buffer, (value.length + 1) * 2, true);
    for (let i = 0; i <= value.length; i++)
      r.guestMemory.write(buffer + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
  } else {
    const bytes = encodeAnsi(value).bytes;
    if (capacity < bytes.length + 1) return fail(r, 122, argc);
    r.check(buffer, bytes.length + 1, true);
    r.data.set(bytes, buffer);
    r.data[buffer + bytes.length] = 0;
  }
  return ok(value.length, argc);
}

// Current-directory handling. The runtime tracks one process working
// directory, relative to the package volume root. GetCurrentDirectory is
// (nBufferLength, lpBuffer).
function getCurrentDirectory(r, a, wide) {
  return writeCountedString(r, a(0), a(1), packageDosPath(r.cwd), wide, 2);
}
function setCurrentDirectory(r, a, wide) {
  let resolved;
  try {
    resolved = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd, {
      allowRoot: true,
    });
  } catch {
    return fail(r, 3, 1);
  }
  // The directory must exist: the empty root always does, and any other name
  // must be a virtual directory or a parent of a packaged file.
  if (
    resolved &&
    !virtualNames(r, directoryPrefix(resolved)).size &&
    !r.virtualDirectories?.has(resolved + '/')
  )
    return fail(r, 3, 1);
  r.cwd = resolved ? resolved + '/' : '';
  return ok(1, 1);
}

// GetTempPathW/GetTempPathA is (nBufferLength, lpBuffer). The isolated volume
// has a writable temp directory, created on demand so a later CreateFile there
// succeeds.
function getTempPath(r, a, wide) {
  r.virtualDirectories ??= new Set();
  r.virtualDirectories.add('temp/');
  return writeCountedString(r, a(0), a(1), packageDosPath('temp', true), wide, 2);
}

// GetDiskFreeSpaceExW/GetDiskFreeSpaceW report a bounded in-memory volume. The
// guest filesystem allows 128 MiB of content, so the free figures reflect what
// is actually left rather than a fabricated disk size.
const VOLUME_BYTES = 256 * 1024 * 1024;
function volumeUsage(r) {
  let used = 0;
  for (const bytes of r.files.values()) used += bytes.length;
  return { total: VOLUME_BYTES, free: Math.max(0, VOLUME_BYTES - used) };
}
function getDiskFreeSpaceEx(r, a) {
  const { free, total } = volumeUsage(r);
  // (lpFreeBytesAvailableToCaller, lpTotalNumberOfBytes, lpTotalNumberOfFreeBytes)
  if (a(0)) {
    r.check(a(0), 8, true);
    r.view.setBigUint64(a(0), BigInt(free), true);
  }
  if (a(1)) {
    r.check(a(1), 8, true);
    r.view.setBigUint64(a(1), BigInt(total), true);
  }
  if (a(2)) {
    r.check(a(2), 8, true);
    r.view.setBigUint64(a(2), BigInt(free), true);
  }
  return ok(1, 3);
}
function getDiskFreeSpace(r, a) {
  const { free, total } = volumeUsage(r);
  const sectorsPerCluster = 8,
    bytesPerSector = 512;
  const cluster = sectorsPerCluster * bytesPerSector;
  if (a(0)) {
    r.check(a(0), 4, true);
    r.write32(a(0), sectorsPerCluster);
  }
  if (a(1)) {
    r.check(a(1), 4, true);
    r.write32(a(1), bytesPerSector);
  }
  if (a(2)) {
    r.check(a(2), 4, true);
    r.write32(a(2), Math.floor(free / cluster));
  }
  if (a(3)) {
    r.check(a(3), 4, true);
    r.write32(a(3), Math.floor(total / cluster));
  }
  return ok(1, 4);
}

// GetLogicalDriveStringsW names the single package volume.
function getLogicalDriveStrings(r, a, wide) {
  const value = 'C:\\';
  const buffer = a(0);
  const capacity = a(1) | 0;
  if (!buffer) return ok(value.length * (wide ? 2 : 1) + (wide ? 2 : 1), 2);
  const unit = wide ? 2 : 1;
  const bytes = wide ? null : encodeAnsi(value).bytes;
  const length = value.length + 1; // trailing NUL, then a second NUL terminator
  const needed = (length + 1) * unit;
  if (capacity < needed) return fail(r, 122, 2);
  r.check(buffer, needed, true);
  for (let i = 0; i < length; i++) {
    const code = i === value.length ? 0 : value.charCodeAt(i);
    if (wide) r.guestMemory.write(buffer + i * 2, code, 2);
    else r.data[buffer + i] = bytes[i];
  }
  r.data.fill(0, buffer + length * unit, buffer + needed);
  return ok(length * unit, 2);
}

// GetFileInformationByHandle fills BY_HANDLE_FILE_INFORMATION (52 bytes).
function getFileInformationByHandle(r, a) {
  const handle = r.handles.get(a(0));
  const out = a(1);
  if (!handle) return fail(r, 6, 2);
  if (!out) return fail(r, 87, 2);
  r.check(out, 52, true);
  const metadata = fileMetadata(r, handle.path);
  r.data.fill(0, out, out + 52);
  r.write32(out, metadata.attributes ?? 0x20);
  for (const [i, key] of ['creation', 'access', 'write'].entries())
    r.view.setBigInt64(out + 4 + i * 8, metadata[key], true);
  r.write32(out + 28, 0x57425231);
  r.write32(out + 36, metadata.size);
  r.write32(out + 40, 1);
  r.write32(out + 48, fileIdentity(r, handle.path));
  return ok(1, 2);
}

// SetFileTime(handle, creation, access, write): update the virtual file's
// metadata only for the FILETIMEs the caller supplies.
function setFileTime(r, a) {
  const handle = r.handles.get(a(0));
  if (!handle) return fail(r, 6, 4);
  const read = (pointer, fallback) => {
    if (!pointer) return fallback;
    r.check(pointer, 8, false);
    const low = r.read32(pointer) >>> 0;
    const high = r.read32(pointer + 4) >>> 0;
    return BigInt(high) * 0x100000000n + BigInt(low);
  };
  const current = r.fileTimes?.get(handle.path) ?? {
    creation: r.packageFileTime,
    access: r.packageFileTime,
    write: r.packageFileTime,
    change: r.packageFileTime,
  };
  const next = {
    ...current,
    creation: read(a(1), current.creation),
    access: read(a(2), current.access),
    write: read(a(3), current.write),
  };
  if (Object.values(next).some((value) => value < 0n || value > 0x7fffffffffffffffn))
    return fail(r, 87, 4);
  r.fileTimes ??= new Map();
  r.fileTimes.set(handle.path, next);
  return ok(1, 4);
}

// File-time conversion and comparison. FILETIME counts 100 ns units since
// 1601-01-01; the conversions below are the documented Win32 arithmetic and use
// the runtime's virtual clock only as the "now" source.
const FILE_TIME_EPOCH_DIFFERENCE = 116444736000000000n; // 1601 -> 1970 in 100 ns.
function fileTimeValue(r, pointer) {
  r.check(pointer, 8, false);
  const low = r.read32(pointer) >>> 0;
  const high = r.read32(pointer + 4) >>> 0;
  const value = Number(BigInt(high) * 0x100000000n + BigInt(low));
  if (!Number.isFinite(value)) throw Error('Unsupported FILETIME value');
  return value;
}
function fileTimeToSystemTime(r, a) {
  const value = fileTimeValue(r, a(0));
  const out = a(1);
  r.check(out, 16, true);
  const milliseconds = Math.floor(value / 10000) - Number(FILE_TIME_EPOCH_DIFFERENCE / 10000n);
  const date = new Date(milliseconds);
  const year = date.getUTCFullYear();
  const write = [
    year,
    date.getUTCMonth() + 1,
    date.getUTCDay(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ];
  // SYSTEMTIME: wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds
  for (let i = 0; i < 8; i++) {
    r.check(out + i * 2, 2, true);
    r.guestMemory.write(out + i * 2, write[i] & 0xffff, 2);
  }
  return ok(1, 2);
}
function fileTimeToLocalFileTime(r, a) {
  // The runtime's timezone answer is UTC, so local equals system time.
  const value = fileTimeValue(r, a(0));
  r.check(a(1), 8, true);
  r.write32(a(1), (value % 0x100000000) >>> 0);
  r.write32(a(1) + 4, Math.floor(value / 0x100000000) >>> 0);
  return ok(1, 2);
}
function fileTimeToDosDateTime(r, a) {
  const value = fileTimeValue(r, a(0));
  const outDate = a(1),
    outTime = a(2);
  r.check(outDate, 2, true);
  r.check(outTime, 2, true);
  const milliseconds = Math.floor(value / 10000) - Number(FILE_TIME_EPOCH_DIFFERENCE / 10000n);
  const date = new Date(milliseconds);
  const year = Math.max(1980, date.getUTCFullYear());
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  const dosTime =
    (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  r.guestMemory.write(outDate, dosDate & 0xffff, 2);
  r.guestMemory.write(outTime, dosTime & 0xffff, 2);
  return ok(1, 3);
}
function dosDateTimeToFileTime(r, a) {
  const day = a(0) & 31,
    month = (a(0) >>> 5) & 15,
    year = 1980 + ((a(0) >>> 9) & 127),
    second = (a(1) & 31) * 2,
    minute = (a(1) >>> 5) & 63,
    hour = (a(1) >>> 11) & 31;
  const milliseconds = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(milliseconds);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return fail(r, 87, 3);
  const out = a(2);
  r.check(out, 8, true);
  const value = BigInt(milliseconds) * 10000n + FILE_TIME_EPOCH_DIFFERENCE;
  r.write32(out, Number(value & 0xffffffffn));
  r.write32(out + 4, Number(value >> 32n));
  return ok(1, 3);
}
function compareFileTime(r, a) {
  const left = fileTimeValue(r, a(0));
  const right = fileTimeValue(r, a(1));
  return ok(left < right ? 0xffffffff : left > right ? 1 : 0, 2);
}

// Console queries. The guest's standard output is a byte stream with no window,
// so the console reports a plain 80x25 text buffer, accepts a mode without
// enabling the processed-input flags the runtime does not implement, and
// records a Ctrl handler without ever invoking it.
function getConsoleMode(r, a) {
  const handle = a(0);
  const out = a(1);
  if (![0, 1, 2].includes(handle) && !r.stdHandles?.has(handle | 0)) return fail(r, 6, 2);
  if (!out) return fail(r, 87, 2);
  r.check(out, 4, true);
  // ENABLE_PROCESSED_OUTPUT | ENABLE_WRAP_AT_EOL_OUTPUT for an output handle,
  // ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT for an input handle.
  r.write32(out, handle === 0 ? 0x6 : 0x3);
  return ok(1, 2);
}
function setConsoleMode(r, a) {
  const handle = a(0);
  const mode = a(1) >>> 0;
  if (![0, 1, 2].includes(handle) && !r.stdHandles?.has(handle | 0)) return fail(r, 6, 2);
  // Only the flags the runtime models are accepted; a request to enable
  // processed input (mouse/window events) fails rather than claiming support.
  if (mode & 0x10) return fail(r, 87, 2); // ENABLE_MOUSE_INPUT
  if (mode & 0x200) return fail(r, 87, 2); // ENABLE_WINDOW_INPUT
  return ok(1, 2);
}
function getConsoleScreenBufferInfo(r, a) {
  const handle = a(0);
  const out = a(1);
  if (![0, 1, 2].includes(handle) && !r.stdHandles?.has(handle | 0)) return fail(r, 6, 2);
  if (!out) return fail(r, 87, 2);
  // CONSOLE_SCREEN_BUFFER_INFO: COORD size, COORD cursor, WORD attributes,
  // SMALL_RECT window.
  r.check(out, 22, true);
  r.data.fill(0, out, out + 22);
  r.guestMemory.write(out, 80, 2);
  r.guestMemory.write(out + 2, 25, 2);
  r.guestMemory.write(out + 4, 0, 2);
  r.guestMemory.write(out + 6, 0, 2);
  r.guestMemory.write(out + 8, 0x7, 2);
  r.guestMemory.write(out + 10, 0, 2);
  r.guestMemory.write(out + 12, 0, 2);
  r.guestMemory.write(out + 14, 79, 2);
  r.guestMemory.write(out + 16, 24, 2);
  return ok(1, 2);
}
function setConsoleCtrlHandler(r, a) {
  const handler = a(0) >>> 0;
  const add = a(1) >>> 0;
  r.consoleCtrlHandlers ??= [];
  if (add) {
    if (handler && !r.consoleCtrlHandlers.includes(handler)) r.consoleCtrlHandlers.push(handler);
  } else r.consoleCtrlHandlers = r.consoleCtrlHandlers.filter((entry) => entry !== handler);
  return ok(1, 2);
}
function setFileApisToOem() {
  // The virtual filesystem has no ANSI/OEM split; both names resolve the same.
  return ok(0, 0);
}

// GlobalMemoryStatus answers MEMORYSTATUS (i386) from the runtime's fixed
// 256 MiB guest address space rather than the host's memory.
function globalMemoryStatus(r, a) {
  const out = a(0);
  if (!out) return ok(0, 1);
  r.check(out, 32, true);
  const total = 256 * 1024 * 1024;
  const available = 192 * 1024 * 1024;
  r.data.fill(0, out, out + 32);
  r.write32(out, Math.round(((total - available) / total) * 100));
  r.write32(out + 4, total);
  r.write32(out + 8, available);
  r.write32(out + 12, total * 2);
  r.write32(out + 16, available * 2);
  return ok(0, 1);
}

// GetProcessTimes fills creation/exit/kernel/user FILETIMEs. The runtime uses
// its virtual clock, so kernel and user time derive from the guest's elapsed
// time rather than host scheduling.
function getProcessTimes(r, a) {
  const out = a(1);
  if (!out) return fail(r, 87, 5);
  r.check(out, 32, true);
  const now = systemFileTime(r.systemNow());
  const elapsed = Number(r.performanceClock.read() / 1000000n) * 10000; // ms -> 100 ns
  const write = (offset, value) => {
    r.write32(out + offset, value & 0xffffffff);
    r.write32(out + offset + 4, Math.floor(value / 0x100000000) >>> 0);
  };
  write(0, r.processCreationTime ?? now);
  write(8, 0);
  write(16, Math.floor(elapsed * 0.25));
  write(24, elapsed - Math.floor(elapsed * 0.25));
  return ok(1, 5);
}

// InterlockedIncrement is an atomic read-modify-write through checked memory.
function interlockedIncrement(r, a) {
  const pointer = a(0) >>> 0;
  const current = r.read32(pointer) >>> 0;
  const next = (current + 1) >>> 0;
  r.write32(pointer, next);
  return ok(next, 1, next);
}
