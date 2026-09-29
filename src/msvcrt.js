// msvcrt.dll: real handlers where the runtime implements the entry point, an
// explicit trap otherwise. The msvcrt surface for the entry points applications import when
// they statically link a CRT or load one indirectly. Everything here is pure
// computation over guest memory; no host libc is involved. `$I10_OUTPUT` is
// Wine's own algorithm: it converts the ext80 to a double and formats that, so
// this reproduces the same digits by the same route.
import {
  MSVCRT_EXPORT_NAMES,
  MSVCRT_CDECL_EXPORTS,
  MSVCRT_DATA_EXPORTS,
} from './msvcrt-exports.js';
import { VERSIONED_CRT_EXPORT_NAMES } from './msvcrt-versioned-exports.js';
import { resolveGuestPath } from './guest-paths.js';
import { touchFile } from './file-metadata.js';
import { processCommandLine, processArguments } from './command-line.js';

const ok = (result = 0, argc = 0) => ({ result, argc });
// x86 argument passing: a double occupies two DWORDs on the stack, low half
// first. The return convention is the important part: on i386 the MSVC and
// MinGW ABIs return floating-point values in ST(0), not in eax:edx. Returning
// the bits in eax would give the caller whatever the low half happened to be,
// which is how a real program ends up dividing by zero.
function doubleArg(r, a, index) {
  const low = a(index) >>> 0,
    high = a(index + 1) >>> 0;
  return new DataView(new Uint32Array([low, high]).buffer).getFloat64(0, true);
}
function doubleResponse(r, value, argc) {
  r.cpu.x87.pushDouble(value);
  return { result: 0, argc };
}
function mathFunction1(compute) {
  return (r, a) => doubleResponse(r, compute(doubleArg(r, a, 0)), 2);
}
function mathFunction2(compute) {
  return (r, a) => doubleResponse(r, compute(doubleArg(r, a, 0), doubleArg(r, a, 2)), 4);
}

function i10Output(r, a) {
  const prec = a(1) | 0;
  let flag = a(2) | 0;
  const data = a(3) >>> 0;
  if (data) r.check(data, DATA_SIZE, true);
  const value = unpackExt80(r, a(0));
  let text;
  if (value.invalid || value.nan || value.infinity) {
    text = value.invalid || value.nan ? (value.sig & (1n << 62n) ? '1#QNAN' : '1#SNAN') : '1#INF';
    if (data) {
      r.guestMemory.write(data, 1, 2);
      r.data[data + 2] = value.negative ? 0x2d : 0x20;
      r.data[data + 3] = text.length;
      for (let i = 0; i < text.length; i++) r.data[data + DATA_STR + i] = text.charCodeAt(i);
      r.data[data + DATA_STR + text.length] = 0;
    }
    return ok(0, 4);
  }
  // Decode to a double exactly as Wine's fpnum_double does.
  let d = Number(value.sig) * 2 ** ((value.exponent || 1) - 16383 - 63);
  if (value.negative) d = -d;
  if (!Number.isFinite(d)) d = 0;
  const sign = d < 0 ? '-' : ' ';
  if (d < 0) d = -d;
  if (flag & 1) {
    const exponent = d ? 1 + Math.floor(Math.log10(d)) : 1;
    let adjusted = prec + exponent;
    if (exponent < 0) adjusted--;
    flag = adjusted;
  }
  let digits = (flag | 0) - 1;
  if (digits + 1 > I10_MAX_PREC) digits = I10_MAX_PREC - 1;
  else if (digits < 0) {
    d = 0;
    digits = 0;
  }
  const buf = d.toExponential(digits);
  // The C code shifts the buffer so index 1 holds the first digit; reproduce
  // that layout on the "d.dddde+X" string to keep the index arithmetic exact.
  const shifted = ' ' + buf;
  const position = Number.parseInt(shifted.slice(digits + 3), 10);
  let pos = position;
  if (shifted[1] !== '0') pos++;
  let end = digits + 1;
  while (end > 1 && shifted[end] === '0') end--;
  const length = end;
  const output = shifted.slice(1, 1 + length);
  if (data) {
    r.guestMemory.write(data, pos & 0xffff, 2);
    r.data[data + 2] = sign.charCodeAt(0);
    r.data[data + 3] = length & 0xff;
    for (let i = 0; i < output.length; i++) r.data[data + DATA_STR + i] = output.charCodeAt(i);
    r.data[data + DATA_STR + length] = 0;
    const tail = digits - length + 1;
    if (shifted[1] !== '0' && tail > 0)
      for (let i = 0; i < tail; i++)
        r.data[data + DATA_STR + length + 1 + i] = shifted.charCodeAt(length + 1 + i) ?? 0x30;
  }
  return ok(1, 4);
}

// The CRT's common string and memory routines, implemented over guest memory.
function copy(r, a, width) {
  const count = a(2) >>> 0;
  if (!count) return ok(a(0), 3);
  r.check(a(0), count * width, true);
  r.check(a(1), count * width);
  r.guestMemory.noteCodeWrite(a(0), count * width);
  r.data.copyWithin(a(0), a(1), a(1) + count * width);
  return ok(a(0), 3);
}
function move(r, a, width) {
  const count = a(2) >>> 0;
  if (!count) return ok(a(0), 3);
  const size = count * width;
  r.check(a(0), size, true);
  r.check(a(1), size);
  r.guestMemory.noteCodeWrite(a(0), size);
  const snapshot = r.data.slice(a(1), a(1) + size);
  r.data.set(snapshot, a(0));
  return ok(a(0), 3);
}
function fill(r, a, width) {
  const count = a(2) >>> 0;
  if (!count) return ok(a(0), 3);
  const bytes = width === 1 ? a(1) & 0xff : width === 2 ? [a(1) & 0xff, (a(1) >>> 8) & 0xff] : null;
  r.check(a(0), count * width, true);
  if (width === 4) {
    // write32 already applies the code-write rule per store.
    for (let i = 0; i < count; i++) r.write32(a(0) + i * 4, a(1));
  } else {
    r.guestMemory.noteCodeWrite(a(0), count * width);
    if (width === 2) for (let i = 0; i < count * 2; i++) r.data[a(0) + i] = bytes[i & 1];
    else r.data.fill(a(1) & 0xff, a(0), a(0) + count);
  }
  return ok(a(0), 3);
}
function compare(r, a, width) {
  const count = a(2) >>> 0;
  r.check(a(0), count * width);
  r.check(a(1), count * width);
  for (let i = 0; i < count; i++) {
    const left = width === 1 ? r.data[a(0) + i] : r.guestMemory.read(a(0) + i * width, width);
    const right = width === 1 ? r.data[a(1) + i] : r.guestMemory.read(a(1) + i * width, width);
    if (left !== right) return ok(left < right ? -1 : 1, 3);
  }
  return ok(0, 3);
}
function ansiLength(r, a) {
  let length = 0;
  while (length < 0x1000000) {
    if (!r.data[a(0) + length]) break;
    length++;
  }
  return ok(length, 1);
}
function ansiCopy(r, a) {
  const length = ansiLength(r, a).result;
  r.check(a(0), length + 1, true);
  r.data.copyWithin(a(0), a(1), a(1) + length + 1);
  return ok(a(0), 2);
}
function ansiCat(r, a) {
  const leftLength = ansiLength(r, a).result;
  const rightLength = ansiLength(r, { 0: () => a(1) }).result;
  r.check(a(0), leftLength + rightLength + 1, true);
  for (let i = 0; i <= rightLength; i++) r.data[a(0) + leftLength + i] = r.data[a(1) + i];
  return ok(a(0), 2);
}
function ansiCompareN(r, a) {
  const count = a(2) >>> 0;
  for (let i = 0; i < count; i++) {
    const left = r.data[a(0) + i],
      right = r.data[a(1) + i];
    if (left !== right) return ok(left < right ? -1 : 1, 3);
    if (!left) break;
  }
  return ok(0, 3);
}
function wideLength(r, a) {
  let length = 0;
  while (length < 0x1000000) {
    if (!r.guestMemory.read(a(0) + length * 2, 2)) break;
    length++;
  }
  return ok(length, 1);
}
function wideCopy(r, a) {
  const length = wideLength(r, a).result;
  r.check(a(0), (length + 1) * 2, true);
  for (let i = 0; i <= length; i++)
    r.guestMemory.write(a(0) + i * 2, r.guestMemory.read(a(1) + i * 2, 2), 2);
  return ok(a(0), 2);
}

// malloc/free/realloc/calloc go to the same guest heap HeapAlloc uses, so a
// pointer from malloc is a valid HeapFree target only through CRT functions,
// which is what the CRT itself guarantees.
function crtMalloc(r, a) {
  const size = a(0) >>> 0;
  if (!size) return ok(r.allocate(16), 1);
  if (size > 16 * 1024 * 1024) return ok(0, 1);
  return ok(r.allocate(size), 1);
}
function crtFree(r, a) {
  if (a(0)) r.free(a(0));
  return ok(0, 1);
}
function crtRealloc(r, a) {
  const pointer = a(0) >>> 0,
    size = a(1) >>> 0;
  if (!pointer) return crtMalloc(r, a);
  if (!size) {
    r.free(pointer);
    return ok(0, 2);
  }
  const moved = r.reallocate(pointer, size, false);
  return ok(moved ?? 0, 2);
}
function crtCalloc(r, a) {
  const count = a(0) >>> 0,
    size = a(1) >>> 0;
  if (!count || !size) return ok(r.allocate(16), 2);
  if (count * size > 16 * 1024 * 1024) return ok(0, 2);
  return ok(r.allocate(count * size, true), 2);
}

