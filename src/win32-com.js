import { errorInfoApis } from './win32-error-info.js';
// One guest-thread COM apartment, with real native in-process class factories.
// Cross-apartment proxies, activation manifests and out-of-process servers are
// separate services; never substitute a host object for an unknown CLSID.
import { readGuid } from './com.js';
import { classRegistryKey, registryString } from './com-registry.js';
import { guidApis } from './win32-guid.js';
import { taskMemoryApis } from './win32-shell-folders.js';

const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const E_NOTIMPL = 0x80004001;
const CO_E_NOTINITIALIZED = 0x800401f0;
const CO_E_DLLNOTFOUND = 0x800401f8;
const CO_E_ERRORINDLL = 0x800401f9;
const REGDB_E_CLASSNOTREG = 0x80040154;
const RPC_E_CHANGED_MODE = 0x80010106;
const states = new WeakMap();
const response = (result, argc) => ({ result: result >>> 0, argc });
const failed = (hr) => (hr & 0x80000000) !== 0;

function stateFor(r) {
  let state = states.get(r);
  if (!state) {
    state = { count: 0, mode: null, modules: new Map() };
    states.set(r, state);
  }
  return state;
}

function initialize(r, reserved, flags, argc) {
  if (reserved || flags & ~0xe) return response(E_INVALIDARG, argc);
  const state = stateFor(r),
    mode = flags & 2;
  if (state.count && state.mode !== mode) return response(RPC_E_CHANGED_MODE, argc);
  if (state.count >= 0x7fffffff) throw Error('COM initialization count limit exceeded');
  state.mode = mode;
  return response(state.count++ ? 1 : 0, argc);
}

function serverFor(r, clsid) {
  const node = classRegistryKey(r, ['CLSID', `{${clsid}}`, 'InprocServer32']);
  return node
    ? { path: registryString(node), model: registryString(node, 'ThreadingModel') }
    : null;
}

function output(r, pointer) {
  if (!pointer) return false;
  r.check(pointer, 4, true);
  r.write32(pointer, 0);
  return true;
}

async function classObject(r, clsidPointer, context, reserved, iidPointer, out) {
  if (!output(r, out)) return E_POINTER;
  if (!clsidPointer || !iidPointer) return E_INVALIDARG;
  const clsid = readGuid(r, clsidPointer);
  readGuid(r, iidPointer);
  if (reserved || !context) return E_INVALIDARG;
  if (!stateFor(r).count) return CO_E_NOTINITIALIZED;
  if (context & ~0x17) return E_NOTIMPL;
  if (!(context & 1)) return REGDB_E_CLASSNOTREG;
  const server = serverFor(r, clsid);
  if (!server?.path) return REGDB_E_CLASSNOTREG;
  const state = stateFor(r),
    model = (server.model ?? '').toLowerCase();
  const compatible =
    model === 'both' ||
    (state.mode === 2 ? model === 'apartment' || model === '' : model === 'free');
  if (!compatible) return E_NOTIMPL; // Would need a different apartment/proxy.

  const key = server.path.toLowerCase();
  let entry = state.modules.get(key);
  // A failed surrounding DLL attach can roll back a reentrant COM activation.
  // Never reuse a pointer into an image that transaction removed.
  if (entry && r.graph.modules.get(entry.module.key) !== entry.module) {
    state.modules.delete(key);
    entry = null;
  }
  if (!entry) {
    let base;
    try {
      base = await r.loadLibrary(server.path);
    } catch (error) {
      if (error.win32Error === 126) return CO_E_DLLNOTFOUND;
      throw error;
    }
    const module = [...r.graph.modules.values()].find((m) => m.base === base);
    let address;
    try {
      address = await r.resolveExport(module, 'DllGetClassObject');
    } catch (error) {
      await r.freeLibrary(base);
      if (error.win32Error === 127) return CO_E_ERRORINDLL;
      throw error;
    }
    entry = { module, address, busy: 0 };
    state.modules.set(key, entry); // COM owns one LoadLibrary reference.
  }
  entry.busy++;
  try {
    const hr = await r.callGuest(entry.address, [clsidPointer, iidPointer, out]);
    if (failed(hr)) r.write32(out, 0);
    else if (!r.read32(out)) return CO_E_ERRORINDLL;
    return hr;
  } finally {
    entry.busy--;
  }
}

