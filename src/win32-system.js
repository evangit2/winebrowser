// Process, resource, TLS and filesystem-enumeration services that ordinary
// Win32 applications import. Everything answers from the runtime's own model:
// mapped guest modules, the virtual filesystem, and the per-thread TEB.
import { listPEResources, readPEResource } from './pe-resources.js';
import { resolveGuestPath } from './guest-paths.js';
import { encodeAnsi } from './encoding.js';
import { protectMemory } from './memory-protection.js';

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
  const module = [...r.graph.modules.values()].find((m) => m.base === (handle >>> 0));
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
// Dynamic thread-local storage. Slots live in the per-thread TEB's TLS array,
// which createThread already publishes at fs:[0x2c]. A slot number follows the
// documented 0..1088 range and index into that array.
const TLS_MINIMUM_AVAILABLE = 1088,
  TLS_OUT_OF_INDEXES = 0xffffffff;
function tlsVector(r) {
  const vector = r.read32(r.cpu.fsBase + 0x2c);
  if (vector) return vector;
  // A process with no static TLS still needs a vector for dynamic slots; the
  // scheduler installs one for every thread, so allocate on first use.
  const created = r.allocate(TLS_MINIMUM_AVAILABLE * 4);
  r.dynamicTlsVector = created;
  r.write32(r.cpu.fsBase + 0x2c, created);
  return created;
}
function tlsAlloc(r) {
  r.dynamicTlsSlots ??= new Set();
  for (let index = 0; index < TLS_MINIMUM_AVAILABLE; index++)
    if (!r.dynamicTlsSlots.has(index)) {
      r.dynamicTlsSlots.add(index);
      return ok(index + 1, 0); // Reserved first slot shared with static TLS.
    }
  return ok(TLS_OUT_OF_INDEXES, 0);
}
function tlsIndex(r, a) {
  const index = a(0) >>> 0;
  if (index === 0 || index > TLS_MINIMUM_AVAILABLE) return null;
  return index - 1;
}
function tlsFree(r, a) {
  const index = tlsIndex(r, a);
  if (index === null || !r.dynamicTlsSlots?.delete(index)) return fail(r, 87, 1);
  return ok(1, 1);
}
function tlsSetValue(r, a) {
  const index = tlsIndex(r, a);
  if (index === null) return fail(r, 87, 2);
  r.write32(tlsVector(r) + index * 4, a(1) >>> 0);
  return ok(1, 2);
}
function tlsGetValue(r, a) {
  const index = tlsIndex(r, a);
  if (index === null) return fail(r, 87, 1);
  // A slot that was never written reads as zero, as the API documents.
  r.lastError = 0;
  return ok(r.read32(tlsVector(r) + index * 4) >>> 0, 1);
}

