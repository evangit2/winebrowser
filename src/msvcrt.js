// msvcrt.dll. Real handlers where the runtime implements the entry point;
// Minimal MSVCRT surface for the entry points native applications import when
// they statically link a CRT or load one indirectly. Everything here is pure
// computation over guest memory; no host libc is involved. `$I10_OUTPUT` is
// Wine's own algorithm: it converts the ext80 to a double and formats that, so
// this reproduces the same digits by the same route.
import {
  MSVCRT_EXPORT_NAMES,
  MSVCRT_CDECL_EXPORTS,
  MSVCRT_DATA_EXPORTS,
} from './msvcrt-exports.js';

const ok = (result = 0, argc = 0) => ({ result, argc });
// A double argument/result passed by value on the x86 stack. The runtime reads
// the argument slot as two DWORDs and writes the result into eax:edx.
function doubleArg(r, a, index) {
  const low = a(index) >>> 0,
    high = a(index + 1) >>> 0;
  return new DataView(new Uint32Array([low, high]).buffer).getFloat64(0, true);
}
function doubleResult(compute, r, a) {
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, compute(doubleArg(r, a, 0)), true);
  const low = bytes.getUint32(0, true),
    high = bytes.getUint32(4, true);
  return { result: low | 0, resultHigh: high | 0, argc: 2 };
}
function doubleResult2(compute, r, a) {
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, compute(doubleArg(r, a, 0), doubleArg(r, a, 2)), true);
  return {
    result: bytes.getUint32(0, true) | 0,
    resultHigh: bytes.getUint32(4, true) | 0,
    argc: 4,
  };
}

// struct _I10_OUTPUT_DATA { short pos; char sign; BYTE len; char str[22]; }
const DATA_STR = 4,
  DATA_SIZE = 4 + 22;
const I10_MAX_PREC = 21;

function unpackExt80(r, address) {
  const sig = r.view.getBigUint64(address, true),
    field = r.view.getUint16(address + 8, true);
  const exponent = field & 0x7fff,
    negative = !!(field & 0x8000);
  const invalid = exponent !== 0 && !(sig & (1n << 63n));
  const nan = exponent === 0x7fff && !!(sig & ((1n << 63n) - 1n));
  return { sig, exponent, negative, invalid, nan, infinity: exponent === 0x7fff && sig === 1n << 63n };
}

