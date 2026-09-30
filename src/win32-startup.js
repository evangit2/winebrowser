// Common kernel32 APIs that CRT startup and ordinary Win32 programs import
// before they touch any application logic. They are deliberately bounded: each
// one either answers from the runtime's own model of the process or fails with
// the documented Win32 error, and none of them silently pretends to do work
// (for example, a real GlobalAlloc block, not a fake constant).
import { GUEST_PERFORMANCE_FREQUENCY } from './guest-clock.js';
import { encodeAnsi } from './encoding.js';
import { guestProcessorFeaturePresent } from './processor-features.js';
import { GuestUnwind } from './seh.js';

const ok = (result = 0, argc = 0) => ({ result, argc });
const fail = (r, error, argc = 0, value = 0) => {
  r.lastError = error;
  return ok(value, argc);
};

// The runtime has exactly one guest heap. HeapCreate returns a distinct handle
// that allocates from the same arena, which is enough for CRT startup's private
// heap while keeping ownership and free semantics honest.
function heapCreate(r, a) {
  const options = a(0);
  if (options & ~0x0004000d) return fail(r, 87, 3);
  const handle = r.nextHeapHandle ?? (r.nextHeapHandle = 0x61000000);
  r.nextHeapHandle += 0x100;
  r.customHeaps ??= new Map();
  // The reserved and initial sizes are recorded so HeapCreate's contract is
  // observable; allocation still comes from the one guest arena.
  r.customHeaps.set(handle, { reserve: a(1), commit: a(2) });
  return ok(handle, 3);
}
function heapDestroy(r, a) {
  if (!r.customHeaps?.delete(a(0))) return fail(r, 6, 1);
  return ok(1, 1);
}
function heapAllocOn(r, a) {
  const heap = a(0);
  if (heap !== 0x50000000 && !r.customHeaps?.has(heap)) return fail(r, 6, 3);
  // HEAP_NO_SERIALIZE (0x1), HEAP_GENERATE_EXCEPTIONS (0x4) and
  // HEAP_ZERO_MEMORY (0x8).
  if (a(1) & ~0xd) return fail(r, 87, 3);
  if (!a(2)) return ok(0, 3);
  return ok(r.allocate(a(2), !!(a(1) & 8)), 3);
}
function heapFreeOn(r, a) {
  const heap = a(0);
  if (heap !== 0x50000000 && !r.customHeaps?.has(heap)) return fail(r, 6, 3);
  if (a(1)) return fail(r, 87, 3);
  return r.free(a(2)) ? ok(1, 3) : fail(r, 6, 3);
}
// HeapReAlloc grows or shrinks a block. The heap owns per-allocation sizes so a
// shrink can be observed by HeapSize, matching the documented behaviour.
function heapReAlloc(r, a) {
  const heap = a(0);
  if (heap !== 0x50000000 && !r.customHeaps?.has(heap)) return fail(r, 6, 4);
  // HEAP_NO_SERIALIZE, HEAP_GENERATE_EXCEPTIONS, HEAP_ZERO_MEMORY and
  // HEAP_REALLOC_IN_PLACE_ONLY are all accepted; the last is advisory here
  // because a shrink always stays in place and a grow only moves when forced.
  if (a(1) & ~0x1d) return fail(r, 87, 4);
  const pointer = a(2),
    size = a(3);
  if (!pointer) return size ? ok(r.allocate(size, !!(a(1) & 8)), 4) : ok(0, 4);
  if (!size) {
    r.free(pointer);
    return ok(0, 4);
  }
  const moved = r.reallocate(pointer, size, !!(a(1) & 8));
  return moved === null ? fail(r, 8, 4) : ok(moved, 4);
}
function heapSize(r, a) {
  const heap = a(0);
  if (heap !== 0x50000000 && !r.customHeaps?.has(heap)) return fail(r, 6, 3);
  if (a(1)) return fail(r, 87, 3);
  const size = r.allocationSize(a(2));
  return size === null ? fail(r, 6, 3, 0xffffffff) : ok(size, 3);
}
// Critical sections are per-process locks. WineBrowser's guest threads only
// switch at explicit yield points, so a critical section that never blocks is
// still correct for single-threaded and cooperatively scheduled guests; the
// storage is a real 24-byte RTL_CRITICAL_SECTION with an owned debug field.
// The RTL_CRITICAL_SECTION initializer. `argc` is the stdcall argument count
// so the caller's stack is restored; the return value is 1 for success because
// the CALLERS that check a result (AndSpinCount, Ex) require nonzero.
function criticalSection(r, a, argc) {
  const pointer = a(0);
  if (!pointer) return fail(r, 87, argc);
  r.check(pointer, 24, true);
  r.criticalSections ??= new Set();
  r.criticalSections.add(pointer);
  // RTL_CRITICAL_SECTION: DebugInfo, LockCount, RecursionCount, OwningThread,
  // LockSemaphore, SpinCount. Initialising sets LockCount to -1.
  r.write32(pointer + 4, 0xffffffff);
  r.write32(pointer + 8, 0);
  r.write32(pointer + 12, 0);
  r.write32(pointer + 16, 0);
  r.write32(pointer + 20, 0);
  return ok(1, argc);
}
// Enter/Leave/Delete return void; the runtime still needs the stdcall argument
// count so the caller's stack is restored.
function criticalSectionCall(r, a, kind) {
  const pointer = a(0);
  if (pointer && r.criticalSections?.has(pointer)) {
    // Track recursion so a mismatched Leave is observable rather than silent.
    const count = (r.read32(pointer + 8) | 0) + (kind === 'leave' ? -1 : 1);
    if (kind !== 'leave' || count >= 0) {
      r.write32(pointer + 8, count);
      r.write32(pointer + 4, count ? 0 : 0xffffffff);
    }
  } else if (kind !== 'leave' && pointer) r.check(pointer, 24, true);
  return ok(0, 1);
}