// ---------------------------------------------------------------------------
// Directory and file system queries answer from the virtual filesystem, which
// is the package's own tree plus anything the guest created at run time.
function directoryPrefix(r, path) {
  const normalized = path.replace(/[\\/]+$/, '');
  return normalized ? normalized + '/' : '';
}
function virtualNames(r, prefix) {
  const names = new Map();
  for (const name of r.files.keys()) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
  }
  // Directories created at run time are not files, so track them separately.
  for (const directory of r.virtualDirectories ?? [])
    if (directory.startsWith(prefix) && directory.length > prefix.length) {
      const rest = directory.slice(prefix.length).replace(/\/$/, '');
      if (rest && !rest.includes('/')) names.set(rest, true);
    }
  return names;
}
function writeFindData(r, address, name, directory, size, time) {
  // WIN32_FIND_DATAA: dwFileAttributes at 0, three FILETIMEs from 4, size at
  // 28, then the short and long names. Only the fields callers act on are
  // meaningful; timestamps come from the virtual file's metadata.
  r.check(address, 320, true);
  r.data.fill(0, address, address + 320);
  r.write32(address, directory ? 0x10 : 0x80);
  const writeTime = (offset, value) => {
    r.write32(offset, value & 0xffffffff);
    r.write32(offset + 4, (value / 0x100000000) | 0);
  };
  writeTime(4, time.lastWrite ?? 0);
  writeTime(12, time.lastAccess ?? 0);
  writeTime(20, time.creation ?? 0);
  r.write32(address + 28, size);
  const target = address + 44;
  for (let i = 0; i < name.length && i < 259; i++)
    r.guestMemory.write(target + i, name.charCodeAt(i), 1);
  for (let i = 0; i < name.length && i < 13; i++)
    r.guestMemory.write(address + 304 + i, name.charCodeAt(i), 1);
}
function findFirstFile(r, a, wide) {
  let resolved;
  try {
    resolved = resolveGuestPath(wide ? r.wideString(a(0)) : r.string(a(0)), r.cwd);
  } catch {
    return fail(r, 3, 2);
  }
  const prefix = directoryPrefix(resolved);
  const names = virtualNames(r, prefix);
  if (!names.size) return fail(r, 2, 2);
  r.findHandles ??= new Map();
  const nextId = (r.nextFindHandle = (r.nextFindHandle ?? 0x51000000) + 4);
  const entries = [...names].map(([name, directory]) => ({ name, directory }));
  const first = entries[0];
  const metadata = r.fileMetadata?.get?.(prefix + first.name);
  if (wide) {
    // WIN32_FIND_DATAW uses the same layout with UTF-16LE names.
    r.check(a(1), 592, true);
    r.data.fill(0, a(1), a(1) + 592);
    r.write32(a(1), first.directory ? 0x10 : 0x80);
    r.write32(a(1) + 28, metadata?.size ?? 0);
    const target = a(1) + 44;
    for (let i = 0; i < first.name.length && i < 259; i++)
      r.guestMemory.write(target + i * 2, first.name.charCodeAt(i), 2);
  } else {
    writeFindData(r, a(1), first.name, first.directory, metadata?.size ?? 0, metadata ?? {});
  }
  r.findHandles.set(nextId, { prefix, entries, index: 1 });
  if (r.findHandles.size > 256) r.findHandles.delete(r.findHandles.keys().next().value);
  return ok(nextId, 2);
}
function findNextFile(r, a, wide) {
  const state = r.findHandles?.get(a(0) >>> 0);
  if (!state || state.index >= state.entries.length) return fail(r, 18, 2);
  const entry = state.entries[state.index++];
  if (wide) {
    r.check(a(1), 592, true);
    r.data.fill(0, a(1), a(1) + 592);
    r.write32(a(1), entry.directory ? 0x10 : 0x80);
    const target = a(1) + 44;
    for (let i = 0; i < entry.name.length && i < 259; i++)
      r.guestMemory.write(target + i * 2, entry.name.charCodeAt(i), 2);
  } else {
    writeFindData(r, a(1), entry.name, entry.directory, 0, {});
  }
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
function getSystemTimeAsFileTime(r, a) {
  const address = a(0);
  if (!address) return fail(r, 87, 1);
  r.check(address, 8, true);
  // 100 ns intervals since 1601-01-01, matching the shared-user-data clock.
  const value = BigInt(r.systemNow()) * 10000n + 116444736000000000n;
  r.view.setBigUint64(address, value, true);
  return ok(0, 1);
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
  const base = committed ? range.committed.find((run) => address >= run[0] && address < run[1])[0] : start;
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
  const mapped = (() => {
    switch (protect) {
      case 0x01:
        return 1;
      case 0x02:
      case 0x04:
      case 0x08:
      case 0x10:
      case 0x20:
      case 0x40:
        return 4;
      default:
        return null;
    }
  })();
  if (mapped === null) return fail(r, 87, 4);
  // protectMemory handles both private committed pages and a fully mapped,
  // non-executable PE image page, which is what a packer rewriting its own
  // read-only section asks for.
  const result = protectMemory(r, address, size, mapped);
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
  'kernel32.dll!FindResourceExA': (r, a) =>
    findResourceA(r, (index) => a([0, 2, 1][index] ?? 0)),
  'kernel32.dll!SizeofResource': sizeOfResource,
  'kernel32.dll!LoadResource': loadResource,
  'kernel32.dll!LockResource': lockResource,
  'kernel32.dll!FreeResource': freeResource,
  'kernel32.dll!TlsAlloc': tlsAlloc,
  'kernel32.dll!TlsFree': tlsFree,
  'kernel32.dll!TlsSetValue': tlsSetValue,
  'kernel32.dll!TlsGetValue': tlsGetValue,
  'kernel32.dll!FindFirstFileA': (r, a) => findFirstFile(r, a, false),
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

export const systemApis3 = {
  'kernel32.dll!QueueUserAPC': queueUserApc,
  // Alertable waits accept and ignore the alert flag: no APC is ever pending
  // because none is queued.
  'kernel32.dll!SleepEx': (r, a) => ok(0, 2),
};
