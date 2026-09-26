import { syncChecked } from './wine-sync.js';
const result = (value, argc) => ({ result: value, argc });
function fail(r, status, argc, value = 0) {
  r.lastError =
    {
      0xc0000005: 998,
      0xc0000008: 6,
      0xc0000022: 5,
      0xc0000024: 6,
      0xc000009a: 8,
      0xc000004a: 298,
      0xc000004b: 31,
      0xc00000bb: 50,
    }[status] ?? 87;
  return result(value, argc);
}
function create(r, a) {
  if (a(4) & ~0x10004) return fail(r, 0xc000000d, 6);
  if (a(5) && !syncChecked(r, a(5), 4, true)) return fail(r, 0xc0000005, 6);
  let inherit = false;
  if (a(0)) {
    if (!syncChecked(r, a(0), 12)) return fail(r, 0xc0000005, 6);
    if (r.read32(a(0)) !== 12) return fail(r, 0xc000000d, 6);
    if (r.read32(a(0) + 4)) return fail(r, 0xc00000bb, 6);
    inherit = !!r.read32(a(0) + 8);
  }
  const created = r.threads.create({
    start: a(2),
    parameter: a(3),
    reserve: a(4) & 0x10000 ? a(1) : 0,
    commit: a(4) & 0x10000 ? 0 : a(1),
    suspended: !!(a(4) & 4),
    inherit,
  });
  if (created.status) return fail(r, created.status, 6);
  if (a(5)) r.write32(a(5), created.thread.id);
  return result(created.handle, 6);
}
export const threadApis = {
  'kernel32.dll!SetThreadPriority': (r, a) => {
    const status = r.threads.setPriority(a(0), a(1) | 0);
    return status ? fail(r, status, 2) : result(1, 2);
  },
  'kernel32.dll!GetThreadPriority': (r, a) => {
    const found = r.threads.lookup(a(0), 0x40);
    return found.status
      ? fail(r, found.status, 1, 0x7fffffff)
      : result(found.thread.relativePriority ?? 0, 1);
  },
  'kernel32.dll!CreateThread': create,
  'kernel32.dll!GetCurrentThread': () => result(0xfffffffe, 0),
  'kernel32.dll!GetCurrentThreadId': (r) => result(r.threads.current.id, 0),
  'kernel32.dll!GetCurrentProcess': () => result(0xffffffff, 0),
  'kernel32.dll!GetCurrentProcessId': () => result(1, 0),
  'kernel32.dll!ExitThread': (r, a) => r.threads.exitHost(a(0)),
  'kernel32.dll!ResumeThread': (r, a) => {
    const changed = r.threads.resume(a(0));
    return changed.status ? fail(r, changed.status, 1, 0xffffffff) : result(changed.previous, 1);
  },
  'kernel32.dll!SuspendThread': async (r, a) => {
    const changed = r.threads.suspend(a(0));
    if (changed.status) return fail(r, changed.status, 1, 0xffffffff);
    await r.threads.yield();
    return result(changed.previous, 1);
  },
  'kernel32.dll!GetExitCodeThread': (r, a) => {
    const found = r.threads.lookup(a(0), 0x40);
    if (found.status) return fail(r, found.status, 2);
    if (!syncChecked(r, a(1), 4, true)) return fail(r, 0xc0000005, 2);
    r.write32(a(1), found.thread.done ? found.thread.code : 259);
    return result(1, 2);
  },
  'kernel32.dll!GetThreadId': (r, a) => {
    const found = r.threads.lookup(a(0), 0x40);
    return found.status ? fail(r, found.status, 1) : result(found.thread.id, 1);
  },
  'kernel32.dll!DisableThreadLibraryCalls': (r, a) => {
    const module = [...r.graph.modules.values()].find((m) => m.base === a(0));
    if (!module || module.pe.tls) return fail(r, 0xc000000d, 1);
    module.threadCallsDisabled = true;
    return result(1, 1);
  },
};