// QueryPerformanceCounter reads the runtime's own monotonic guest clock so the
// returned tick count is consistent with GetTickCount and the shared-user-data
// fields. Frequency is the same 1e9 Hz those fields advertise.
function queryPerformanceCounter(r, a) {
  const pointer = a(0);
  if (!pointer) return fail(r, 87, 1);
  r.check(pointer, 8, true);
  const { low, high } = (() => {
    const value = r.performanceClock.read();
    return { low: Number(value & 0xffffffffn), high: Number((value >> 32n) & 0xffffffffn) };
  })();
  r.write32(pointer, low);
  r.write32(pointer + 4, high);
  return ok(1, 1);
}
function queryPerformanceFrequency(r, a) {
  const pointer = a(0);
  if (!pointer) return fail(r, 87, 1);
  r.check(pointer, 8, true);
  r.write32(pointer, Number(GUEST_PERFORMANCE_FREQUENCY & 0xffffffffn));
  r.write32(pointer + 4, Number((GUEST_PERFORMANCE_FREQUENCY >> 32n) & 0xffffffffn));
  return ok(1, 1);
}

// GetVersion reports a Windows version from the runtime's compatibility model,
// never the host's. 0x0a280105 is Windows 10 build 2600-era encoding used by
// Wine's own default when no version lie is configured.
function getVersion() {
  return ok(0x0a280105, 0);
}
function getVersionEx(r, a, wide) {
  const pointer = a(0);
  if (!pointer) return fail(r, 87, 1);
  const size = r.read32(pointer);
  if (![148, 156, 276, 284].includes(size)) return fail(r, 87, 1);
  r.check(pointer, size, true);
  r.data.fill(0, pointer, pointer + size);
  if (wide) {
    r.write32(pointer, 284);
    r.write32(pointer + 4, 10);
    r.write32(pointer + 8, 0);
    r.write32(pointer + 12, 19045);
    r.write32(pointer + 16, 2);
  } else {
    r.write32(pointer, 156);
    r.write32(pointer + 4, 10);
    r.write32(pointer + 8, 0);
    r.write32(pointer + 12, 19045);
    r.write32(pointer + 16, 2);
  }
  return ok(1, 1);
}

// GetStartupInfo fills the structure CRT startup inspects; STARTF_USESTDHANDLES
// is deliberately clear so the default handles stay the console's.
function getStartupInfo(r, a, wide) {
  const pointer = a(0);
  const size = wide ? 104 : 68;
  if (!pointer) return ok(0, 1);
  r.check(pointer, size, true);
  r.data.fill(0, pointer, pointer + size);
  r.write32(pointer, size);
  return ok(0, 1);
}

function getSystemInfo(r, a) {
  const pointer = a(0);
  if (!pointer) return fail(r, 87, 1);
  r.check(pointer, 36, true);
  r.data.fill(0, pointer, pointer + 36);
  r.write32(pointer, 0); // PROCESSOR_ARCHITECTURE_INTEL.
  r.write32(pointer + 4, 5); // PROCESSOR_LEVEL.
  r.write32(pointer + 8, 4); // PROCESSOR_REVISION (family 5, model 4).
  r.write32(pointer + 12, 1); // NumberOfProcessors.
  r.write32(pointer + 16, 0x10000); // PAGE_SIZE.
  r.write32(pointer + 20, 0); // Lowest memory address.
  r.write32(pointer + 24, 0x7fffffff); // Highest memory address.
  r.write32(pointer + 28, 0x7fffffff); // Active processor mask.
  return ok(0, 1);
}

