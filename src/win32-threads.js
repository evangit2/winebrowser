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
// I386_CONTEXT offsets for the registers a thread-context call transfers. The
// layout matches src/seh.js, which documents the same winnt.h fields.
const CONTEXT_I386 = 0x00010000;
const CONTEXT_CONTROL = CONTEXT_I386 | 0x1;
const CONTEXT_INTEGER = CONTEXT_I386 | 0x2;
const CONTEXT_REGISTER_OFFSETS = { Edi: 0x9c, Esi: 0xa0, Ebx: 0xa4, Edx: 0xa8, Ecx: 0xac, Eax: 0xb0 };
const CONTEXT_CONTROL_OFFSETS = { Ebp: 0xb4, Eip: 0xb8, SegCs: 0xbc, EFlags: 0xc0, Esp: 0xc4, SegSs: 0xc8 };

/**
 * Copies the integer and control registers between a guest CONTEXT and the CPU.
 * `store` writes the CONTEXT into the CPU (SetThreadContext); otherwise the CPU
 * state is written into the CONTEXT (GetThreadContext). EIP and ESP belong to
 * the dispatcher, so only the integer registers and EBP travel both ways.
 */
function copyThreadContext(r, pointer, store) {
  if (!r.check(pointer, 0xcc, store)) return false;
  const flags = r.read32(pointer) >>> 0;
  const integer = (flags & 0xffff) === (CONTEXT_INTEGER & 0xffff) || (flags & CONTEXT_INTEGER);
  const control = (flags & 0xffff) === (CONTEXT_CONTROL & 0xffff) || (flags & CONTEXT_CONTROL);
  if (!integer && !control) return false;
  const registers = r.cpu.r;
  const order = [7, 6, 3, 2, 1, 0];
  const names = ['Edi', 'Esi', 'Ebx', 'Edx', 'Ecx', 'Eax'];
  if (integer)
    for (let i = 0; i < order.length; i++) {
      const at = pointer + CONTEXT_REGISTER_OFFSETS[names[i]];
      if (store) registers[order[i]].value = r.read32(at) | 0;
      else r.write32(at, registers[order[i]].value >>> 0);
    }
  if (control) {
    const ebp = pointer + CONTEXT_CONTROL_OFFSETS.Ebp;
    if (store) registers[5].value = r.read32(ebp) | 0;
    else r.write32(ebp, registers[5].value >>> 0);
  }
  return true;
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
  // The virtual machine exposes one logical processor. An affinity report is
  // therefore a single-bit mask, and requesting exactly that mask succeeds;
  // anything else fails with the documented error rather than silently
  // pretending the process moved.
  'kernel32.dll!GetProcessAffinityMask': (r, a) => {
    const processMask = a(1) >>> 0,
      systemMask = a(2) >>> 0;
    if (processMask) r.write32(processMask, 1);
    if (systemMask) r.write32(systemMask, 1);
    return result(1, 3);
  },
  'kernel32.dll!SetProcessAffinityMask': (r, a) => {
    if ((a(1) >>> 0) !== 1) {
      r.lastError = 87; // ERROR_INVALID_PARAMETER
      return result(0, 2);
    }
    return result(1, 2);
  },
  'kernel32.dll!SetThreadAffinityMask': (r, a) => {
    if ((a(1) >>> 0) !== 1) {
      r.lastError = 87;
      return result(0, 2);
    }
    return result(1, 2); // The previous affinity.
  },
  // OpenProcess validates the requested access and hands back a real handle for
  // the current process only. Its rights are recorded so the thread-context
  // calls can check them.
  'kernel32.dll!OpenProcess': (r, a) => {
    const access = a(0) >>> 0,
      inherit = a(1) >>> 0,
      processId = a(2) >>> 0;
    if (inherit || processId !== 1) {
      r.lastError = 87;
      return result(0, 3);
    }
    // Handles are the runtime's own small-integer table, as every other Win32
    // object uses.
    const handle = r.nextHandle++;
    r.handles.set(handle, { type: 'process', processId: 1, access });
    return result(handle, 3);
  },
  // GetThreadContext/SetThreadContext over the current thread's CPU state. Only
  // the control and integer registers are modelled; the caller's ContextFlags
  // decides which of them are read or written.
  'kernel32.dll!GetThreadContext': (r, a) => {
    const handle = a(0) >>> 0,
      context = a(1) >>> 0;
    if (!r.handles.has(handle) || !context) {
      r.lastError = 6;
      return result(0, 2);
    }
    return result(copyThreadContext(r, context, false) ? 1 : 0, 2);
  },
  'kernel32.dll!SetThreadContext': (r, a) => {
    const handle = a(0) >>> 0,
      context = a(1) >>> 0;
    if (!r.handles.has(handle) || !context) {
      r.lastError = 6;
      return result(0, 2);
    }
    return result(copyThreadContext(r, context, true) ? 1 : 0, 2);
  },
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