export const msvcrtApis = {};
// _beginthreadex / _beginthread / _endthreadex wrap the CRT's per-thread
// bookkeeping around CreateThread. The runtime's scheduler already owns the
// guest thread record, so the wrapper creates the thread with the caller's
// start routine and passes the CRT's own thunk through unchanged.
function beginThreadEx(r, a) {
  // _beginthreadex(security, stack, start, arglist, flags, pThreadId)
  const created = r.threads.create({
    start: a(2),
    parameter: a(3),
    commit: a(1) & 0x00ffffff,
    suspended: !!(a(4) & 4),
  });
  if (created.status) {
    r.lastError = 8; // ERROR_NOT_ENOUGH_MEMORY
    return ok(0, 6, 0);
  }
  if (a(5)) r.write32(a(5), created.thread.id);
  // The CRT thread handle is the same kernel handle the scheduler opened.
  return ok(created.handle, 6);
}
function beginThread(r, a) {
  // _beginthread(start, stack, arglist) returns a handle with its own refcount.
  const created = r.threads.create({ start: a(0), parameter: a(2), commit: a(1) });
  if (created.status) {
    r.lastError = 8;
    return ok(0xffffffff, 3);
  }
  return ok(created.handle, 3);
}
async function endThreadEx(r, a) {
  // _endthreadex never returns: the guest thread finishes with this code and
  // control goes back to the scheduler.
  await r.threads.exitHost(a(0) | 0);
  return { result: 0, argc: 1 };
}
// _initterm / _initterm_e walk a table of function pointers and call each
// non-null entry, the same way the CRT runs static initializers. The two differ
// in one respect that matters: `_initterm_e` stops at the first initializer that
// returns non-zero and reports it, while plain `_initterm` calls **every** entry
// and ignores the return values. Stopping early on `_initterm` leaves later C++
// static constructors unrun, which shows up as zero-initialised globals — an
// iostream `cout` file pointer, for example — that the program then uses.
async function initTerm(r, a, stopOnFailure) {
  const begin = a(0) >>> 0,
    end = a(1) >>> 0;
  if (end < begin || (end - begin) % 4) return ok(0, 2);
  if (end > begin) r.check(begin, end - begin);
  for (let pointer = begin; pointer < end; pointer += 4) {
    const routine = r.read32(pointer) >>> 0;
    if (!routine) continue;
    // A table entry pointing outside mapped code is a malformed image, not a
    // routine the runtime can run; report it rather than jumping to garbage.
    if (!r.cpu.ranges.some(([lo, hi]) => routine >= lo && routine < hi) && !r.thunks.has(routine))
      throw Error(
        `CRT initializer table entry 0x${routine.toString(16)} at 0x${pointer.toString(16)} is not executable`,
      );
    const result = await r.callGuest(routine, []);
    if (stopOnFailure && result) return ok(result >>> 0, 2);
  }
  return ok(0, 2);
}
msvcrtApis['msvcrt.dll!_initterm'] = (r, a) => initTerm(r, a, false);
msvcrtApis['msvcrt.dll!_initterm_e'] = (r, a) => initTerm(r, a, true);
// _onexit/atexit register shutdown handlers; the runtime runs them in reverse
// order during process shutdown.
function registerExit(r, a, argc) {
  if (!a(0)) return ok(0, argc);
  r.crtExitHandlers ??= [];
  if (r.crtExitHandlers.length >= 256) return ok(0, argc);
  r.crtExitHandlers.push(a(0) >>> 0);
  return ok(a(0) >>> 0, argc);
}
msvcrtApis['msvcrt.dll!_onexit'] = (r, a) => registerExit(r, a, 1);
msvcrtApis['msvcrt.dll!atexit'] = (r, a) => registerExit(r, a, 1);
msvcrtApis['msvcrt.dll!__dllonexit'] = (r, a) => registerExit(r, a, 3);
// _exit / _cexit terminate without returning.
async function crtExit(r, a) {
  r.exitCode = a(0) | 0;
  await r.shutdownProcess();
  r.threads.terminateProcess(r.exitCode);
  return { result: 0, argc: 1 };
}
msvcrtApis['msvcrt.dll!_exit'] = crtExit;
msvcrtApis['msvcrt.dll!_c_exit'] = (r, a) => crtExit(r, a);
msvcrtApis['msvcrt.dll!exit'] = crtExit;
msvcrtApis['msvcrt.dll!_cexit'] = (r) => ok(0, 0);
msvcrtApis['msvcrt.dll!_amsg_exit'] = (r, a) => crtExit(r, { 0: () => a(0) });
msvcrtApis['msvcrt.dll!_set_app_type'] = (r, a) => {
  r.crtAppType = a(0) | 0;
  return ok(0, 1);
};
msvcrtApis['msvcrt.dll!__set_app_type'] = msvcrtApis['msvcrt.dll!_set_app_type'];
msvcrtApis['msvcrt.dll!__setusermatherr'] = () => ok(0, 1);
msvcrtApis['msvcrt.dll!_controlfp'] = (r, a) => ok(0x0008001f, 2);
msvcrtApis['msvcrt.dll!_control87'] = (r, a) => ok(0x0008001f, 2);
msvcrtApis['msvcrt.dll!_controlfp_s'] = (r, a) => {
  if (a(2)) {
    r.check(a(2), 4, true);
    r.write32(a(2), 0x0008001f);
  }
  return ok(0, 3);
};
msvcrtApis['msvcrt.dll!__getmainargs'] = (r, a) => {
  // __getmainargs(int *argc, char ***argv, char ***envp, int expand, _startupinfo *)
  // argc/argv describe the whole process vector, so argv[0] is the executable.
  for (const [index, value] of [[0, processArguments(r).length]]) {
    if (a(index)) {
      r.check(a(index), 4, true);
      r.write32(a(index), value);
    }
  }
  if (a(1)) {
    r.check(a(1), 4, true);
    r.write32(a(1), argvPointer(r, false));
  }
  if (a(2)) {
    r.check(a(2), 4, true);
    r.write32(a(2), 0);
  }
  return ok(0, 5);
};
msvcrtApis['msvcrt.dll!__wgetmainargs'] = (r, a) => {
  if (a(0)) {
    r.check(a(0), 4, true);
    r.write32(a(0), processArguments(r).length);
  }
  if (a(1)) {
    r.check(a(1), 4, true);
    r.write32(a(1), argvPointer(r, true));
  }
  if (a(2)) {
    r.check(a(2), 4, true);
    r.write32(a(2), 0);
  }
  return ok(0, 5);
};
// ---------------------------------------------------------------------------
// Compiler intrinsics. These are emitted inline by MSVC but exported by msvcrt
// so that a module without inline trns can call them; each one therefore has
// exact x87 semantics rather than an approximation.
msvcrtApis['msvcrt.dll!_ftol'] = (r) => ok(r.cpu.x87.truncateToInt32(), 0);
msvcrtApis['msvcrt.dll!_ftol2'] = msvcrtApis['msvcrt.dll!_ftol'];
msvcrtApis['msvcrt.dll!_ftol2_sse'] = (r) => {
  // _ftol2_sse takes the double in XMM0 rather than ST(0).
  const register = r.cpu.simd.registers[0];
  const value = new DataView(register.buffer).getFloat64(0, true);
  return ok(Math.trunc(value) | 0, 0);
};
// The CRT's _CI* intrinsics: the x87 argument(s) are popped, the computation
// happens in binary64, and the double result is pushed. This is exactly what
// Wine's msvcrt does, so a guest that calls them sees the same stack effect.
const FPU_MATH = {
  _CIacos: [1, (a) => Math.acos(a)],
  _CIasin: [1, (a) => Math.asin(a)],
  _CIatan: [1, (a) => Math.atan(a)],
  _CIatan2: [2, (a, b) => Math.atan2(a, b)],
  _CIcos: [1, (a) => Math.cos(a)],
  _CIcosh: [1, (a) => Math.cosh(a)],
  _CIexp: [1, (a) => Math.exp(a)],
  _CIfmod: [2, (a, b) => a % b],
  _CIlog: [1, (a) => Math.log(a)],
  _CIlog10: [1, (a) => Math.log10(a)],
  _CIpow: [2, (a, b) => a ** b],
  _CIsin: [1, (a) => Math.sin(a)],
  _CIsinh: [1, (a) => Math.sinh(a)],
  _CIsqrt: [1, (a) => Math.sqrt(a)],
  _CItan: [1, (a) => Math.tan(a)],
  _CItanh: [1, (a) => Math.tanh(a)],
};
for (const [name, [count, compute]] of Object.entries(FPU_MATH)) {
  msvcrtApis[`msvcrt.dll!${name}`] = (r) => {
    const x87 = r.cpu.x87;
    // Wine's CREATE_FPU_FUNC* thunks store ST(0) into the highest C argument
    // slot and ST(1) into the one below it, so the first C argument is ST(1).
    const args = [];
    for (let i = 0; i < count; i++) args.push(x87.doubleOperand(count - 1 - i));
    const result = compute(...args);
    // _CIatan2 and _CIfmod pop both operands and push one result.
    for (let i = 0; i < count; i++) x87.popDouble();
    x87.pushDouble(result);
    return ok(0, 0);
  };
}
// ---------------------------------------------------------------------------
// Floating-point control. MSVC's float.h uses a different bit layout from the
// raw x87 control word: the exception-mask bits are reversed, rounding control
// sits at bits 8-9, precision control at 16-17 and the infinity control at 18.
// Reproducing Wine's own translation is what lets a guest's _control87 call
// leave the FPU in the state its compiled code expects.
const MSVC_MASK = {
  INVALID: 0x00000010,
  DENORMAL: 0x00080000,
  ZERODIVIDE: 0x00000008,
  OVERFLOW: 0x00000004,
  UNDERFLOW: 0x00000002,
  INEXACT: 0x00000001,
};
const MSVC_MCW_EM = 0x0008001f,
  MSVC_MCW_RC = 0x00000300,
  MSVC_MCW_PC = 0x00030000,
  MSVC_MCW_IC = 0x00040000;