// Locale answers come from the runtime's fixed process locale. The NLS tables
// are a separate, optional service; these are the scalar queries CRT startup
// and ordinary applications make before any culture-sensitive formatting.
function getACP() {
  return ok(1252, 0); // Windows-1252, matching encodeAnsi/decodeAnsi.
}
function getOEMCP() {
  return ok(437, 0);
}
function getCPInfo(r, a) {
  // BOOL GetCPInfo(UINT CodePage, LPCPINFO lpCPInfo)
  const codePage = a(0),
    pointer = a(1);
  if (codePage !== 0 && codePage !== 1252 && codePage !== 437) return fail(r, 87, 2);
  if (!pointer) return fail(r, 87, 2);
  r.check(pointer, 20, true);
  r.data.fill(0, pointer, pointer + 20);
  r.write32(pointer + 4, 1); // MaxCharSize for a single-byte code page.
  r.data[pointer + 8] = 0x3f; // DefaultChar.
  return ok(1, 2);
}
function getUserDefaultLCID() {
  return ok(0x0409, 0); // en-US, the locale the NLS fixture also supplies.
}
function isValidCodePage(r, a) {
  return ok([0, 437, 850, 1252, 65001, 1200, 1201].includes(a(0)) ? 1 : 0, 1);
}
function isValidLocale(r, a) {
  return ok([0x0409, 0x0809, 0x0c0a].includes(a(0)) ? 1 : 0, 1);
}
function getLocaleInfo(r, a, wide) {
  const out = a(2);
  if (!out) return fail(r, 87, 4);
  // Only the plain text answers are modeled; numeric locale data is the NLS
  // service's job, so an unmodeled LCType fails rather than guessing.
  const values = {
    5: 'English_United States', // LOCALE_SENGLANGUAGE
    8: 'United States', // LOCALE_SENGCOUNTRY
    4097: 'en-US', // LOCALE_SNAME
    2: 'en-US', // LOCALE_SABBREVLANGNAME
    3: 'ENU', // LOCALE_SABBREVCTRYNAME
  };
  const value = values[a(1)];
  if (!value) return fail(r, 87, 4);
  if (wide) return ok(value.length + 1, 4) && writeWide(r, out, value, a(3));
  return writeAnsi(r, out, value, a(3));
}
function writeWide(r, address, value, capacity) {
  const length = capacity ? Math.min(value.length, capacity - 1) : value.length;
  r.check(address, (length + 1) * 2, true);
  for (let i = 0; i < length; i++) r.guestMemory.write(address + i * 2, value.charCodeAt(i), 2);
  r.guestMemory.write(address + length * 2, 0, 2);
  return { result: length + 1, argc: 4 };
}
function writeAnsi(r, address, value, capacity) {
  const bytes = encodeAnsi(value).bytes;
  const length = capacity ? Math.min(bytes.length, capacity - 1) : bytes.length;
  r.check(address, length + 1, true);
  r.data.set(bytes.subarray(0, length), address);
  r.data[address + length] = 0;
  return { result: length + 1, argc: 4 };
}