async function createInstance(r, a) {
  const out = a(4) >>> 0;
  if (!output(r, out)) return response(E_POINTER, 5);
  if (!a(0) || !a(3)) return response(E_INVALIDARG, 5);
  readGuid(r, a(0));
  readGuid(r, a(3));
  const scratch = r.allocate(20);
  try {
    // IID_IClassFactory = 00000001-0000-0000-c000-000000000046.
    r.write32(scratch, 1);
    r.write32(scratch + 4, 0);
    r.write32(scratch + 8, 0xc0);
    r.write32(scratch + 12, 0x46000000);
    const hr = await classObject(r, a(0), a(2) >>> 0, 0, scratch, scratch + 16);
    if (failed(hr)) return response(hr, 5);
    const factory = r.read32(scratch + 16),
      vtable = r.read32(factory);
    const create = r.read32(vtable + 12),
      release = r.read32(vtable + 8);
    try {
      const result = await r.callGuest(create, [factory, a(1), a(3), out]);
      if (failed(result)) r.write32(out, 0);
      else if (!r.read32(out)) return response(CO_E_ERRORINDLL, 5);
      return response(result, 5);
    } finally {
      await r.callGuest(release, [factory]);
    }
  } finally {
    r.free(scratch);
  }
}

async function freeUnused(r) {
  const state = stateFor(r);
  for (const [key, entry] of [...state.modules]) {
    if (r.graph.modules.get(entry.module.key) !== entry.module) {
      state.modules.delete(key);
      continue;
    }
    if (entry.busy) continue;
    entry.busy++;
    try {
      let canUnload;
      try {
        canUnload = await r.resolveExport(entry.module, 'DllCanUnloadNow');
      } catch (error) {
        if (error.win32Error === 127) continue;
        throw error;
      }
      if ((await r.callGuest(canUnload)) === 0) {
        state.modules.delete(key);
        await r.freeLibrary(entry.module.base);
      }
    } finally {
      entry.busy--;
    }
  }
}

// ---------------------------------------------------------------------------
// OLE Automation string and VARIANT services. These are the small BSTR/VARIANT
// primitives a plain Win32 program links against oleaut32 for; they need no
// automation marshaller and no type library.
//
// A BSTR is a length-prefixed wide string: the pointer a caller holds points at
// the first character and the DWORD byte count sits immediately before it. The
// bytes live in ordinary guest memory, so the layout is the real one.
const VT_EMPTY = 0,
  VT_NULL = 1,
  VT_I4 = 3,
  VT_BSTR = 8,
  VT_DISPATCH = 9,
  VT_UNKNOWN = 13;
const DISP_E_TYPEMISMATCH = 0x80020005;
// VARIANT is 16 bytes on i386: vt at 0, three reserved WORDs, then the union.
const VARIANT_SIZE = 16;
const SCALAR_VARIANT_TYPES = new Set([
  VT_EMPTY,
  VT_NULL,
  2, // VT_I2
  VT_I4,
  4, // VT_R4
  5, // VT_R8
  6, // VT_CY
  7, // VT_DATE
  10, // VT_ERROR
  11, // VT_BOOL
  14, // VT_DECIMAL
  16, // VT_I1
  17, // VT_UI1
  18, // VT_UI2
  19, // VT_UI4
  20, // VT_I8
  21, // VT_UI8
  22, // VT_INT
  23, // VT_UINT
]);

function strlenW(r, pointer, limit = 0x100000) {
  let count = 0;
  while (count < limit && r.guestMemory.read(pointer + count * 2, 2)) count++;
  return count;
}
// Allocates a BSTR of exactly `count` characters from `source` (or zeroes).
function allocateBstr(r, source, count) {
  if (count > 0x100000) throw Error('BSTR length limit exceeded');
  return allocateBinaryBstr(r, source, count * 2);
}
// BSTRs can also contain binary data, embedded NULs and an odd byte count.
// Keep their byte prefix intact and append the two-byte UTF-16 terminator.
function allocateBinaryBstr(r, source, count) {
  if (count > 0x200000) throw Error('BSTR byte length limit exceeded');
  if (source && count) r.check(source, count);
  const base = r.allocate(count + 6);
  r.write32(base, count);
  const text = base + 4;
  if (source) r.data.set(r.guestMemory.readBytes(source, count), text);
  else r.data.fill(0, text, text + count);
  r.guestMemory.write(text + count, 0, 2);
  (r.bstrAllocations ??= new Map()).set(text, base);
  return text;
}
function freeBstr(r, text) {
  const base = r.bstrAllocations?.get(text);
  if (base === undefined) return;
  r.bstrAllocations.delete(text);
  r.free(base);
}