// $I10_OUTPUT (_LDOUBLE ld80, int prec, int flag, struct _I10_OUTPUT_DATA *data)
function i10Output(r, a) {
  const prec = a(1) | 0;
  let flag = a(2) | 0;
  const data = a(3) >>> 0;
  if (data) r.check(data, DATA_SIZE, true);
  const value = unpackExt80(r, a(0));
  let text;
  if (value.invalid || value.nan || value.infinity) {
    text =
      value.invalid || value.nan
        ? value.sig & (1n << 62n)
          ? '1#QNAN'
          : '1#SNAN'
        : '1#INF';
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
  r.data.copyWithin(a(0), a(1), a(1) + count * width);
  return ok(a(0), 3);
}
function move(r, a, width) {
  const count = a(2) >>> 0;
  if (!count) return ok(a(0), 3);
  const size = count * width;
  r.check(a(0), size, true);
  r.check(a(1), size);
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
    for (let i = 0; i < count; i++) r.write32(a(0) + i * 4, a(1));
  } else if (width === 2) {
    for (let i = 0; i < count * 2; i++) r.data[a(0) + i] = bytes[i & 1];
  } else r.data.fill(a(1) & 0xff, a(0), a(0) + count);
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
// non-null entry, the same way the CRT runs static initializers. _initterm_e
// stops at the first initializer that returns non-zero and propagates it.
async function initTerm(r, a) {
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
    if (result) return ok(result >>> 0, 2);
  }
  return ok(0, 2);
}
msvcrtApis['msvcrt.dll!_initterm'] = initTerm;
msvcrtApis['msvcrt.dll!_initterm_e'] = initTerm;
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
  for (const [index, value] of [
    [0, (r.arguments ?? []).length],
  ]) {
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
    r.write32(a(0), (r.arguments ?? []).length);
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
    const args = [];
    for (let i = 0; i < count; i++) args.push(x87.doubleOperand(i));
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
  if ((mask & MSVC_MASK.INVALID) && newval & MSVC_MASK.INVALID) {
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
    if (newval & 0x300) cw |= newval & 0x200 ? ((newval & 0x100) ? 0xc00 : 0x800) : 0x400;
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
  floor: (r, a) => doubleResult(Math.floor, r, a),
  ceil: (r, a) => doubleResult(Math.ceil, r, a),
  sqrt: (r, a) => doubleResult(Math.sqrt, r, a),
  fabs: (r, a) => doubleResult(Math.abs, r, a),
  sin: (r, a) => doubleResult(Math.sin, r, a),
  cos: (r, a) => doubleResult(Math.cos, r, a),
  tan: (r, a) => doubleResult(Math.tan, r, a),
  asin: (r, a) => doubleResult(Math.asin, r, a),
  acos: (r, a) => doubleResult(Math.acos, r, a),
  atan: (r, a) => doubleResult(Math.atan, r, a),
  atan2: (r, a) => doubleResult2(Math.atan2, r, a),
  exp: (r, a) => doubleResult(Math.exp, r, a),
  log: (r, a) => doubleResult(Math.log, r, a),
  log10: (r, a) => doubleResult(Math.log10, r, a),
  pow: (r, a) => doubleResult2((x, y) => x ** y, r, a),
  fmod: (r, a) => doubleResult2((x, y) => x % y, r, a),
  cosh: (r, a) => doubleResult(Math.cosh, r, a),
  sinh: (r, a) => doubleResult(Math.sinh, r, a),
  tanh: (r, a) => doubleResult(Math.tanh, r, a),
  atan2f: (r, a) => doubleResult2(Math.atan2, r, a),
  fabsf: (r, a) => doubleResult(Math.abs, r, a),
  sqrtf: (r, a) => doubleResult(Math.sqrt, r, a),
  powf: (r, a) => doubleResult2((x, y) => x ** y, r, a),
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
        if (r.data[a(0) + i + j] !== r.data[a(1) + j]) { match = false; break; }
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
  '$I10_OUTPUT': i10Output,
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
// A FILE structure in the MSVC layout; _iob is stdin/stdout/stderr.
function iobArray(r) {
  const base = r.allocate(32 * 3, true);
  for (let i = 0; i < 3; i++) {
    r.write32(base + i * 32 + 12, i === 0 ? 0x0002 : 0x0001);
    r.write32(base + i * 32 + 16, i);
  }
  return base;
}
function commandLinePointer(r, wide) {
  return r.allocString((r.arguments ?? []).join(' '), wide);
}
function argvPointer(r, wide) {
  const args = r.arguments?.length ? r.arguments : [''];
  const strings = args.map((argument) => r.allocString(argument, wide));
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
  _acmdln: (r) => commandLinePointer(r, false),
  _wcmdln: (r) => commandLinePointer(r, true),
  _pgmptr: (r) => programPointer(r, false),
  _wpgmptr: (r) => programPointer(r, true),
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
  __argc: (r) => integerCell((r.arguments ?? []).length)(r),
  __argv: (r) => argvPointer(r, false),
  __wargv: (r) => argvPointer(r, true),
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
      if (!r.msvcrtData.has(target)) r.msvcrtData.set(target, r.allocate(target === '_pwctype' ? 1024 : 512, true));
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
// Completing the export surface. The generated list is Wine's real msvcrt
// export set, so every name a program can resolve resolves here too. Names
// without an implementation get an explicit trap that reports the symbol, never
// a silent success. Imported (IAT) entries cannot trap usefully, so they are
// only registered for GetProcAddress lookups; the loader still fails an
// unreachable import loudly through the normal missing-import path.
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