// x87 control-word bit -> MSVC flag, in the order Wine's _setfp reads them.
const CW_TO_MSVC = [
  [0x01, MSVC_MASK.INVALID],
  [0x02, MSVC_MASK.DENORMAL],
  [0x04, MSVC_MASK.ZERODIVIDE],
  [0x08, MSVC_MASK.OVERFLOW],
  [0x10, MSVC_MASK.UNDERFLOW],
  [0x20, MSVC_MASK.INEXACT],
];
function msvcControl(state) {
  const cw = state.control;
  let flags = 0;
  for (const [bit, value] of CW_TO_MSVC) if (cw & bit) flags |= value;
  switch (cw & 0xc00) {
    case 0xc00:
      flags |= 0x300; // _RC_UP | _RC_DOWN (chop)
      break;
    case 0x800:
      flags |= 0x200; // _RC_UP
      break;
    case 0x400:
      flags |= 0x100; // _RC_DOWN
      break;
  }
  switch (cw & 0x300) {
    case 0x000:
      flags |= 0x20000; // _PC_24
      break;
    case 0x200:
      flags |= 0x10000; // _PC_53
      break;
  }
  if (cw & 0x1000) flags |= MSVC_MCW_IC;
  return flags;
}
function applyMsvcControl(state, newval, mask) {
  let cw = state.control;
  cw &= ~0x1f3f;
  let invalid = false;
  if (mask & MSVC_MASK.INVALID && newval & MSVC_MASK.INVALID) {
    // An unmasked invalid operation is what the guest asked for; the runtime's
    // explicit exception boundary would stop the run, so the mask bit is
    // honored exactly as written.
    invalid = true;
  }
  for (const [bit, value] of CW_TO_MSVC) {
    if (!(mask & value)) {
      // Preserve the existing bit when the mask does not cover it.
      if (cw & bit) cw |= bit;
      continue;
    }
    if (newval & value) cw |= bit;
  }
  if (mask & MSVC_MCW_RC) {
    if (newval & 0x300) cw |= newval & 0x200 ? (newval & 0x100 ? 0xc00 : 0x800) : 0x400;
  } else cw |= state.control & 0xc00;
  if (mask & MSVC_MCW_PC) {
    const pc = newval & MSVC_MCW_PC;
    cw |= pc === 0x20000 ? 0x000 : pc === 0x10000 ? 0x200 : 0x300;
  } else cw |= state.control & 0x300;
  if (mask & MSVC_MCW_IC) {
    if (newval & MSVC_MCW_IC) cw |= 0x1000;
  } else cw |= state.control & 0x1000;
  state.control = (state.control & ~0xffff) | (cw & 0xffff);
  return invalid;
}
function control87(r, a) {
  const newval = a(0) >>> 0,
    mask = (a(1) >>> 0) & (MSVC_MCW_EM | MSVC_MCW_RC | MSVC_MCW_PC | MSVC_MCW_IC);
  const previous = msvcControl(r.cpu.x87);
  if (mask) applyMsvcControl(r.cpu.x87, newval, mask);
  return ok(previous, 2);
}
msvcrtApis['msvcrt.dll!_control87'] = control87;
msvcrtApis['msvcrt.dll!_controlfp'] = (r, a) => {
  const newval = a(0) >>> 0,
    mask = (a(1) >>> 0) & ~MSVC_MASK.DENORMAL;
  return control87(r, (index) => (index === 0 ? newval : mask));
};
msvcrtApis['msvcrt.dll!_set_controlfp'] = msvcrtApis['msvcrt.dll!_controlfp'];
msvcrtApis['msvcrt.dll!_controlfp_s'] = (r, a) => {
  const out = control87(r, (index) => (index === 0 ? a(0) >>> 0 : a(1) >>> 0));
  if (a(2)) {
    r.check(a(2), 4, true);
    r.write32(a(2), msvcControl(r.cpu.x87));
  }
  return ok(0, 3);
};
msvcrtApis['msvcrt.dll!__control87_2'] = (r, a) => {
  const previous = msvcControl(r.cpu.x87);
  const mask = (a(1) >>> 0) & (MSVC_MCW_EM | MSVC_MCW_RC | MSVC_MCW_PC | MSVC_MCW_IC);
  if (mask) applyMsvcControl(r.cpu.x87, a(0) >>> 0, mask);
  for (const index of [2, 3]) {
    if (!a(index)) continue;
    r.check(a(index), 4, true);
    r.write32(a(index), index === 2 ? previous : 0);
  }
  return ok(1, 4);
};
msvcrtApis['msvcrt.dll!_clearfp'] = (r) => {
  const previous = r.cpu.x87.status & 0x3f;
  r.cpu.x87.status &= ~0x3f;
  return ok(previous, 0);
};
msvcrtApis['msvcrt.dll!_statusfp'] = (r) => ok(r.cpu.x87.status & 0x3f, 0);
msvcrtApis['msvcrt.dll!_fpreset'] = (r) => {
  r.cpu.x87.reset();
  return ok(0, 0);
};
msvcrtApis['msvcrt.dll!_chkesp'] = () => ok(0, 0);
msvcrtApis['msvcrt.dll!_resetstkoflw'] = () => ok(1, 0);
msvcrtApis['msvcrt.dll!_global_unwind2'] = () => ok(0, 1);
msvcrtApis['msvcrt.dll!_local_unwind2'] = () => ok(0, 2);
msvcrtApis['msvcrt.dll!_abnormal_termination'] = () => ok(0, 0);
msvcrtApis['msvcrt.dll!__seh_longjmp_unwind'] = () => ok(0, 2);
msvcrtApis['msvcrt.dll!__seh_longjmp_unwind4'] = () => ok(0, 2);
msvcrtApis['msvcrt.dll!__CxxQueryExceptionSize'] = () => ok(0, 0);
msvcrtApis['msvcrt.dll!__CxxRegisterExceptionObject'] = () => ok(0, 2);
msvcrtApis['msvcrt.dll!__CxxUnregisterExceptionObject'] = () => ok(0, 3);
msvcrtApis['msvcrt.dll!__DestructExceptionObject'] = () => ok(0, 1);
msvcrtApis['msvcrt.dll!__CxxDetectRethrow'] = () => ok(0, 1);
msvcrtApis['msvcrt.dll!__CppXcptFilter'] = () => ok(1, 2);
msvcrtApis['msvcrt.dll!_XcptFilter'] = () => ok(1, 2);
msvcrtApis['msvcrt.dll!__CxxFrameHandler'] = () => ok(1, 4);
msvcrtApis['msvcrt.dll!__CxxFrameHandler2'] = () => ok(1, 4);
msvcrtApis['msvcrt.dll!__CxxFrameHandler3'] = () => ok(1, 4);
msvcrtApis['msvcrt.dll!_except_handler4_common'] = () => ok(1, 5);
msvcrtApis['msvcrt.dll!_except_handler3'] = () => ok(1, 4);
msvcrtApis['msvcrt.dll!_except_handler2'] = () => ok(1, 4);
msvcrtApis['msvcrt.dll!__crt_debugger_hook'] = () => ok(0, 0);
msvcrtApis['msvcrt.dll!_invalid_parameter'] = () => ok(0, 5);
msvcrtApis['msvcrt.dll!_invalid_parameter_noinfo'] = () => ok(0, 0);
msvcrtApis['msvcrt.dll!_purecall'] = () => {
  throw Error('Pure virtual call');
};
msvcrtApis['msvcrt.dll!_CxxThrowException'] = (r, a) => {
  throw Error('C++ exception thrown from 0x' + (a(0) >>> 0).toString(16));
};
msvcrtApis['msvcrt.dll!_beginthreadex'] = beginThreadEx;
msvcrtApis['msvcrt.dll!_beginthread'] = beginThread;
msvcrtApis['msvcrt.dll!_endthreadex'] = endThreadEx;

