// One guest-thread COM apartment, with real native in-process class factories.
// Cross-apartment proxies, activation manifests and out-of-process servers are
// separate services; never substitute a host object for an unknown CLSID.
import { readGuid } from './com.js';
import { classRegistryKey, registryString } from './com-registry.js';
import { guidApis } from './win32-guid.js';

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

export const comApis = {
  ...guidApis,
  'ole32.dll!CoInitialize': (r, a) => initialize(r, a(0), 2, 1),
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