function sysAllocString(r, a) {
  const source = a(0);
  return response(source ? allocateBstr(r, source, strlenW(r, source)) : 0, 1);
}
function sysAllocStringLen(r, a) {
  return response(allocateBstr(r, a(0), a(1) >>> 0), 2);
}
function sysFreeString(r, a) {
  if (a(0)) freeBstr(r, a(0) >>> 0);
  return response(0, 1);
}
function sysStringLen(r, a) {
  const text = a(0) >>> 0;
  return response(text ? r.read32(text - 4) >>> 1 : 0, 1);
}
function sysReAllocString(r, a) {
  const holder = a(0) >>> 0;
  const source = a(1) >>> 0;
  if (!holder) return response(0, 2);
  const previous = r.read32(holder) >>> 0;
  if (!source) {
    if (previous) freeBstr(r, previous);
    r.write32(holder, 0);
    return response(1, 2);
  }
  const count = strlenW(r, source);
  // Reuse the block when it is large enough, exactly as OleAut32 does.
  if (previous && (r.read32(previous - 4) >>> 0) / 2 >= count) {
    for (let i = 0; i <= count; i++)
      r.guestMemory.write(
        previous + i * 2,
        i === count ? 0 : r.guestMemory.read(source + i * 2, 2),
        2,
      );
    r.write32(previous - 4, count * 2);
    return response(1, 2);
  }
  if (previous) freeBstr(r, previous);
  r.write32(holder, allocateBstr(r, source, count));
  return response(1, 2);
}
function sysReAllocStringLen(r, a) {
  const holder = a(0) >>> 0;
  const source = a(1) >>> 0;
  const count = a(2) >>> 0;
  if (!holder) return response(0, 3);
  const previous = r.read32(holder) >>> 0;
  // The source may legitimately be NULL for a zero-initialised result.
  if (previous && (r.read32(previous - 4) >>> 0) / 2 >= count) {
    for (let i = 0; i < count; i++)
      r.guestMemory.write(previous + i * 2, source ? r.guestMemory.read(source + i * 2, 2) : 0, 2);
    r.guestMemory.write(previous + count * 2, 0, 2);
    r.write32(previous - 4, count * 2);
    return response(1, 3);
  }
  if (previous) freeBstr(r, previous);
  r.write32(holder, allocateBstr(r, source, count));
  return response(1, 3);
}

function variantInit(r, a) {
  const pointer = a(0) >>> 0;
  if (pointer) {
    r.check(pointer, VARIANT_SIZE, true);
    r.data.fill(0, pointer, pointer + VARIANT_SIZE);
  }
  return response(0, 1);
}
function variantClear(r, a) {
  const pointer = a(0) >>> 0;
  if (!pointer) return response(0, 1);
  r.check(pointer, VARIANT_SIZE, true);
  const vt = r.guestMemory.read(pointer, 2);
  if (vt === VT_BSTR) {
    const text = r.read32(pointer + 8) >>> 0;
    if (text) freeBstr(r, text);
  } else if (!SCALAR_VARIANT_TYPES.has(vt)) {
    // Releasing an interface pointer needs that object's own Release, which a
    // synchronous handler cannot perform as a guest call; report the type
    // mismatch rather than dropping the reference silently.
    return response(DISP_E_TYPEMISMATCH, 1);
  }
  r.data.fill(0, pointer, pointer + VARIANT_SIZE);
  return response(0, 1);
}
function variantCopy(r, a) {
  const destination = a(0) >>> 0,
    source = a(1) >>> 0;
  if (!destination || !source) return response(0x80070057, 2); // E_INVALIDARG
  r.check(destination, VARIANT_SIZE, true);
  r.check(source, VARIANT_SIZE, false);
  if (destination === source) return response(0, 2);
  const vt = r.guestMemory.read(source, 2);
  if (vt !== VT_BSTR && !SCALAR_VARIANT_TYPES.has(vt)) return response(DISP_E_TYPEMISMATCH, 2);
  const sourceValue = r.data.slice(source, source + VARIANT_SIZE);
  const text = vt === VT_BSTR ? r.read32(source + 8) >>> 0 : 0;
  const copy = text ? allocateBinaryBstr(r, text, r.read32(text - 4) >>> 0) : 0;
  // Copy before clearing so aliases cannot destroy the source string.
  const previousType = r.guestMemory.read(destination, 2);
  if (previousType !== VT_BSTR && !SCALAR_VARIANT_TYPES.has(previousType)) {
    if (copy) freeBstr(r, copy);
    return response(DISP_E_TYPEMISMATCH, 2);
  }
  if (previousType === VT_BSTR) {
    const text = r.read32(destination + 8) >>> 0;
    if (text) freeBstr(r, text);
  }
  r.data.set(sourceValue, destination);
  if (vt === VT_BSTR) {
    r.write32(destination + 8, copy);
  }
  return response(0, 2);
}