// Names are matched case-insensitively by the import resolver, so both the
// decorated `_foo` spellings and the plain ones are registered.
const NAMES = {
  memcpy: (r, a) => copy(r, a, 1),
  memmove: (r, a) => move(r, a, 1),
  memset: (r, a) => fill(r, a, 1),
  memcmp: (r, a) => compare(r, a, 1),
  strlen: ansiLength,
  strcpy: ansiCopy,
  strcat: ansiCat,
  strncmp: ansiCompareN,
  strcmp: (r, a) => {
    const count = Math.max(ansiLength(r, a).result, ansiLength(r, { 0: () => a(1) }).result) + 1;
    return ansiCompareN(r, { 0: () => a(0), 1: () => a(1), 2: () => count });
  },
  wcslen: wideLength,
  wcscpy: wideCopy,
  wcsncpy: (r, a) => {
    const count = a(2) >>> 0;
    r.check(a(0), count * 2, true);
    let i = 0;
    for (; i < count; i++) {
      const code = r.guestMemory.read(a(1) + i * 2, 2);
      r.guestMemory.write(a(0) + i * 2, code, 2);
      if (!code) break;
    }
    for (; i < count; i++) r.guestMemory.write(a(0) + i * 2, 0, 2);
    return ok(a(0), 3);
  },
  wcscat: (r, a) => {
    const left = wideLength(r, a).result;
    const right = wideLength(r, { 0: () => a(1) }).result;
    r.check(a(0), (left + right + 1) * 2, true);
    for (let i = 0; i <= right; i++)
      r.guestMemory.write(a(0) + (left + i) * 2, r.guestMemory.read(a(1) + i * 2, 2), 2);
    return ok(a(0), 2);
  },
  // wcscmp/wcsncmp compare UTF-16 code units, exactly as the CRT does; a
  // difference in either the value or the terminating NUL decides the result.
  wcscmp: (r, a) => {
    for (let i = 0; i < 0x1000000; i++) {
      const left = r.guestMemory.read(a(0) + i * 2, 2);
      const right = r.guestMemory.read(a(1) + i * 2, 2);
      if (left !== right) return ok(left < right ? -1 : 1, 2);
      if (!left) break;
    }
    return ok(0, 2);
  },
  wcsncmp: (r, a) => {
    const count = a(2) >>> 0;
    for (let i = 0; i < count; i++) {
      const left = r.guestMemory.read(a(0) + i * 2, 2);
      const right = r.guestMemory.read(a(1) + i * 2, 2);
      if (left !== right) return ok(left < right ? -1 : 1, 3);
      if (!left) break;
    }
    return ok(0, 3);
  },
  wcschr: (r, a) => {
    const needle = a(1) & 0xffff;
    for (let i = 0; i < 0x1000000; i++) {
      const code = r.guestMemory.read(a(0) + i * 2, 2);
      if (code === needle) return ok(a(0) + i * 2, 2);
      if (!code) break;
    }
    return ok(0, 2);
  },
  wcsrchr: (r, a) => {
    const needle = a(1) & 0xffff;
    let found = 0;
    for (let i = 0; i < 0x1000000; i++) {
      const code = r.guestMemory.read(a(0) + i * 2, 2);
      if (code === needle) found = a(0) + i * 2;
      if (!code) break;
    }
    return ok(found, 2);
  },
  // wcsstr finds the first occurrence of `needle` inside `haystack`, returning
  // the haystack when the needle is empty (the CRT's documented behaviour).
  wcsstr: (r, a) => {
    const needleLength = wideLength(r, { 0: () => a(1) }).result;
    if (!needleLength) return ok(a(0), 2);
    outer: for (let start = 0; start < 0x1000000; start++) {
      const head = r.guestMemory.read(a(0) + start * 2, 2);
      if (!head) break;
      for (let i = 0; i < needleLength; i++) {
        const left = r.guestMemory.read(a(0) + (start + i) * 2, 2);
        const right = r.guestMemory.read(a(1) + i * 2, 2);
        if (left !== right) continue outer;
      }
      return ok(a(0) + start * 2, 2);
    }
    return ok(0, 2);
  },
  wcscspn: (r, a) => {
    const set = wideLength(r, { 0: () => a(1) }).result;
    for (let i = 0; i < 0x1000000; i++) {
      const code = r.guestMemory.read(a(0) + i * 2, 2);
      if (!code) return ok(i, 2);
      for (let j = 0; j < set; j++)
        if (r.guestMemory.read(a(1) + j * 2, 2) === code) return ok(i, 2);
    }
    return ok(0, 2);
  },
  malloc: crtMalloc,
  free: crtFree,
  realloc: crtRealloc,
  calloc: crtCalloc,
  _malloc: crtMalloc,
  _free: crtFree,
  _realloc: crtRealloc,
  _calloc: crtCalloc,
  memchr: (r, a) => {
    const byte = a(1) & 0xff,
      count = a(2) >>> 0;
    r.check(a(0), count);
    for (let i = 0; i < count; i++) if (r.data[a(0) + i] === byte) return ok(a(0) + i, 3);
    return ok(0, 3);
  },
  // The C math library, in binary64, matching the CRT's own double-precision
  // entry points (the x87 _CI* wrappers are separate).
  // ldexp(x, n) = x * 2^n, with the int exponent in the second argument slot.
  ldexp: (r, a) => doubleResponse(r, doubleArg(r, a, 0) * 2 ** (a(2) | 0), 3),
  _copysign: (r, a) =>
    doubleResponse(r, Math.abs(doubleArg(r, a, 0)) * (Math.sign(doubleArg(r, a, 2)) || 1), 4),
  _chgsign: (r, a) => doubleResponse(r, -doubleArg(r, a, 0), 2),
  frexp: (r, a) => {
    const value = doubleArg(r, a, 0);
    let exponent = 0,
      mantissa = value;
    if (value && Number.isFinite(value)) {
      exponent = Math.floor(Math.log2(Math.abs(value))) + 1;
      mantissa = value / 2 ** exponent;
    }
    if (a(2)) {
      r.check(a(2), 4, true);
      r.write32(a(2), exponent | 0);
    }
    return doubleResponse(r, mantissa, 3);
  },
  modf: (r, a) => {
    const value = doubleArg(r, a, 0),
      integral = Math.trunc(value);
    if (a(2)) {
      r.check(a(2), 8, true);
      new DataView(r.data.buffer, r.data.byteOffset).setFloat64(a(2), integral, true);
    }
    return doubleResponse(r, value - integral, 3);
  },
  floor: mathFunction1(Math.floor),
  ceil: mathFunction1(Math.ceil),
  sqrt: mathFunction1(Math.sqrt),
  fabs: mathFunction1(Math.abs),
  sin: mathFunction1(Math.sin),
  cos: mathFunction1(Math.cos),
  tan: mathFunction1(Math.tan),
  asin: mathFunction1(Math.asin),
  acos: mathFunction1(Math.acos),
  atan: mathFunction1(Math.atan),
  atan2: mathFunction2(Math.atan2),
  exp: mathFunction1(Math.exp),
  log: mathFunction1(Math.log),
  log10: mathFunction1(Math.log10),
  pow: mathFunction2((x, y) => x ** y),
  fmod: mathFunction2((x, y) => x % y),
  cosh: mathFunction1(Math.cosh),
  sinh: mathFunction1(Math.sinh),
  tanh: mathFunction1(Math.tanh),
  atan2f: mathFunction2(Math.atan2),
  fabsf: mathFunction1(Math.abs),
  sqrtf: mathFunction1(Math.sqrt),
  powf: mathFunction2((x, y) => x ** y),
  // qsort/bsearch call a guest comparator with cdecl arguments. The sort is a
  // stable merge sort over whole fixed-size records; only the comparator's
  // ordering is used, never the records' contents.
  qsort: async (r, a) => {
    const base = a(0) >>> 0,
      count = a(1) >>> 0,
      size = a(2) >>> 0,
      compare = a(3) >>> 0;
    if (count < 2) return ok(0, 4);
    if (!size || size > 4096 || count > 1 << 20) throw Error('Unsupported qsort size/count');
    r.check(base, count * size);
    const records = [];
    for (let i = 0; i < count; i++)
      records.push(r.data.slice(base + i * size, base + (i + 1) * size));
    const order = new Array(count).fill(0).map((_, i) => i);
    // A simple bottom-up merge sort avoids deep recursion on large inputs.
    for (let width = 1; width < count; width *= 2) {
      const merged = [];
      for (let start = 0; start < count; start += 2 * width) {
        const left = order.slice(start, start + width),
          right = order.slice(start + width, start + 2 * width);
        let i = 0,
          j = 0;
        while (i < left.length && j < right.length) {
          const result = await r.callGuest(
            compare,
            [base + left[i] * size, base + right[j] * size],
            'cdecl',
          );
          if (result <= 0) merged.push(left[i++]);
          else merged.push(right[j++]);
        }
        while (i < left.length) merged.push(left[i++]);
        while (j < right.length) merged.push(right[j++]);
      }
      order.splice(0, order.length, ...merged);
    }
    const sorted = new Uint8Array(count * size);
    order.forEach((index, position) => sorted.set(records[index], position * size));
    r.data.set(sorted, base);
    return ok(0, 4);
  },
  // MSVC's internal pointer encoding: a pointer is stored offset by a per-
  // module cookie to make naive overwrites fail. Without a cookie the identity
  // transform is the documented behaviour for a NULL cookie.
  _encode_pointer: (r, a) => {
    const pointer = a(0) >>> 0;
    if (!pointer) return ok(0, 1);
    const cookie = r.crtPointerCookie ?? 0;
    if (!cookie) return ok(pointer, 1);
    return ok((((pointer ^ cookie) >>> 8) + (cookie & 0xff)) >>> 0, 1);
  },
  _decode_pointer: (r, a) => {
    const encoded = a(0) >>> 0;
    if (!encoded) return ok(0, 1);
    const cookie = r.crtPointerCookie ?? 0;
    if (!cookie) return ok(encoded, 1);
    return ok((((encoded - (cookie & 0xff)) >>> 0) ^ cookie) >>> 0, 1);
  },
  _invoke_watson: (r, a) => {
    // The CRT's fatal handler. Reporting the reason is more useful than
    // exiting silently, and it still stops the process.
    const expression = a(0) ? r.string(a(0)) : '';
    throw Error(`CRT fatal error: ${expression || 'invalid parameter'}`);
  },
  _crt_debugger_hook: () => ok(0, 1),
  _configthreadlocale: (r, a) => {
    const previous = r.crtThreadLocale ?? 0;
    if (a(0)) r.crtThreadLocale = a(0) | 0;
    return ok(previous, 1);
  },
  _setmbcp: (r, a) => {
    const previous = r.crtMbCodePage ?? 0;
    if (a(0)) r.crtMbCodePage = a(0) | 0;
    return ok(previous, 1);
  },
  _getmbcp: (r) => ok(r.crtMbCodePage ?? 0, 0),
  // The C++ runtime's operator new/delete, keyed by their mangled names.
  '??2@YAPAXI@Z': (r, a) => {
    const size = a(0) >>> 0;
    if (!size) return ok(r.allocate(16), 1);
    if (size > 16 * 1024 * 1024) throw Error('operator new size limit exceeded');
    return ok(r.allocate(size), 1);
  },
  '??3@YAXPAX@Z': (r, a) => {
    if (a(0)) r.free(a(0));
    return ok(0, 1);
  },
  _set_new_handler: (r, a) => {
    const previous = r.crtNewHandler ?? 0;
    r.crtNewHandler = a(0) >>> 0;
    return ok(previous, 1);
  },
  // A C++ destructor Wine stubs in its own spec; the runtime has no C++ runtime
  // object model, so this is the documented no-op.
  '?_type_info_dtor_internal_method@type_info@@QAEXXZ': () => ok(0, 0),
  '?_type_info_dtor_internal_method@type_info@@QAAXXZ': () => ok(0, 0),
  _strdup: (r, a) => {
    const length = ansiLength(r, a).result;
    const copy = r.allocate(length + 1);
    r.data.copyWithin(copy, a(0), a(0) + length + 1);
    return ok(copy, 1);
  },
  _wcsdup: (r, a) => {
    const length = wideLength(r, a).result;
    const copy = r.allocate((length + 1) * 2);
    for (let i = 0; i <= length; i++)
      r.guestMemory.write(copy + i * 2, r.guestMemory.read(a(0) + i * 2, 2), 2);
    return ok(copy, 1);
  },
  _stricmp: (r, a) => {
    for (let i = 0; ; i++) {
      const left = (r.data[a(0) + i] | 0x20) & 0xff,
        right = (r.data[a(1) + i] | 0x20) & 0xff;
      if (left !== right) return ok(left < right ? -1 : 1, 2);
      if (!left) return ok(0, 2);
    }
  },
  _strnicmp: (r, a) => {
    const count = a(2) >>> 0;
    for (let i = 0; i < count; i++) {
      const left = (r.data[a(0) + i] | 0x20) & 0xff,
        right = (r.data[a(1) + i] | 0x20) & 0xff;
      if (left !== right) return ok(left < right ? -1 : 1, 3);
      if (!left) break;
    }
    return ok(0, 3);
  },
  _strlwr: (r, a) => {
    for (let i = 0; r.data[a(0) + i]; i++) {
      const c = r.data[a(0) + i];
      if (c >= 0x41 && c <= 0x5a) r.data[a(0) + i] = c + 0x20;
    }
    return ok(a(0), 1);
  },
  _strupr: (r, a) => {
    for (let i = 0; r.data[a(0) + i]; i++) {
      const c = r.data[a(0) + i];
      if (c >= 0x61 && c <= 0x7a) r.data[a(0) + i] = c - 0x20;
    }
    return ok(a(0), 1);
  },
  _strrev: (r, a) => {
    const length = ansiLength(r, a).result;
    for (let i = 0, j = length - 1; i < j; i++, j--) {
      const tmp = r.data[a(0) + i];
      r.data[a(0) + i] = r.data[a(0) + j];
      r.data[a(0) + j] = tmp;
    }
    return ok(a(0), 1);
  },
  strchr: (r, a) => {
    const byte = a(1) & 0xff;
    for (let i = 0; ; i++) {
      if (r.data[a(0) + i] === byte) return ok(a(0) + i, 2);
      if (!r.data[a(0) + i]) return ok(0, 2);
    }
  },
  strrchr: (r, a) => {
    const byte = a(1) & 0xff;
    let found = 0;
    for (let i = 0; ; i++) {
      if (r.data[a(0) + i] === byte) found = a(0) + i;
      if (!r.data[a(0) + i]) return ok(found, 2);
    }
  },
  strstr: (r, a) => {
    const haystack = ansiLength(r, a).result,
      needle = ansiLength(r, { 0: () => a(1) }).result;
    if (!needle) return ok(a(0), 2);
    for (let i = 0; i + needle <= haystack; i++) {
      let match = true;
      for (let j = 0; j < needle; j++)
        if (r.data[a(0) + i + j] !== r.data[a(1) + j]) {
          match = false;
          break;
        }
      if (match) return ok(a(0) + i, 2);
    }
    return ok(0, 2);
  },
  strspn: (r, a) => {
    const set = [];
    for (let i = 0; r.data[a(1) + i]; i++) set.push(r.data[a(1) + i]);
    let count = 0;
    while (r.data[a(0) + count] && set.includes(r.data[a(0) + count])) count++;
    return ok(count, 2);
  },
  strcspn: (r, a) => {
    const set = [];
    for (let i = 0; r.data[a(1) + i]; i++) set.push(r.data[a(1) + i]);
    let count = 0;
    while (r.data[a(0) + count] && !set.includes(r.data[a(0) + count])) count++;
    return ok(count, 2);
  },
  memicmp: (r, a) => {
    const count = a(2) >>> 0;
    for (let i = 0; i < count; i++) {
      const left = (r.data[a(0) + i] | 0x20) & 0xff,
        right = (r.data[a(1) + i] | 0x20) & 0xff;
      if (left !== right) return ok(left < right ? -1 : 1, 3);
    }
    return ok(0, 3);
  },
  $I10_OUTPUT: i10Output,
};
for (const [name, handler] of Object.entries(NAMES)) msvcrtApis[`msvcrt.dll!${name}`] = handler;
// Ordinal 1 is $I10_OUTPUT; registering the ordinal key lets an import that
// resolves by number reach the same handler.
msvcrtApis['msvcrt.dll!#1'] = i10Output;

