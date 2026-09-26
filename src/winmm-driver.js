// Installable multimedia drivers run their own native DriverProc. The browser
// owns only DLL references and instance lifetimes, not codec results.
import { registryStore } from './win32-registry.js';

const LOAD = 1,
  ENABLE = 2,
  OPEN = 3,
  CLOSE = 4,
  DISABLE = 5,
  FREE = 6;
const states = new WeakMap();
const response = (result, argc) => ({ result: result >>> 0, argc });

function stateFor(r) {
  let state = states.get(r);
  if (!state) states.set(r, (state = new Map()));
  // A surrounding DLL transaction may have rolled back a reentrant open.
  for (const [handle, instance] of state)
    if (r.graph.modules.get(instance.module.key) !== instance.module) state.delete(handle);
  return state;
}

const peers = (r, module) => [...stateFor(r).values()].filter((i) => i.module === module);
async function send(r, instance, message, first = 0, second = 0) {
  instance.busy++;
  try {
    return await r.callGuest(instance.proc, [instance.id, instance.handle, message, first, second]);
  } finally {
    instance.busy--;
  }
}

function registeredName(r, name, section) {
  const registry = registryStore.stateFor(r);
  const node = registryStore.openPath(registry.roots.get(0x80000002), [
    'Software',
    'Microsoft',
    'Windows NT',
    'CurrentVersion',
    ...section.split('\\'),
  ]);
  const value = node?.values.get(name.toUpperCase());
  if (value?.type === 1 && value.data.length <= 522 && value.data.length % 2 === 0)
    return new TextDecoder('utf-16le').decode(value.data).split('\0')[0];
  // SYSTEM.INI redirection/profile semantics are a separate service. Do not
  // silently ignore a package which explicitly depends on that configuration.
  if (r.files.has('system.ini') || r.files.has('windows/system.ini'))
    throw Error(
      'WinMM SYSTEM.INI driver aliases are unsupported; use a DLL path or registry alias',
    );
  return null;
}

async function remove(r, instance, first, second) {
  if (instance.busy || instance.phase !== 'open') return 0;
  instance.phase = 'closing';
  await send(r, instance, CLOSE, first, second);
  if (peers(r, instance.module).length === 1) {
    await send(r, instance, DISABLE);
    await send(r, instance, FREE);
  }
  stateFor(r).delete(instance.handle);
  await r.freeLibrary(instance.module.base);
  return 1;
}

async function close(r, handle, first, second) {
  const instance = stateFor(r).get(handle >>> 0);
  if (!instance || instance.session) return 0;
  if (!(await remove(r, instance, first, second))) return 0;
  const remaining = peers(r, instance.module);
  if (remaining.length === 1 && remaining[0].session) await remove(r, remaining[0], 0, 0);
  return 1;
}

async function tryOpen(r, value, parameter) {
  if (!value || value.length > 260) return 0;
  const split = value.indexOf(' '),
    path = split < 0 ? value : value.slice(0, split),
    option = split < 0 ? '' : value.slice(split + 1).replace(/^ +/, '');
  let base;
  try {
    base = await r.loadLibrary(path);
  } catch (error) {
    if (error.win32Error === 126) return 0;
    throw error;
  }
  let retained = false,
    scratch = 0,
    session = null;
  const module = [...r.graph.modules.values()].find((m) => m.base === base);
  try {
    let proc;
    try {
      proc = await r.resolveExport(module, 'DriverProc');
    } catch (error) {
      if (error.win32Error === 127) return 0;
      throw error;
    }
    const state = stateFor(r),
      existing = peers(r, module);
    if (state.size + (!existing.length && parameter ? 2 : 1) > 1024)
      throw Error('Installable driver instance limit exceeded');
    if (existing.some((i) => i.phase !== 'open'))
      throw Error('Reentrant open during driver initialization or closure is unsupported');
    // WinMM keeps a hidden null-parameter session when the first caller supplies
    // an open descriptor. Every instance owns its own LoadLibrary reference.
    if (!existing.length && parameter) {
      const handle = await tryOpen(r, value, 0);
      if (!handle) return 0;
      session = state.get(handle);
      session.session = true;
    }
    const instance = {
      module,
      proc,
      id: 0,
      handle: r.nextHandle++,
      busy: 0,
      phase: 'opening',
      session: false,
    };
    const first = peers(r, module).length === 0;
    state.set(instance.handle, instance);
    try {
      if (first) {
        if ((await send(r, instance, LOAD)) !== 1) return 0;
        await send(r, instance, ENABLE);
      }
      if (option) scratch = r.allocString(option, true);
      instance.id = await send(r, instance, OPEN, scratch, parameter);
      if (!instance.id) {
        if (first) {
          await send(r, instance, DISABLE);
          await send(r, instance, FREE);
        }
        return 0;
      }
      instance.phase = 'open';
      retained = true;
      return instance.handle;
    } finally {
      if (!retained) state.delete(instance.handle);
    }
  } finally {
    if (scratch) r.free(scratch);
    if (!retained) {
      if (session) await remove(r, session, 0, 0);
      await r.freeLibrary(base);
    }
  }
}

async function open(r, a, ansi) {
  const read = (p) => (p ? (ansi ? r.string(p) : r.wideString(p)) : null);
  const name = read(a(0)),
    section = read(a(1));
  if (!name || name.length > 260 || (section !== null && (!section || section.length > 260)))
    return response(0, 3);
  if (section === null) {
    const handle = await tryOpen(r, name, a(2));
    if (handle) return response(handle, 3);
  }
  return response(await tryOpen(r, registeredName(r, name, section ?? 'Drivers32'), a(2)), 3);
}

export const driverApis = {
  'winmm.dll!OpenDriver': (r, a) => open(r, a, false),
  'winmm.dll!OpenDriverA': (r, a) => open(r, a, true),
  'winmm.dll!CloseDriver': async (r, a) => response(await close(r, a(0), a(1), a(2)), 3),
  'winmm.dll!SendDriverMessage': async (r, a) => {
    const instance = stateFor(r).get(a(0) >>> 0);
    return response(instance ? await send(r, instance, a(1), a(2), a(3)) : 0, 4);
  },
  'winmm.dll!GetDriverModuleHandle': (r, a) =>
    response(stateFor(r).get(a(0) >>> 0)?.module.base ?? 0, 1),
  'winmm.dll!GetDriverFlags': (r, a) => response(stateFor(r).has(a(0) >>> 0) ? 0x80000000 : 0, 1),
  'winmm.dll!DefDriverProc': (r, a) =>
    response([LOAD, ENABLE, DISABLE, FREE, 9, 10].includes(a(2)) ? 1 : 0, 5),
};