export const oleautApis = {
  'oleaut32.dll!SysAllocString': sysAllocString,
  'oleaut32.dll!SysAllocStringLen': sysAllocStringLen,
  'oleaut32.dll!SysAllocStringByteLen': (r, a) =>
    response(allocateBinaryBstr(r, a(0), a(1) >>> 0), 2),
  'oleaut32.dll!SysReAllocString': sysReAllocString,
  'oleaut32.dll!SysReAllocStringLen': sysReAllocStringLen,
  'oleaut32.dll!SysFreeString': sysFreeString,
  'oleaut32.dll!SysStringLen': sysStringLen,
  'oleaut32.dll!SysStringByteLen': (r, a) => response(a(0) ? r.read32(a(0) - 4) >>> 0 : 0, 1),
  'oleaut32.dll!VariantInit': variantInit,
  'oleaut32.dll!VariantClear': variantClear,
  'oleaut32.dll!VariantCopy': variantCopy,
};

export const comApis = {
  ...taskMemoryApis,
  ...guidApis,
  ...oleautApis,
  ...errorInfoApis,
  'ole32.dll!ProgIDFromCLSID': (r, a) => {
    if (!a(1)) return response(E_INVALIDARG, 2);
    r.check(a(1), 4, true);
    r.write32(a(1), 0);
    const clsid = readGuid(r, a(0));
    const value = registryString(classRegistryKey(r, ['CLSID', `{${clsid}}`, 'ProgID']));
    if (value === null) return response(REGDB_E_CLASSNOTREG, 2);
    const { result: pointer } = taskMemoryApis['ole32.dll!CoTaskMemAlloc'](
      r,
      () => (value.length + 1) * 2,
    );
    if (!pointer) return response(0x8007000e, 2);
    for (let i = 0; i <= value.length; i++)
      r.guestMemory.write(pointer + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
    r.write32(a(1), pointer);
    return response(0, 2);
  },
  'ole32.dll!CoInitialize': (r, a) => initialize(r, a(0), 2, 1),
  // Console programs linked with GnuWin32's shortcut helper initialize an STA
  // before attempting shell-link activation. Share COM's apartment ownership
  // and changed-mode checks; unsupported OLE interfaces still fail activation.
  'ole32.dll!OleInitialize': (r, a) => initialize(r, a(0), 2, 1),
  'ole32.dll!CoInitializeEx': (r, a) => initialize(r, a(0), a(1) >>> 0, 2),
  'ole32.dll!CoUninitialize': async (r) => {
    const state = stateFor(r);
    if (state.count && --state.count === 0) {
      state.mode = null;
      await freeUnused(r);
    }
    return response(0, 0);
  },
  'ole32.dll!CoGetClassObject': async (r, a) =>
    response(await classObject(r, a(0), a(1) >>> 0, a(2), a(3), a(4)), 5),
  'ole32.dll!CoCreateInstance': createInstance,
  'ole32.dll!CoFreeUnusedLibraries': async (r) => {
    await freeUnused(r);
    return response(0, 0);
  },
};