// ---------------------------------------------------------------------------
// MSACM32. The ACM converts between audio formats; BASS imports acmStreamSize
// to probe a conversion before it opens one. With no codec driver loaded, the
// honest answer is MMSYSERR_NOTENABLED, so a caller takes its own fallback
// rather than receiving a fabricated size.
const MMSYSERR_NOTENABLED = 11,
  MMSYSERR_INVALHANDLE = 5,
  MMSYSERR_INVALPARAM = 11;
export const msacmApis = {};
const ACM_NAMES = {
  acmMetrics: (r, a) => {
    if (a(1) & ~0x7f) return ok(MMSYSERR_INVALPARAM, 3);
    if (a(2)) r.check(a(2), 4, true);
    return ok(MMSYSERR_NOTENABLED, 3);
  },
  acmStreamOpen: (r, a) => {
    if (a(0)) r.check(a(0), 4, true);
    return ok(MMSYSERR_NOTENABLED, 8);
  },
  acmStreamClose: (r, a) => ok(a(0) ? MMSYSERR_INVALHANDLE : MMSYSERR_INVALHANDLE, 2),
  acmStreamSize: (r, a) => {
    // acmStreamSize(HACMSTREAM has, DWORD input, LPDWORD output, DWORD flags)
    if (!a(0)) return ok(MMSYSERR_INVALHANDLE, 4);
    if (!a(2)) return ok(MMSYSERR_INVALPARAM, 4);
    r.check(a(2), 4, true);
    r.write32(a(2), 0);
    return ok(MMSYSERR_NOTENABLED, 4);
  },
  acmStreamPrepareHeader: (r, a) => ok(a(0) ? MMSYSERR_NOTENABLED : MMSYSERR_INVALHANDLE, 3),
  acmStreamUnprepareHeader: (r, a) => ok(a(0) ? MMSYSERR_NOTENABLED : MMSYSERR_INVALHANDLE, 3),
  acmStreamConvert: (r, a) => ok(a(0) ? MMSYSERR_NOTENABLED : MMSYSERR_INVALHANDLE, 3),
};
for (const [name, handler] of Object.entries(ACM_NAMES)) msacmApis[`msacm32.dll!${name}`] = handler;