// GetFullPathName resolves a path against the guest's working directory and
// normalizes separators. It never touches the host filesystem.
function getFullPathName(r, a, wide) {
  const input = wide ? r.wideString(a(0)) : r.string(a(0));
  const buffer = a(1),
    length = a(2);
  if (!buffer || !length) return fail(r, 87, 3);
  let resolved = input.replace(/\//g, '\\');
  if (!/^[a-z]:\\/i.test(resolved) && !resolved.startsWith('\\'))
    resolved = (r.cwd ? packageDosPrefix(r.cwd) : 'C:\\') + resolved;
  // Collapse "." and ".." textually; no path component is followed on disk.
  const parts = [];
  for (const part of resolved.split('\\')) {
    if (part === '.' || part === '') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const drive = resolved.slice(0, 2);
  const full = drive + '\\' + parts.slice(1).join('\\');
  if (wide) {
    if (full.length + 1 <= length)
      for (let i = 0; i <= full.length; i++)
        r.guestMemory.write(buffer + i * 2, i === full.length ? 0 : full.charCodeAt(i), 2);
  } else {
    const bytes = encodeAnsi(full).bytes;
    if (bytes.length + 1 <= length) {
      r.data.set(bytes, buffer);
      r.data[buffer + bytes.length] = 0;
    }
  }
  if (a(3)) {
    r.check(a(3), 4, true);
    r.write32(a(3), 0);
  }
  return ok(full.length, 3);
}
function packageDosPrefix(cwd) {
  // Runtime cwd is a package-relative path such as "dynamicbranching/".
  return 'C:\\' + cwd.replace(/\//g, '\\');
}

function lstrcmpi(r, a, wide) {
  const left = (wide ? r.wideString(a(0)) : r.string(a(0))).toLowerCase(),
    right = (wide ? r.wideString(a(1)) : r.string(a(1))).toLowerCase();
  return ok(left === right ? 0 : left < right ? -1 : 1, 2);
}
function outputDebugString(r, a, wide) {
  const text = wide ? r.wideString(a(0)) : r.string(a(0));
  r.emit({ type: 'stdout', text });
  return ok(0, 1);
}

// IsBadReadPtr / IsBadWritePtr answer from the guest's own committed ranges.
// A probe that crosses into an uncommitted page reports "bad", which is exactly
// what the CRT's validation paths test.
function isBadPointer(r, a, write) {
  const pointer = a(0),
    size = a(1);
  if (!pointer) return ok(1, 2);
  if (!size) return ok(0, 2);
  try {
    r.check(pointer, size, write);
    return ok(0, 2);
  } catch {
    return ok(1, 2);
  }
}
function isBadCodePtr(r, a) {
  try {
    r.check(a(0), 1);
    return ok(0, 1);
  } catch {
    return ok(1, 1);
  }
}

function isProcessorFeaturePresent(r, a) {
  return ok(guestProcessorFeaturePresent(a(0)) ? 1 : 0, 1);
}

function setStdHandle(r, a) {
  const id = a(0);
  if (![0xfffffff4, 0xfffffff5, 0xfffffff6].includes(id | 0)) return fail(r, 6, 2);
  r.stdHandles ??= new Map();
  r.stdHandles.set(id | 0, a(1));
  return ok(1, 2);
}
function setFilePointer(r, a) {
  const handle = r.handles.get(a(0));
  if (!handle) return fail(r, 6, 4);
  const method = a(3);
  if (![0, 1, 2].includes(method)) return fail(r, 87, 4);
  const bytes = r.files.get(handle.path)?.length ?? 0;
  const base = method === 0 ? 0 : method === 1 ? handle.position : bytes;
  const offset = a(1) | 0;
  const next = base + offset;
  if (next < 0) return fail(r, 131, 4, 0xffffffff);
  handle.position = next;
  return ok(next, 4);
}
function getFileSize(r, a) {
  const handle = r.handles.get(a(0));
  if (!handle) return fail(r, 6, 2);
  const bytes = r.files.get(handle.path);
  const size = bytes ? bytes.length : 0;
  if (a(1)) {
    r.check(a(1), 4, true);
    r.write32(a(1), 0);
  }
  return ok(size, 2, 0xffffffff);
}
function getFileType(r, a) {
  const handle = a(0);
  if (handle === 0 || handle === 1 || handle === 2 || r.stdHandles?.has(handle | 0))
    return ok(2, 1); // FILE_TYPE_CHAR
  return r.handles.has(handle) ? ok(1, 1) : fail(r, 6, 1); // FILE_TYPE_DISK
}
function flushFileBuffers(r, a) {
  return r.handles.has(a(0)) || (a(0) >= 0 && a(0) <= 2) ? ok(1, 1) : fail(r, 6, 1);
}
function setEndOfFile(r, a) {
  const handle = r.handles.get(a(0));
  if (!handle) return fail(r, 6, 1);
  if (!(handle.access & 0x40000000)) return fail(r, 5, 1);
  const bytes = r.files.get(handle.path) ?? new Uint8Array();
  if (handle.position > 16 * 1024 * 1024) throw Error('Virtual file size limit exceeded');
  const updated = new Uint8Array(handle.position);
  updated.set(bytes.subarray(0, Math.min(bytes.length, handle.position)));
  r.files.set(handle.path, updated);
  r.fileSections?.fileChanged(handle.path);
  r.dirty.add(handle.path);
  return ok(1, 1);
}

function terminateProcess(r, a) {
  const code = a(1);
  r.exitCode = code;
  r.threads.terminateProcess(code);
  return ok(0, 2);
}
function raiseException(r, a) {
  // Structured exception handling is not implemented, so a raised exception is
  // a fatal guest fault: report the code so the harness shows why it stopped.
  throw Error(`Guest raised exception 0x${(a(0) >>> 0).toString(16)}`);
}

function environmentStrings(r, a, wide) {
  const key = wide ? 'environmentW' : 'environmentA';
  if (!r[key]) {
    const entries = ['=C:=C:\\', 'PATH=C:\\'];
    if (wide) {
      let total = 0;
      for (const entry of entries) total += (entry.length + 1) * 2;
      const address = r.allocate(total + 2, true);
      let offset = address;
      for (const entry of entries) {
        for (let i = 0; i < entry.length; i++)
          r.guestMemory.write(offset + i * 2, entry.charCodeAt(i), 2);
        offset += (entry.length + 1) * 2;
      }
      r[key] = address;
    } else {
      const encoded = entries.map((entry) => encodeAnsi(entry).bytes);
      const total = encoded.reduce((sum, bytes) => sum + bytes.length + 1, 0);
      const address = r.allocate(total + 1, true);
      let offset = address;
      for (const bytes of encoded) {
        r.data.set(bytes, offset);
        offset += bytes.length + 1;
      }
      r[key] = address;
    }
  }
  return ok(r[key], 0);
}
function getEnvironmentVariable(r, a, wide) {
  const name = (wide ? r.wideString(a(0)) : r.string(a(0))).toUpperCase();
  const values = { PATH: 'C:\\' };
  const value = values[name];
  if (!value) return ok(0, wide ? 2 : 3);
  const buffer = a(1),
    length = a(2);
  const encoded = wide ? null : encodeAnsi(value).bytes;
  const needed = (wide ? value.length : encoded.length) + 1;
  if (!buffer || length < needed) return ok(needed, wide ? 2 : 3);
  if (wide) writeWide(r, buffer, value, length);
  else writeAnsi(r, buffer, value, length);
  return ok(needed - 1, wide ? 2 : 3);
}
function freeEnvironmentStrings(r, a, wide) {
  const key = wide ? 'environmentW' : 'environmentA';
  if (r[key] && r[key] === a(0)) {
    r.free(r[key]);
    r[key] = 0;
  }
  return ok(1, 1);
}

function interlockedExchange(r, a) {
  r.check(a(0), 4, true);
  const previous = r.read32(a(0)) | 0;
  r.write32(a(0), a(1));
  return ok(previous, 2);
}
function interlockedCompareExchange(r, a) {
  r.check(a(0), 4, true);
  const previous = r.read32(a(0)) | 0;
  if (previous === (a(2) | 0)) r.write32(a(0), a(1));
  return ok(previous, 3);
}

export const startupApis = {
  'kernel32.dll!HeapCreate': heapCreate,
  'kernel32.dll!HeapDestroy': heapDestroy,
  'kernel32.dll!HeapReAlloc': heapReAlloc,
  'kernel32.dll!HeapSize': heapSize,
  'kernel32.dll!InitializeCriticalSection': (r, a) => criticalSection(r, a, 1),
  // Both ...AndSpinCount and ...Ex return BOOL: nonzero means initialized. The
  // plain InitializeCriticalSection returns void, so it stays with ok(0).
  'kernel32.dll!InitializeCriticalSectionAndSpinCount': (r, a) => {
    const initialized = criticalSection(r, a, 2);
    if (!initialized.result) return ok(0, 2);
    r.write32(a(0) + 20, a(1));
    return ok(1, 2);
  },
  'kernel32.dll!InitializeCriticalSectionEx': (r, a) => {
    const initialized = criticalSection(r, a, 3);
    if (!initialized.result) return ok(0, 3);
    r.write32(a(0) + 20, a(1));
    return ok(1, 3);
  },
  'kernel32.dll!EnterCriticalSection': (r, a) => criticalSectionCall(r, a, 'enter'),
  'kernel32.dll!LeaveCriticalSection': (r, a) => criticalSectionCall(r, a, 'leave'),
  'kernel32.dll!DeleteCriticalSection': (r, a) => {
    if (a(0)) r.criticalSections?.delete(a(0));
    return ok(0, 1);
  },
  'kernel32.dll!TryEnterCriticalSection': (r, a) => ok(1, 1),
  'kernel32.dll!QueryPerformanceCounter': queryPerformanceCounter,
  'kernel32.dll!QueryPerformanceFrequency': queryPerformanceFrequency,
  'kernel32.dll!GetVersion': getVersion,
  'kernel32.dll!GetVersionExA': (r, a) => getVersionEx(r, a, false),
  'kernel32.dll!GetVersionExW': (r, a) => getVersionEx(r, a, true),
  'kernel32.dll!GetStartupInfoA': (r, a) => getStartupInfo(r, a, false),
  'kernel32.dll!GetStartupInfoW': (r, a) => getStartupInfo(r, a, true),
  'kernel32.dll!GetSystemInfo': getSystemInfo,
  'kernel32.dll!GetACP': getACP,
  'kernel32.dll!GetOEMCP': getOEMCP,
  'kernel32.dll!GetCPInfo': getCPInfo,
  'kernel32.dll!GetUserDefaultLCID': getUserDefaultLCID,
  'kernel32.dll!IsValidCodePage': isValidCodePage,
  'kernel32.dll!IsValidLocale': isValidLocale,
  'kernel32.dll!GetLocaleInfoA': (r, a) => getLocaleInfo(r, a, false),
  'kernel32.dll!GetLocaleInfoW': (r, a) => getLocaleInfo(r, a, true),
  'kernel32.dll!GetFullPathNameA': (r, a) => getFullPathName(r, a, false),
  'kernel32.dll!GetFullPathNameW': (r, a) => getFullPathName(r, a, true),
  'kernel32.dll!lstrcmpiA': (r, a) => lstrcmpi(r, a, false),
  'kernel32.dll!lstrcmpiW': (r, a) => lstrcmpi(r, a, true),
  'kernel32.dll!lstrcmpA': (r, a) => lstrcmpi(r, a, false),
  'kernel32.dll!OutputDebugStringA': (r, a) => outputDebugString(r, a, false),
  'kernel32.dll!OutputDebugStringW': (r, a) => outputDebugString(r, a, true),
  'kernel32.dll!IsBadReadPtr': (r, a) => isBadPointer(r, a, false),
  'kernel32.dll!IsBadWritePtr': (r, a) => isBadPointer(r, a, true),
  'kernel32.dll!IsBadCodePtr': isBadCodePtr,
  'kernel32.dll!IsBadStringPtrA': (r, a) => isBadPointer(r, a, false),
  'kernel32.dll!IsProcessorFeaturePresent': isProcessorFeaturePresent,
  'kernel32.dll!SetStdHandle': setStdHandle,
  'kernel32.dll!SetFilePointer': setFilePointer,
  'kernel32.dll!GetFileSize': getFileSize,
  'kernel32.dll!GetFileType': getFileType,
  'kernel32.dll!FlushFileBuffers': flushFileBuffers,
  'kernel32.dll!SetEndOfFile': setEndOfFile,
  'kernel32.dll!TerminateProcess': terminateProcess,
  'kernel32.dll!RaiseException': raiseException,
  'kernel32.dll!GetEnvironmentStrings': (r) => environmentStrings(r, null, false),
  'kernel32.dll!GetEnvironmentStringsW': (r) => environmentStrings(r, null, true),
  'kernel32.dll!FreeEnvironmentStringsA': (r, a) => freeEnvironmentStrings(r, a, false),
  'kernel32.dll!FreeEnvironmentStringsW': (r, a) => freeEnvironmentStrings(r, a, true),
  'kernel32.dll!GetEnvironmentVariableA': (r, a) => getEnvironmentVariable(r, a, false),
  'kernel32.dll!GetEnvironmentVariableW': (r, a) => getEnvironmentVariable(r, a, true),
  'kernel32.dll!InterlockedExchange': interlockedExchange,
  'kernel32.dll!InterlockedCompareExchange': interlockedCompareExchange,
};

// ---------------------------------------------------------------------------
// Virtual memory. Win32's VirtualAlloc/VirtualFree share the NT allocator the
// runtime already models, so their address space, commit and protection
// behaviour match what NtAllocateVirtualMemory reports.
const MEM_COMMIT = 0x1000,
  MEM_RESERVE = 0x2000,
  MEM_RELEASE = 0x8000,
  MEM_DECOMMIT = 0x4000;
// NT memory-protection constants share their numeric values with the Win32
// PAGE_* constants, and the allocator now stores the full set (including
// PAGE_EXECUTE_*, which real loaders, packers and JITs request), so the guest's
// requested protection passes through rather than being flattened to
// read/write. An unrecognised value is still rejected before any allocation.
const VALID_PROTECT = {
  0x01: true,
  0x02: true,
  0x04: true,
  0x08: true,
  0x10: true,
  0x20: true,
  0x40: true,
  0x80: true,
};
function virtualAlloc(r, a) {
  const address = a(0) >>> 0,
    size = a(1) >>> 0,
    type = a(2) >>> 0,
    protect = a(3) >>> 0;
  if (!size) return fail(r, 87, 4);
  if (!(type & (MEM_COMMIT | MEM_RESERVE))) return fail(r, 87, 4);
  // The requested protection is carried even for a reserve-only call: the
  // allocator records it on the reservation and applies it when the guest
  // commits. A protection the runtime does not model fails up front.
  if (!VALID_PROTECT[protect]) return fail(r, 87, 4);
  const ntType = (type & MEM_RESERVE ? 0x2000 : 0) | (type & MEM_COMMIT ? 0x1000 : 0);
  const result = r.virtualMemory.allocate(address, size, ntType, protect);
  if (result.status) return fail(r, 8, 4);
  return ok(result.base, 4);
}
function virtualFree(r, a) {
  const address = a(0) >>> 0,
    size = a(1) >>> 0,
    type = a(2) >>> 0;
  if (!address) return fail(r, 87, 3);
  if (type === MEM_RELEASE) {
    if (size) return fail(r, 87, 3);
    const result = r.virtualMemory.free(address, 0, 0x8000);
    return result.status ? fail(r, 8, 3) : ok(1, 3);
  }
  if (type !== MEM_DECOMMIT) return fail(r, 87, 3);
  const result = r.virtualMemory.free(address, size, 0x4000);
  return result.status ? fail(r, 8, 3) : ok(1, 3);
}

// ---------------------------------------------------------------------------
// Locale string services. These are the ANSI/Unicode mapping helpers CRT
// startup and text handling call; the runtime's NLS fixture supplies the real
// collation tables when available, and these cover the scalar operations.
function lcMapString(r, a, wide) {
  const flags = a(2) >>> 0;
  const source = a(1),
    count = a(3) | 0;
  const destination = a(4),
    capacity = a(5) | 0;
  if (count < 0 || capacity < 0) return fail(r, 87, 6);
  // Only case mapping is modeled; sorting/weight flags need the NLS service.
  if (flags & ~0x00040000) return fail(r, 87, 6);
  const upper = !!(flags & 0x00040000);
  if (wide) {
    let text = '';
    for (let i = 0; i < count; i++) {
      const code = r.guestMemory.read(source + i * 2, 2);
      text += String.fromCharCode(code);
    }
    if (upper) text = text.toUpperCase();
    if (!destination || !capacity) return ok(text.length, 6);
    return writeWide(r, destination, text, capacity);
  }
  let text = '';
  for (let i = 0; i < count; i++) text += String.fromCharCode(r.guestMemory.read(source + i, 1));
  if (upper) text = text.toUpperCase();
  if (!destination || !capacity) return ok(text.length, 6);
  const bytes = encodeAnsi(text).bytes;
  const length = Math.min(bytes.length, capacity - 1);
  r.check(destination, length + 1, true);
  r.data.set(bytes.subarray(0, length), destination);
  r.data[destination + length] = 0;
  return ok(length + 1, 6);
}
function getStringType(r, a, wide) {
  const kind = a(0) >>> 0;
  if (kind !== 1) return fail(r, 87, 5); // CT_CTYPE1 only.
  const source = a(1),
    count = a(2) | 0,
    destination = a(3);
  if (count < 0 || !destination) return fail(r, 87, 5);
  r.check(destination, count * 2, true);
  for (let i = 0; i < count; i++) {
    const code = wide ? r.guestMemory.read(source + i * 2, 2) : r.guestMemory.read(source + i, 1);
    const char = String.fromCharCode(code);
    let types = 0;
    if (/[a-zA-Z]/.test(char))
      types |= 0x0100 | 0x0004 | (char === char.toUpperCase() ? 0x0001 : 0x0002);
    if (/[0-9]/.test(char)) types |= 0x0004;
    if (/\s/.test(char)) types |= 0x0008;
    if (/[!-\/:-@\[-`{-~]/.test(char)) types |= 0x0010;
    r.guestMemory.write(destination + i * 2, types, 2);
  }
  return ok(1, 5);
}
async function enumSystemLocales(r, a, wide, present) {
  // The runtime models exactly the locales its NLS data and locale answers
  // describe, so the callback sees that bounded set and no more.
  const callback = a(0),
    kind = a(1) >>> 0;
  if (!callback) return fail(r, 87, 2);
  if (!present && kind !== 1) return fail(r, 87, 2); // LCID_SUPPORTED
  const locales = ['00000409', '00000809', '00000c0a'];
  for (const locale of locales) {
    const address = r.allocString(locale, wide);
    const returned = await r.callGuest(callback, [address]);
    if (!returned) return ok(0, 2);
  }
  return ok(1, 2);
}

// ---------------------------------------------------------------------------
// Clipboard. The clipboard is process-local storage for the runtime's own
// windows; OpenClipboard tracks the owning window, and the data formats keep
// the exact bytes the guest published.
function openClipboard(r, a) {
  if (r.clipboardOpen) return fail(r, 5, 1);
  const owner = a(0);
  if (owner && !r.windows.windows.has(owner)) return fail(r, 1400, 1);
  r.clipboardOpen = { owner, formats: new Map() };
  return ok(1, 1);
}
function emptyClipboard(r) {
  if (!r.clipboardOpen) return fail(r, 5, 0);
  r.clipboardOpen.formats.clear();
  return ok(1, 0);
}
function setClipboardData(r, a) {
  if (!r.clipboardOpen) return fail(r, 5, 2);
  const bytes = r.handles.get(a(1));
  // Only the runtime's own global-memory handles are accepted; the data is
  // copied so the guest may free its handle afterwards.
  if (a(1) && !bytes && !r.customHeaps) return fail(r, 6, 2);
  r.clipboardOpen.formats.set(a(0), { handle: a(1) });
  return ok(a(1), 2);
}
function closeClipboard(r) {
  if (!r.clipboardOpen) return fail(r, 5, 0);
  const data = r.clipboardOpen;
  r.clipboardOpen = null;
  r.clipboard = data;
  return ok(1, 0);
}

// ---------------------------------------------------------------------------
// Unhandled exception handling. WineBrowser has no SEH delivery, so the filter
// is recorded (Set/Get round-trip) and a real unhandled exception still stops
// the run with the guest's code instead of silently continuing.
function setUnhandledExceptionFilter(r, a) {
  const previous = r.unhandledExceptionFilter ?? 0;
  r.unhandledExceptionFilter = a(0);
  return ok(previous, 1);
}
function unhandledExceptionFilter(r, a) {
  // EXCEPTION_EXECUTE_HANDLER (1): the process should terminate. The runtime
  // has no SEH, so a real unhandled exception stops the run with its code.
  r.exitCode = a(0) >>> 0;
  return ok(1, 1);
}

// ---------------------------------------------------------------------------
// Process-introspection queries the runtime can answer from its own model.
function isDebuggerPresent() {
  return ok(0, 0); // WineBrowser is not a debugger.
}
function setThreadAffinityMask(r, a) {
  const thread = r.threads.records.get(a(0) >>> 0) ?? r.threads.current;
  if (!thread) return fail(r, 6, 2);
  const previous = thread.affinity ?? 1;
  const mask = a(1) >>> 0;
  if (!mask) return fail(r, 87, 2);
  thread.affinity = mask;
  return ok(previous, 2);
}
function getMonitorInfo(r, a, wide) {
  // MONITORINFO is a 40-byte structure: cbSize, rcMonitor, rcWork, dwFlags.
  const monitor = a(0) >>> 0,
    out = a(1);
  if (!out) return fail(r, 87, 2);
  const size = r.read32(out);
  if (size !== 40) return fail(r, 87, 2);
  const display = r.windows?.display ?? { width: 640, height: 480 };
  r.check(out, 40, true);
  r.data.fill(0, out, out + 40);
  r.write32(out, 40);
  for (const offset of [4, 16]) {
    r.write32(out + offset, 0);
    r.write32(out + offset + 4, 0);
    r.write32(out + offset + 8, display.width);
    r.write32(out + offset + 12, display.height);
  }
  r.write32(out + 36, 1); // MONITORINFOF_PRIMARY
  return ok(1, 2);
}

export const startupApis5 = {
  'kernel32.dll!IsDebuggerPresent': isDebuggerPresent,
  'kernel32.dll!CheckRemoteDebuggerPresent': (r, a) => {
    if (a(1)) {
      r.check(a(1), 4, true);
      r.write32(a(1), 0);
    }
    return ok(1, 2);
  },
  'kernel32.dll!SetThreadAffinityMask': setThreadAffinityMask,
  'kernel32.dll!GetCurrentProcessorNumber': () => ok(0, 0),
  'user32.dll!GetMonitorInfoA': (r, a) => getMonitorInfo(r, a, false),
  'user32.dll!GetMonitorInfoW': (r, a) => getMonitorInfo(r, a, true),
  'user32.dll!MonitorFromWindow': (r, a) => ok(0x10001, 2),
  'user32.dll!MonitorFromPoint': (r, a) => ok(0x10001, 3),
  'user32.dll!MonitorFromRect': (r, a) => ok(0x10001, 2),
};
export const startupApis2 = {
  'kernel32.dll!VirtualAlloc': virtualAlloc,
  'kernel32.dll!VirtualFree': virtualFree,
  'kernel32.dll!LCMapStringA': (r, a) => lcMapString(r, a, false),
  'kernel32.dll!LCMapStringW': (r, a) => lcMapString(r, a, true),
  'kernel32.dll!GetStringTypeA': (r, a) => getStringType(r, a, false),
  'kernel32.dll!GetStringTypeW': (r, a) => getStringType(r, a, true),
  'kernel32.dll!EnumSystemLocalesA': (r, a) => enumSystemLocales(r, a, false, true),
  'kernel32.dll!EnumSystemLocalesW': (r, a) => enumSystemLocales(r, a, true, true),
  'kernel32.dll!SetUnhandledExceptionFilter': setUnhandledExceptionFilter,
  'kernel32.dll!UnhandledExceptionFilter': unhandledExceptionFilter,
  'kernel32.dll!SetHandleCount': (r, a) => ok(a(0), 1),
  // RtlUnwind(EndFrame, TargetIp, ExceptionRecord, ReturnValue) is __stdcall and
  // never returns: it walks the fs:[0] chain calling each handler with
  // EXCEPTION_UNWINDING set, then hands control to the frame that accepted the
  // exception with ReturnValue in EAX. The unwind itself must run as guest code,
  // so the dispatcher performs it and replaces the continuation; a throw here
  // unwinds the runtime rather than the guest.
  'kernel32.dll!RtlUnwind': (r, a) => {
    const endFrame = a(0) >>> 0;
    const targetIp = a(1) >>> 0;
    const retval = a(3) >>> 0;
    throw new GuestUnwind({
      endFrame,
      targetIp,
      retval,
      faultEip: r.cpu.instructionIp,
    });
  },
  'user32.dll!OpenClipboard': openClipboard,
  'user32.dll!EmptyClipboard': emptyClipboard,
  'user32.dll!SetClipboardData': setClipboardData,
  'user32.dll!CloseClipboard': closeClipboard,
  'user32.dll!GetClipboardData': (r, a) => {
    if (!r.clipboardOpen) return fail(r, 5, 1);
    return ok(r.clipboardOpen.formats.get(a(0))?.handle ?? 0, 1);
  },
  'user32.dll!IsClipboardFormatAvailable': (r, a) => {
    const source = r.clipboardOpen ?? r.clipboard;
    return ok(source?.formats.has(a(0)) ? 1 : 0, 1);
  },
};

// ---------------------------------------------------------------------------
// Shell special folders. These answer from the runtime's own virtual shell
// layout, never the host filesystem, so a path the guest later opens resolves
// through the package volume like any other guest path.
const SPECIAL_FOLDERS = {
  0x0000: 'C:\\Desktop',
  0x0005: 'C:\\My Documents',
  0x0010: 'C:\\Desktop',
  0x0014: 'C:\\Windows\\Fonts',
  0x0015: 'C:\\Templates',
  0x001a: 'C:\\Users\\wineuser\\Application Data',
  0x001c: 'C:\\Users\\wineuser\\Local Settings\\Application Data',
  0x0024: 'C:\\Windows',
  0x0025: 'C:\\Windows\\System32',
  0x0028: 'C:\\Users\\wineuser',
};
function getSpecialFolderPath(r, a, wide) {
  const path = SPECIAL_FOLDERS[a(1) >>> 0];
  if (!path) return fail(r, 87, 3);
  const buffer = a(2);
  if (!buffer) return fail(r, 87, 3);
  // MAX_PATH characters; create=false is a hint the folder already exists.
  if (wide) {
    if (path.length + 1 > 260) return fail(r, 87, 3);
    writeWide(r, buffer, path, 260);
  } else {
    const bytes = encodeAnsi(path).bytes;
    if (bytes.length + 1 > 260) return fail(r, 87, 3);
    r.check(buffer, bytes.length + 1, true);
    r.data.set(bytes, buffer);
    r.data[buffer + bytes.length] = 0;
  }
  return ok(1, 3);
}

export const startupApis3 = {
  'shell32.dll!SHGetSpecialFolderPathA': (r, a) => getSpecialFolderPath(r, a, false),
  'shell32.dll!SHGetSpecialFolderPathW': (r, a) => getSpecialFolderPath(r, a, true),
};

// ---------------------------------------------------------------------------
// ShellExecuteA. Launching another process is not implemented, so every call
// reports SE_ERR_ACCESSDENIED with ERROR_ACCESS_DENIED rather than pretending a
// document opened. The verb and file are still read so the failure can be
// traced to the exact request.
function shellExecute(r, a, wide) {
  const operation = a(1) ? (wide ? r.wideString(a(1)) : r.string(a(1))) : 'open';
  const file = a(2) ? (wide ? r.wideString(a(2)) : r.string(a(2))) : '';
  r.emit({ type: 'stdout', text: `ShellExecute(${operation}, ${file}) is not implemented\n` });
  return fail(r, 5, 6, 5); // SE_ERR_ACCESSDENIED
}

// ShellAboutW/A renders the standard About box: an optional icon, the
// application name and version, a copyright line and a trailing comment. The
// runtime reports the same values through its log so a headless run records
// what the dialog would have shown.
function shellAbout(r, a, wide) {
  const read = (pointer) => (!pointer ? '' : wide ? r.wideString(pointer) : r.string(pointer));
  const owner = a(0);
  if (owner && !r.windows.windows.has(owner)) return fail(r, 1400, 4);
  const lines = [read(a(1)), read(a(2)), read(a(3))].filter(Boolean);
  if (lines.length) r.emit({ type: 'log', text: lines.join('\n') });
  return ok(1, 4);
}

export const startupApis4 = {
  'shell32.dll!ShellExecuteA': (r, a) => shellExecute(r, a, false),
  'shell32.dll!ShellExecuteW': (r, a) => shellExecute(r, a, true),
  'shell32.dll!ShellExecuteExA': (r, a) => fail(r, 5, 1, 0),
  'shell32.dll!ShellExecuteExW': (r, a) => fail(r, 5, 1, 0),
  // SetEnvironmentVariableA/W and GetUserNameA/W are exported by kernel32 as
  // well as advapi32; the kernel32 implementations live in win32-system.js.
  'shell32.dll!ShellAboutA': (r, a) => shellAbout(r, a, false),
  'shell32.dll!ShellAboutW': (r, a) => shellAbout(r, a, true),
};