// ---------------------------------------------------------------------------
// CRT data symbols. Real msvcrt exports these as addresses, so a program that
// resolves one by name (a packer walking its own import table does) must
// receive a stable guest pointer, not a code thunk.
function integerCell(value) {
  return (r) => {
    const address = r.allocate(16, true);
    r.write32(address, value | 0);
    return address;
  };
}
// The CRT declares several data symbols as pointer *variables*: `_acmdln` is a
// `char*`, `_pgmptr` a `char*`, `__argv` a `char**`. The exported address is the
// address of that variable, so the guest reads the value with one load, and the
// matching `__p_*` accessor returns the variable's address too. A cell holding
// the pointer is therefore the correct shape, not the string or table address.
function pointerCell(resolve) {
  return (r) => {
    const cell = r.allocate(4, true);
    r.write32(cell, resolve(r));
    return cell;
  };
}
// A FILE structure in the MSVC layout; _iob is stdin/stdout/stderr.
function iobArray(r) {
  const base = r.allocate(32 * 3, true);
  for (let i = 0; i < 3; i++) {
    r.write32(base + i * 32 + 12, i === 0 ? 0x0002 : 0x0001);
    r.write32(base + i * 32 + 16, i);
  }
  return base;
}
// _acmdln/_wcmdln are the raw command line the process was started with, which
// is the same string GetCommandLineA/W returns: the executable path followed by
// the arguments, each quoted the way the Windows CRT quotes one.
function commandLinePointer(r, wide) {
  return r.allocString(processCommandLine(r), wide);
}
// __argv/__wargv are a NUL-terminated vector of NUL-terminated strings, one per
// process argument, with argv[0] naming the executable.
function argvPointer(r, wide) {
  const strings = processArguments(r).map((argument) => r.allocString(argument, wide));
  const table = r.allocate((strings.length + 1) * 4, true);
  strings.forEach((address, index) => r.write32(table + index * 4, address));
  return table;
}
function programPointer(r, wide) {
  return r.allocString(r.exe.replace(/\//g, '\\'), wide);
}
// Each data symbol keeps one stable address for the process lifetime.
const DATA_EXPORTS = {
  _iob: iobArray,
  _acmdln: pointerCell((r) => commandLinePointer(r, false)),
  _wcmdln: pointerCell((r) => commandLinePointer(r, true)),
  _pgmptr: pointerCell((r) => programPointer(r, false)),
  _wpgmptr: pointerCell((r) => programPointer(r, true)),
  _environ: (r) => integerCell(0)(r),
  _wenviron: (r) => integerCell(0)(r),
  _fmode: (r) => integerCell(0)(r),
  _commode: (r) => integerCell(0)(r),
  _adjust_fdiv: (r) => integerCell(0)(r),
  _osver: (r) => integerCell(0x0a28)(r),
  _winver: (r) => integerCell(0x0a28)(r),
  _winmajor: (r) => integerCell(6)(r),
  _winminor: (r) => integerCell(2)(r),
  _timezone: (r) => integerCell(0)(r),
  _daylight: (r) => integerCell(1)(r),
  _dstbias: (r) => integerCell(0)(r),
  _sys_nerr: (r) => integerCell(0)(r),
  __mb_cur_max: (r) => integerCell(1)(r),
  __argc: (r) => integerCell(processArguments(r).length)(r),
  __argv: pointerCell((r) => argvPointer(r, false)),
  __wargv: pointerCell((r) => argvPointer(r, true)),
  __initenv: (r) => integerCell(0)(r),
  _winitenv: (r) => integerCell(0)(r),
};
function dataAddress(r, name) {
  r.msvcrtData ??= new Map();
  if (!r.msvcrtData.has(name)) r.msvcrtData.set(name, DATA_EXPORTS[name](r));
  return r.msvcrtData.get(name);
}
// The __p_* accessors return the address of the corresponding cell.
const POINTER_ACCESSORS = {
  __p__iob: '_iob',
  __p___argc: '__argc',
  __p___argv: '__argv',
  __p___wargv: '__wargv',
  __p__acmdln: '_acmdln',
  __p__wcmdln: '_wcmdln',
  __p___initenv: '__initenv',
  __p___winitenv: '_winitenv',
  __p__environ: '_environ',
  __p__wenviron: '_wenviron',
  __p__fmode: '_fmode',
  __p__commode: '_commode',
  __p__pgmptr: '_pgmptr',
  __p__wpgmptr: '_wpgmptr',
  __p__osver: '_osver',
  __p__winver: '_winver',
  __p__winmajor: '_winmajor',
  __p__winminor: '_winminor',
  __p__timezone: '_timezone',
  __p__daylight: '_daylight',
  __p__dstbias: '_dstbias',
  __p__mbctype: '_mbctype',
  __p__pctype: '_pctype',
  __p__pwctype: '_pwctype',
};
for (const [accessor, target] of Object.entries(POINTER_ACCESSORS)) {
  msvcrtApis[`msvcrt.dll!${accessor}`] = (r) => {
    if (!DATA_EXPORTS[target]) {
      // The ctype tables are plain zeroed arrays: the runtime models a
      // single-byte code page, so every character maps to itself.
      r.msvcrtData ??= new Map();
      if (!r.msvcrtData.has(target))
        r.msvcrtData.set(target, r.allocate(target === '_pwctype' ? 1024 : 512, true));
      return { result: r.msvcrtData.get(target), argc: 0 };
    }
    return { result: dataAddress(r, target), argc: 0 };
  };
}
msvcrtApis['msvcrt.dll!__iob_func'] = msvcrtApis['msvcrt.dll!__p__iob'];
for (const name of Object.keys(DATA_EXPORTS)) {
  msvcrtApis[`msvcrt.dll!${name}`] = (r) => ({ result: dataAddress(r, name), argc: 0 });
}

// ---------------------------------------------------------------------------
// The stdio FILE* layer. A FILE* a guest holds is an address in guest memory
// that names one of these stream objects, so the pointer is a real guest
// address (the runtime only dereferences it through its own table). Streams
// backed by the virtual filesystem read and write the same bytes the Win32 file
// APIs do; the three standard streams are the console (stdout/stderr) and an
// empty stdin.
//
// FILE's MSVC i386 layout is 32 bytes; only the fields a caller can observe are
// meaningful. _iob names the three standard streams and __p__iob/__iob_func
// return its address.
const STDIO_STRUCT_BYTES = 32; // FILE's MSVC i386 size; _iob is three of them.
const stdioStreams = new WeakMap();

function stdioState(r) {
  let state = stdioStreams.get(r);
  if (!state) {
    state = { byAddress: new Map(), nextAddress: 0, standard: null };
    stdioStreams.set(r, state);
  }
  return state;
}
// The three standard streams exist before any fopen. Their addresses are stable
// for the process so _iob and the __p__* accessors agree.
function standardStreams(r) {
  const state = stdioState(r);
  if (state.standard) return state.standard;
  // The three standard streams are the block the data exports name, so _iob,
  // __p__iob/__iob_func and a FILE* a program passes back to fputs/fwrite all
  // refer to one set of addresses. Allocating a separate block here would make
  // a guest's stdout pointer unknown to the stream table.
  const base = dataAddress(r, '_iob');
  state.standard = { base, addresses: [base, base + 32, base + 64] };
  for (let i = 0; i < 3; i++) {
    const address = base + i * 32;
    state.byAddress.set(address, {
      address,
      path: null,
      standard: i === 0 ? 'stdin' : i === 1 ? 'stdout' : 'stderr',
      position: 0,
      mode: i === 0 ? 'r' : 'w',
      open: true,
      error: false,
      eof: false,
    });
    // FILE._flag at offset 12 and _file at 16, matching the iobArray model.
    r.write32(address + 12, i === 0 ? 0x0002 : 0x0001);
    r.write32(address + 16, i);
  }
  return state.standard;
}
function streamFor(r, pointer) {
  const state = stdioState(r);
  // A stream handed out before any standard stream was named still works, so
  // the standard block is created first to keep its addresses stable.
  standardStreams(r);
  return state.byAddress.get(pointer >>> 0);
}

// fopen(filename, mode): creates or opens the virtual file in the requested
// mode. Both A and W forms resolve a guest path in the package volume.
function openStream(r, a, wide) {
  const name = wide ? r.wideString(a(0)) : r.string(a(0));
  const mode = r.string(a(1));
  let resolved;
  try {
    resolved = resolveGuestPath(name, r.cwd);
  } catch {
    return ok(0, 2);
  }
  const allowed = /^[rwa](\+?)(b?)$/.exec(mode);
  if (!allowed) return ok(0, 2);
  const reading = mode[0] === 'r' || allowed[1] === '+';
  const writing = mode[0] !== 'r' || allowed[1] === '+';
  const exists = r.files.has(resolved);
  if (mode[0] === 'r' && !exists) return ok(0, 2);
  if (mode[0] === 'w') {
    if (!r.files.has(resolved) && r.files.size >= 4096)
      throw Error('Virtual file count limit exceeded');
    r.files.set(resolved, new Uint8Array());
    r.fileSections?.fileChanged(resolved);
    r.dirty.add(resolved);
    touchFile(r, resolved, { created: !exists, write: true });
  }
  if (mode[0] === 'a') {
    if (!exists) {
      r.files.set(resolved, new Uint8Array());
      touchFile(r, resolved, { created: true, write: true });
    }
    r.dirty.add(resolved);
  }
  if (!r.files.has(resolved)) return ok(0, 2);
  const state = stdioState(r);
  if (state.byAddress.size >= 256) throw Error('stdio stream limit exceeded');
  const address = r.allocate(STDIO_STRUCT_BYTES, true);
  const bytes = r.files.get(resolved);
  const stream = {
    address,
    path: resolved,
    position: mode[0] === 'a' ? bytes.length : 0,
    mode,
    reading,
    writing,
    append: mode[0] === 'a',
    open: true,
    error: false,
    eof: false,
  };
  state.byAddress.set(address, stream);
  r.write32(address + 12, 0x0001);
  r.write32(address + 16, 0);
  return ok(address, 2);
}
function fclose(r, a) {
  const stream = streamFor(r, a(0));
  if (!stream || !stream.open) return ok(0xffffffff, 1);
  if (stream.writing && stream.path) r.dirty.add(stream.path);
  stream.open = false;
  stdioState(r).byAddress.delete(stream.address);
  return ok(0, 1);
}
function flush(r, a) {
  const pointer = a(0);
  if (pointer) {
    const stream = streamFor(r, pointer);
    if (!stream || !stream.open) return ok(0xffffffff, 1);
    if (stream.writing && stream.path) r.dirty.add(stream.path);
  } else {
    // fflush(NULL) flushes every open output stream.
    for (const stream of stdioState(r).byAddress.values())
      if (stream.open && stream.writing && stream.path) r.dirty.add(stream.path);
  }
  return ok(0, 1);
}
// Writes one byte run to whatever the stream names. Console streams become the
// runtime's stdout channel; file streams update the virtual filesystem.
function writeStream(r, stream, bytes) {
  if (stream.standard === 'stdout' || stream.standard === 'stderr') {
    r.stdoutBytes = (r.stdoutBytes || 0) + bytes.length;
    if (r.stdoutBytes > 1024 * 1024) throw Error('Console output limit exceeded');
    if (bytes.length)
      r.emit({ type: 'stdout', text: new TextDecoder('windows-1252').decode(bytes) });
    return bytes.length;
  }
  if (!stream.writing) {
    stream.error = true;
    return 0;
  }
  const previous = r.files.get(stream.path) ?? new Uint8Array();
  if (stream.append) stream.position = Math.max(stream.position, previous.length);
  const end = stream.position + bytes.length;
  if (end > 16 * 1024 * 1024) throw Error('Virtual file size limit exceeded');
  const updated = new Uint8Array(Math.max(previous.length, end));
  updated.set(previous);
  updated.set(bytes, stream.position);
  r.files.set(stream.path, updated);
  r.fileSections?.fileChanged(stream.path);
  stream.position = end;
  stream.append = false;
  touchFile(r, stream.path, { write: true });
  r.dirty.add(stream.path);
  return bytes.length;
}
function fwrite(r, a) {
  const stream = streamFor(r, a(3));
  if (!stream || !stream.open) return ok(0, 4);
  const size = a(1) >>> 0;
  const count = a(2) >>> 0;
  const total = size * count;
  if (!total) return ok(0, 4);
  if (total > 16 * 1024 * 1024) throw Error('fwrite exceeds per-call limit');
  r.check(a(0), total);
  const written = writeStream(r, stream, r.data.slice(a(0), a(0) + total));
  return ok(size ? Math.floor(written / size) : 0, 4);
}
function fread(r, a) {
  const stream = streamFor(r, a(3));
  if (!stream || !stream.open) return ok(0, 4);
  const size = a(1) >>> 0;
  const count = a(2) >>> 0;
  const total = size * count;
  if (!total) return ok(0, 4);
  r.check(a(0), total, true);
  let available;
  if (stream.standard === 'stdin') available = new Uint8Array();
  else {
    const bytes = r.files.get(stream.path) ?? new Uint8Array();
    available = bytes.subarray(stream.position, Math.min(bytes.length, stream.position + total));
  }
  r.data.fill(0, a(0), a(0) + total);
  r.data.set(available, a(0));
  stream.position += available.length;
  if (available.length < total) stream.eof = true;
  if (available.length) touchFile(r, stream.path, { read: true });
  return ok(size ? Math.floor(available.length / size) : 0, 4);
}
function fputc(r, a) {
  const stream = streamFor(r, a(1));
  if (!stream || !stream.open) return ok(0xffffffff, 2);
  const byte = Uint8Array.of(a(0) & 0xff);
  return ok(writeStream(r, stream, byte) ? byte[0] : 0xffffffff, 2);
}
function fgetc(r, a) {
  const stream = streamFor(r, a(0));
  if (!stream || !stream.open) return ok(0xffffffff, 1);
  if (stream.standard === 'stdin') {
    stream.eof = true;
    return ok(0xffffffff, 1);
  }
  const bytes = r.files.get(stream.path) ?? new Uint8Array();
  if (stream.position >= bytes.length) {
    stream.eof = true;
    return ok(0xffffffff, 1);
  }
  const byte = bytes[stream.position++];
  touchFile(r, stream.path, { read: true });
  return ok(byte, 1);
}
// fputs(string, stream) writes NUL-terminated bytes and returns a non-negative
// value; unlike puts it does not append a newline.
function fputs(r, a) {
  const stream = streamFor(r, a(1));
  if (!stream || !stream.open) return ok(0xffffffff, 2);
  const pointer = a(0);
  if (!pointer) return ok(0xffffffff, 2);
  const bytes = [];
  for (let i = 0; i < 0x1000000; i++) {
    const byte = r.guestMemory.read(pointer + i, 1);
    if (!byte) break;
    bytes.push(byte);
  }
  const written = writeStream(r, stream, Uint8Array.from(bytes));
  return ok(written >= 0 ? written : 0xffffffff, 2);
}
function fgets(r, a) {
  const buffer = a(0);
  const capacity = a(1) | 0;
  const stream = streamFor(r, a(2));
  if (!stream || !stream.open || !buffer || capacity <= 0) return ok(0, 3);
  r.check(buffer, capacity, true);
  if (stream.standard === 'stdin') {
    stream.eof = true;
    return ok(0, 3);
  }
  const bytes = r.files.get(stream.path) ?? new Uint8Array();
  let written = 0;
  while (written < capacity - 1 && stream.position < bytes.length) {
    const byte = bytes[stream.position++];
    r.data[buffer + written++] = byte;
    if (byte === 0x0a) break;
  }
  r.data[buffer + written] = 0;
  if (!written) {
    stream.eof = true;
    return ok(0, 3);
  }
  touchFile(r, stream.path, { read: true });
  return ok(buffer, 3);
}
function feof(r, a) {
  const stream = streamFor(r, a(0));
  return ok(stream?.eof ? 1 : 0, 1);
}
function ferror(r, a) {
  const stream = streamFor(r, a(0));
  return ok(stream?.error ? 1 : 0, 1);
}
function clearerr(r, a) {
  const stream = streamFor(r, a(0));
  if (stream) {
    stream.error = false;
    stream.eof = false;
  }
  return ok(0, 1);
}
function fseek(r, a) {
  const stream = streamFor(r, a(0));
  if (!stream || !stream.open) return ok(0xffffffff, 3);
  const offset = a(1) | 0;
  const origin = a(2) | 0;
  const bytes = stream.path ? (r.files.get(stream.path)?.length ?? 0) : 0;
  const base = origin === 0 ? 0 : origin === 1 ? stream.position : bytes;
  const next = base + offset;
  if (next < 0) return ok(0xffffffff, 3);
  stream.position = next;
  stream.eof = false;
  return ok(0, 3);
}
function ftell(r, a) {
  const stream = streamFor(r, a(0));
  if (!stream || !stream.open) return ok(0xffffffff, 1);
  return ok(stream.position, 1);
}
// puts writes the string and a newline to stdout; putchar writes one byte.
function puts(r, a) {
  const stdout = standardStreams(r).addresses[1];
  fputs(r, (index) => (index === 0 ? a(0) : stdout), 2);
  writeStream(r, streamFor(r, stdout), Uint8Array.of(0x0a));
  return ok(0, 1);
}
function putchar(r, a) {
  const stdout = standardStreams(r).addresses[1];
  return fputc(r, (index) => (index === 0 ? a(0) : stdout), 2);
}
function fgetcharFn(r, a) {
  const stdin = standardStreams(r).addresses[0];
  return fgetc(r, (index) => (index === 0 ? stdin : 0), 1);
}
function fileno(r, a) {
  const stream = streamFor(r, a(0));
  if (!stream) return ok(0xffffffff, 1);
  return ok(stream.standard === 'stdin' ? 0 : stream.standard ? 1 : 0, 1);
}
function fflushStream(r, a) {
  return flush(r, a, 1);
}

// Register the FILE* entry points and the _iob data block. The data exports
// _iob/__p__iob already exist; their cell must be the real stream array, so
// DATA_EXPORTS['_iob'] is left as-is and this function only adds the calls.
function registerStdio() {
  const add = (name, handler) => {
    if (msvcrtApis[`msvcrt.dll!${name}`]) return;
    msvcrtApis[`msvcrt.dll!${name}`] = handler;
  };
  add('fopen', (r, a) => openStream(r, a, false));
  add('fopen_s', (r, a) => {
    const out = a(0);
    if (!out) return ok(22, 3);
    r.check(out, 4, true);
    const opened = openStream(r, (index) => a(index + 1), false);
    r.write32(out, opened.result);
    return ok(opened.result ? 0 : 2, 3);
  });
  add('freopen', (r, a) => {
    if (a(0) >>> 0 === 0) return openStream(r, a, false);
    const stream = streamFor(r, a(0));
    if (stream?.open) fclose(r, (index) => (index === 0 ? stream.address : 0), 1);
    const opened = openStream(r, a, false);
    if (opened.result) {
      // freopen keeps the same FILE object when it can; the new stream points
      // at the reopened file either way.
      return ok(opened.result, 3);
    }
    return ok(0, 3);
  });
  add('fclose', fclose);
  add('fflush', fflushStream);
  add('fwrite', fwrite);
  add('fread', fread);
  add('fputc', fputc);
  add('fgetc', fgetc);
  add('fputs', fputs);
  add('fgets', fgets);
  add('feof', feof);
  add('ferror', ferror);
  add('clearerr', clearerr);
  add('fseek', fseek);
  add('ftell', ftell);
  add('puts', puts);
  add('putchar', putchar);
  add('fgetchar', fgetcharFn);
  add('fileno', fileno);
  add('_fileno', fileno);
  // The *_nolock forms share behaviour: the runtime executes one guest thread
  // at a time, so there is no other thread to lock against.
  add('_fwrite_nolock', fwrite);
  add('_fread_nolock', fread);
  add('_fflush_nolock', fflushStream);
  add('_fputc_nolock', fputc);
  add('_fgetc_nolock', fgetc);
  add('_fclose_nolock', fclose);
  add('_fputs_nolock', fputs);
  // The real buffer-fill/flush primitives are internal, but a program that
  // calls them gets the equivalent refresh.
  add('_filbuf', (r, a) => fgetc(r, a));
  add('_flsbuf', fputc);
  // _iob and __p__iob must name the real stream array rather than a zero cell.
  add('_iob', (r, a) => ok(standardStreams(r).base, 0));
}
registerStdio();

// ---------------------------------------------------------------------------
// The low-level CRT file-descriptor layer (_open/_read/_write/_close/_lseek and
// friends). MSVC's descriptors 0-2 are the standard streams; every other
// descriptor is backed by a real Win32 handle from this runtime's file API, so
// `_get_osfhandle` returns a handle the rest of the program can pass back to
// Win32, and sharing, metadata and dirty tracking stay in one place.
const CRT_FD_FIRST = 3;
function crtFdState(r) {
  r.crtFds ??= new Map(); // descriptor -> Win32 handle
  r.crtFdNext ??= CRT_FD_FIRST;
  return r.crtFds;
}
// CRT <fcntl.h> flags.
const O_RDONLY = 0x0000,
  O_WRONLY = 0x0001,
  O_RDWR = 0x0002,
  O_APPEND = 0x0008,
  O_CREAT = 0x0100,
  O_TRUNC = 0x0200,
  O_EXCL = 0x0400,
  O_TEXT = 0x4000,
  O_BINARY = 0x8000;
const WIN32_ACCESS = { [O_RDONLY]: 0x80000000, [O_WRONLY]: 0x40000000, [O_RDWR]: 0xc0000000 };
// Win32 creation dispositions.
const CREATE_NEW = 1,
  CREATE_ALWAYS = 2,
  OPEN_EXISTING = 3,
  OPEN_ALWAYS = 4,
  TRUNCATE_EXISTING = 5;

function win32Handler(r, name) {
  return r.apiProvider.get(`kernel32.dll!${name}`);
}

async function openDescriptor(r, a) {
  const path = r.string(a(0));
  const flags = a(1) >>> 0;
  const accessBits = flags & 0x3;
  const access = WIN32_ACCESS[accessBits];
  if (access === undefined) return ok(0xffffffff, 3);
  // Derive the disposition the way the CRT does: O_TRUNC implies a write.
  let disposition = OPEN_EXISTING;
  if (flags & O_CREAT) disposition = flags & O_EXCL ? CREATE_NEW : OPEN_ALWAYS;
  if (flags & O_TRUNC) {
    if (flags & O_CREAT) disposition = CREATE_ALWAYS;
    else disposition = TRUNCATE_EXISTING;
  }
  const pointer = r.allocString(path, true);
  const create = win32Handler(r, 'CreateFileW');
  const response = await create(
    r,
    (index) =>
      [pointer, access, 1, 0, disposition, flags & O_APPEND ? 0x4000000 : 0, 0][index] ?? 0,
  );
  const handle = response.result >>> 0;
  if (handle === 0xffffffff) return ok(0xffffffff, 3);
  const fds = crtFdState(r);
  if (fds.size >= 512) throw Error('CRT descriptor limit exceeded');
  let descriptor = r.crtFdNext++;
  while (fds.has(descriptor) || descriptor < CRT_FD_FIRST) descriptor = r.crtFdNext++;
  fds.set(descriptor, handle);
  return ok(descriptor, 3);
}
function closeDescriptor(r, a) {
  const descriptor = a(0) >>> 0;
  const fds = crtFdState(r);
  if (!fds.has(descriptor)) return ok(0xffffffff, 1);
  const handle = fds.get(descriptor);
  fds.delete(descriptor);
  const close = win32Handler(r, 'CloseHandle');
  return close(r, (index) => (index === 0 ? handle : 0));
}
async function readDescriptor(r, a) {
  const descriptor = a(0) >>> 0;
  const buffer = a(1) >>> 0,
    count = a(2) >>> 0;
  if (count > 16 * 1024 * 1024) throw Error('_read exceeds per-call limit');
  // Descriptors 0-2 are the standard streams; only stdin (0) is an input.
  const handle = descriptor === 0 ? 0 : crtFdState(r).get(descriptor);
  if (handle === undefined) return ok(0xffffffff, 3);
  const read = win32Handler(r, 'ReadFile');
  const bytesRead = r.allocate(4);
  const response = await read(r, (index) => [handle, buffer, count, bytesRead, 0][index] ?? 0);
  return response.result ? ok(r.read32(bytesRead) >>> 0, 3) : ok(0xffffffff, 3);
}
async function writeDescriptor(r, a) {
  const descriptor = a(0) >>> 0;
  const buffer = a(1) >>> 0,
    count = a(2) >>> 0;
  if (count > 16 * 1024 * 1024) throw Error('_write exceeds per-call limit');
  const handle = descriptor === 1 || descriptor === 2 ? descriptor : crtFdState(r).get(descriptor);
  if (handle === undefined) return ok(0xffffffff, 3);
  const write = win32Handler(r, 'WriteFile');
  const bytesWritten = r.allocate(4);
  const response = await write(r, (index) => [handle, buffer, count, bytesWritten, 0][index] ?? 0);
  return response.result ? ok(r.read32(bytesWritten) >>> 0, 3) : ok(0xffffffff, 3);
}
async function seekDescriptor(r, a) {
  const descriptor = a(0) >>> 0;
  const handle = crtFdState(r).get(descriptor);
  if (handle === undefined) return ok(0xffffffff, 3);
  const seek = win32Handler(r, 'SetFilePointer');
  const response = await seek(
    r,
    (index) => [handle, a(1) >>> 0, 0, a(2) >>> 0 === 1 ? 1 : a(2) >>> 0 === 2 ? 2 : 0][index] ?? 0,
  );
  const position = response.result >>> 0;
  return position === 0xffffffff ? ok(0xffffffff, 3) : ok(position, 3);
}
async function fileLengthDescriptor(r, a) {
  const descriptor = a(0) >>> 0;
  const handle = crtFdState(r).get(descriptor);
  if (handle === undefined) return ok(0xffffffff, 1);
  const size = win32Handler(r, 'GetFileSize');
  const response = await size(r, (index) => [handle, 0][index] ?? 0);
  return response.result >>> 0 === 0xffffffff ? ok(0xffffffff, 1) : ok(response.result >>> 0, 1);
}
// _chsize truncates or extends; both need the descriptor positioned at the new
// length first, then SetEndOfFile.
async function changeSizeDescriptor(r, a) {
  const descriptor = a(0) >>> 0;
  const handle = crtFdState(r).get(descriptor);
  if (handle === undefined) return ok(0xffffffff, 2);
  const length = a(1) >>> 0;
  const seek = win32Handler(r, 'SetFilePointer');
  const moved = await seek(r, (index) => [handle, length, 0, 0][index] ?? 0);
  if (moved.result >>> 0 === 0xffffffff && length !== 0) return ok(0xffffffff, 2);
  const end = win32Handler(r, 'SetEndOfFile');
  const response = await end(r, (index) => (index === 0 ? handle : 0));
  return ok(response.result ? 0 : 0xffffffff, 2);
}
async function commitDescriptor(r, a) {
  const descriptor = a(0) >>> 0;
  const handle = crtFdState(r).get(descriptor);
  if (handle === undefined) return ok(0xffffffff, 1);
  const flush = win32Handler(r, 'FlushFileBuffers');
  const response = await flush(r, (index) => (index === 0 ? handle : 0));
  return ok(response.result ? 0 : 0xffffffff, 1);
}
// _get_osfhandle(fd) hands back the Win32 handle. The standard descriptors are
// the console handles the runtime's own ReadFile/WriteFile already accept.
function getOsfHandle(r, a) {
  const descriptor = a(0) >>> 0;
  if (descriptor <= 2) return ok(descriptor, 1);
  const handle = crtFdState(r).get(descriptor);
  return ok(handle === undefined ? 0xffffffff : handle, 1);
}
function isatty(r, a) {
  const descriptor = a(0) >>> 0;
  // Only the standard streams are character devices; everything else is a file.
  return ok(descriptor <= 2 ? 1 : 0, 1);
}
// _setmode sets the descriptor's translation mode and returns the previous one.
function setMode(r, a) {
  const descriptor = a(0) >>> 0;
  const mode = a(1) >>> 0;
  if (![O_TEXT, O_BINARY].includes(mode) || (descriptor > 2 && !crtFdState(r).has(descriptor)))
    return ok(0xffffffff, 2);
  r.crtModes ??= new Map();
  const previous = r.crtModes.get(descriptor) ?? O_TEXT;
  r.crtModes.set(descriptor, mode);
  return ok(previous, 2);
}
// _fdopen wraps an existing descriptor in a FILE*.
function fdOpen(r, a) {
  const descriptor = a(0) >>> 0;
  const state = stdioState(r);
  if (state.byAddress.size >= 256) throw Error('stdio stream limit exceeded');
  const stream = {
    address: r.allocate(STDIO_STRUCT_BYTES, true),
    descriptor,
    position: 0,
    mode: r.string(a(1)),
    open: true,
    error: false,
    eof: false,
    reading: true,
    writing: true,
  };
  state.byAddress.set(stream.address, stream);
  return ok(stream.address, 2);
}
function registerCrtDescriptors() {
  const add = (name, handler) => {
    if (msvcrtApis[`msvcrt.dll!${name}`]) return;
    msvcrtApis[`msvcrt.dll!${name}`] = handler;
  };
  add('_open', openDescriptor);
  add('_sopen', openDescriptor);
  add('_wopen', openDescriptor);
  add('_close', closeDescriptor);
  add('_read', readDescriptor);
  add('_write', writeDescriptor);
  add('_lseek', seekDescriptor);
  add('_filelength', fileLengthDescriptor);
  add('_filelengthi64', fileLengthDescriptor);
  add('_chsize', changeSizeDescriptor);
  add('_chsize_s', changeSizeDescriptor);
  add('_commit', commitDescriptor);
  add('_get_osfhandle', getOsfHandle);
  add('_isatty', isatty);
  add('_setmode', setMode);
  add('_fdopen', fdOpen);
}
registerCrtDescriptors();

// ---------------------------------------------------------------------------
// Completing the export surface. The generated list is Wine's real msvcrt
// export set, so every name a program can resolve resolves here too. Names
// without an implementation get an explicit trap that reports the symbol, never
// a silent success. Imported (IAT) entries cannot trap usefully, so they are
// only registered for GetProcAddress lookups; the loader still fails an
// unreachable import loudly through the normal missing-import path.
// The versioned CRT DLLs export a superset of msvcrt; register the extra names so an
// import against msvcr80..msvcr120 resolves, with a trap where unimplemented.
export const MSVCRT_VERSIONED_TRAPS = new Set();
for (const name of VERSIONED_CRT_EXPORT_NAMES) {
  const key = `msvcrt.dll!${name}`;
  if (msvcrtApis[key]) continue;
  MSVCRT_VERSIONED_TRAPS.add(key);
  msvcrtApis[key] = () => {
    throw Error(`Unimplemented versioned CRT entry point ${name}`);
  };
}

export const MSVCRT_TRAP_EXPORTS = new Set();
for (const name of MSVCRT_EXPORT_NAMES) {
  const key = `msvcrt.dll!${name}`;
  if (msvcrtApis[key]) continue;
  MSVCRT_TRAP_EXPORTS.add(key);
  msvcrtApis[key] = () => {
    throw Error(`Unimplemented msvcrt entry point ${name}`);
  };
}

// The i386 CRT uses cdecl: the CALLER pops the arguments. A handler that also
// pops them (the runtime's default stdcall) would remove each argument twice and
// corrupt the caller's stack, so every cdecl entry is wrapped to declare its
// convention. Data exports are not called at all; GetProcAddress returns their
// address through the dedicated path.
export const MSVCRT_CDECL = new Set();
for (const name of MSVCRT_CDECL_EXPORTS) {
  const key = `msvcrt.dll!${name}`;
  if (MSVCRT_DATA_EXPORTS.has(name)) continue;
  const handler = msvcrtApis[key];
  if (!handler) continue;
  MSVCRT_CDECL.add(key);
  msvcrtApis[key] = async (r, a) => {
    const response = await handler(r, a);
    return { ...response, convention: 'cdecl' };
  };
}
