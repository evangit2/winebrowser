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
import {
  VERSIONED_CRT_CDECL_EXPORTS,
  VERSIONED_CRT_DATA_EXPORTS,
  VERSIONED_CRT_EXPORT_NAMES,
} from './msvcrt-versioned-exports.js';
import { resolveGuestPath } from './guest-paths.js';
import { touchFile } from './file-metadata.js';
import { processCommandLine, processArguments } from './command-line.js';
import { encodeAnsi } from './encoding.js';
import { fileMetadata } from './file-metadata.js';
import { crtCtypeCell, registerCrtExtended } from './msvcrt-extended.js';
import { registerStreamPrintf } from './msvcrt-printf.js';
import { registerScanf } from './msvcrt-scanf.js';

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
// Case folding for the CRT's case-insensitive comparisons. The fold must leave
// the NUL terminator alone: `byte | 0x20` maps 0x00 to 0x20 (space), so a loop
// that folds before testing for the terminator never sees the end of the string
// and compares whatever follows it. Two equal strings then compare unequal
// wherever their neighbours differ, which is how a DDS loader is skipped and a
// file is reported missing while it sits in the package.
const foldAscii = (byte) => (byte >= 0x41 && byte <= 0x5a ? byte | 0x20 : byte);

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
  const rightLength = ansiLength(r, (index) => (index === 0 ? a(1) : 0)).result;
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
msvcrtApis['msvcrt.dll!_amsg_exit'] = (r, a) => crtExit(r, accessor([a(0)]));
msvcrtApis['msvcrt.dll!_set_app_type'] = (r, a) => {
  r.crtAppType = a(0) | 0;
  return ok(0, 1);
};
msvcrtApis['msvcrt.dll!__set_app_type'] = msvcrtApis['msvcrt.dll!_set_app_type'];
msvcrtApis['msvcrt.dll!__setusermatherr'] = () => ok(0, 1);
// The authoritative definitions of the floating-point control entry points sit
// after applyMsvcControl, so they can reproduce Wine's own translation.
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
// The SSE2 math entry points. Unlike the x87 _CI* intrinsics, these take their
// arguments in XMM0/XMM1 and return in XMM0, so they need the SIMD register
// file rather than the x87 stack. The `f` spellings work on binary32.
function xmmDouble(r, index) {
  return new DataView(r.cpu.simd.registers[index].buffer).getFloat64(0, true);
}
function xmmFloat(r, index) {
  return new DataView(r.cpu.simd.registers[index].buffer).getFloat32(0, true);
}
function setXmmDouble(r, index, value) {
  new DataView(r.cpu.simd.registers[index].buffer).setFloat64(0, value, true);
}
function setXmmFloat(r, index, value) {
  new DataView(r.cpu.simd.registers[index].buffer).setFloat32(0, value, true);
}
const SSE2_MATH = {
  __libm_sse2_acos: [1, (a) => Math.acos(a)],
  __libm_sse2_asin: [1, (a) => Math.asin(a)],
  __libm_sse2_atan: [1, (a) => Math.atan(a)],
  __libm_sse2_atan2: [2, (a, b) => Math.atan2(a, b)],
  __libm_sse2_cos: [1, (a) => Math.cos(a)],
  __libm_sse2_exp: [1, (a) => Math.exp(a)],
  __libm_sse2_log: [1, (a) => Math.log(a)],
  __libm_sse2_log10: [1, (a) => Math.log10(a)],
  __libm_sse2_pow: [2, (a, b) => a ** b],
  __libm_sse2_sin: [1, (a) => Math.sin(a)],
  __libm_sse2_tan: [1, (a) => Math.tan(a)],
};
const SSE2_MATH_FLOAT = {
  __libm_sse2_acosf: [1, (a) => Math.acos(a)],
  __libm_sse2_asinf: [1, (a) => Math.asin(a)],
  __libm_sse2_atanf: [1, (a) => Math.atan(a)],
  __libm_sse2_cosf: [1, (a) => Math.cos(a)],
  __libm_sse2_expf: [1, (a) => Math.exp(a)],
  __libm_sse2_logf: [1, (a) => Math.log(a)],
  __libm_sse2_log10f: [1, (a) => Math.log10(a)],
  __libm_sse2_powf: [2, (a, b) => a ** b],
  __libm_sse2_sinf: [1, (a) => Math.sin(a)],
  __libm_sse2_tanf: [1, (a) => Math.tan(a)],
};
for (const [name, [count, compute]] of Object.entries(SSE2_MATH)) {
  msvcrtApis[`msvcrt.dll!${name}`] = (r) => {
    const args = [];
    for (let i = 0; i < count; i++) args.push(xmmDouble(r, i));
    setXmmDouble(r, 0, compute(...args));
    return ok(0, 0);
  };
}
for (const [name, [count, compute]] of Object.entries(SSE2_MATH_FLOAT)) {
  msvcrtApis[`msvcrt.dll!${name}`] = (r) => {
    const args = [];
    for (let i = 0; i < count; i++) args.push(xmmFloat(r, i));
    setXmmFloat(r, 0, compute(...args));
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
  MSVC_MCW_IC = 0x00040000,
  // _MCW_DN (float.h): the denormal control, accepted and mirrored into the
  // x87 control word's denormal bit by applyMsvcControl.
  MSVC_MCW_DN = 0x03000000;
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
// int _controlfp_s(unsigned int *current, unsigned int newval, unsigned int mask).
// The first argument is the out-parameter, so treating it as data would write
// through a mask value as though it were an address.
msvcrtApis['msvcrt.dll!_controlfp_s'] = (r, a) => {
  const out = a(0) >>> 0;
  const newval = a(1) >>> 0,
    mask = a(2) >>> 0;
  const previous = msvcControl(r.cpu.x87);
  const applied = mask & (MSVC_MCW_EM | MSVC_MCW_RC | MSVC_MCW_PC | MSVC_MCW_IC);
  if (applied) applyMsvcControl(r.cpu.x87, newval, applied);
  if (out) {
    r.check(out, 4, true);
    r.write32(out, previous);
  }
  // A bit set in both the value and the mask that names no control-word field
  // is EINVAL; the caller still receives the current word, as the CRT does.
  if (newval & mask & ~(MSVC_MCW_EM | MSVC_MCW_IC | MSVC_MCW_RC | MSVC_MCW_PC | MSVC_MCW_DN))
    return ok(22, 3);
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
    const count =
      Math.max(ansiLength(r, a).result, ansiLength(r, (index) => (index === 0 ? a(1) : 0)).result) +
      1;
    return ansiCompareN(r, accessor([a(0), a(1), count]));
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
    const right = wideLength(r, (index) => (index === 0 ? a(1) : 0)).result;
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
    const needleLength = wideLength(r, (index) => (index === 0 ? a(1) : 0)).result;
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
    const set = wideLength(r, (index) => (index === 0 ? a(1) : 0)).result;
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
  // The array forms are separate exports with the same contract; a program that
  // allocates an array through `new[]` reaches this one.
  '??_U@YAPAXI@Z': (r, a) => {
    const size = a(0) >>> 0;
    if (!size) return ok(r.allocate(16), 1);
    if (size > 16 * 1024 * 1024) throw Error('operator new[] size limit exceeded');
    return ok(r.allocate(size), 1);
  },
  '??_V@YAXPAX@Z': (r, a) => {
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
      const left = foldAscii(r.data[a(0) + i]),
        right = foldAscii(r.data[a(1) + i]);
      if (left !== right) return ok(left < right ? -1 : 1, 2);
      if (!left) return ok(0, 2);
    }
  },
  _strnicmp: (r, a) => {
    const count = a(2) >>> 0;
    for (let i = 0; i < count; i++) {
      const left = foldAscii(r.data[a(0) + i]),
        right = foldAscii(r.data[a(1) + i]);
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
      needle = ansiLength(r, (index) => (index === 0 ? a(1) : 0)).result;
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
      const left = foldAscii(r.data[a(0) + i]),
        right = foldAscii(r.data[a(1) + i]);
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
// A host API handler receives its arguments as an accessor *function*: the
// dispatcher supplies `(index) => word`. A helper that forwards a constructed
// argument list must therefore build a function too. An object literal with
// numeric properties looks similar at a glance but is not callable, and the
// callee's first `a(0)` throws instead of running the operation.
const accessor = (values) => (index) => values[index] ?? 0;

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
      // The character-classification symbols (_pctype/_pwctype/_mbctype and the
      // tables behind them) are built once in msvcrt-extended.js from Wine's own
      // ctype data, so the accessor returns that address rather than a fresh
      // zeroed array.
      return { result: crtCtypeCell(r, target), argc: 0 };
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

// ---------------------------------------------------------------------------
// Stream-position, temporary-file and wide-stream entry points. They extend the
// FILE* layer above with the same stream records, so a position saved by
// fgetpos, a rewind, or a wide read all act on the one stream object a program
// also passes to fread/fwrite.
function fgetpos(r, a) {
  const stream = streamFor(r, a(0));
  const position = a(1);
  if (!stream || !stream.open || !position) return ok(-1, 2);
  r.check(position, 8, true);
  // fpos_t is a 64-bit value on i386 MSVC.
  r.view.setBigInt64(position, BigInt(stream.position), true);
  return ok(0, 2);
}
function fsetpos(r, a) {
  const stream = streamFor(r, a(0));
  const position = a(1);
  if (!stream || !stream.open || !position) return ok(-1, 2);
  r.check(position, 8);
  const value = Number(r.view.getBigInt64(position, true));
  if (value < 0) return ok(-1, 2);
  stream.position = value;
  stream.eof = false;
  return ok(0, 2);
}
// rewind returns nothing and, unlike fseek, clears the error indicator.
function rewindStream(r, a) {
  const stream = streamFor(r, a(0));
  if (stream && stream.open) {
    stream.position = 0;
    stream.eof = false;
    stream.error = false;
  }
  return ok(0, 1);
}
// _fseeki64/_ftelli64 are the 64-bit position forms. The offset spans two stack
// slots and the position comes back in EAX:EDX.
function seekStream64(r, a) {
  const stream = streamFor(r, a(0));
  if (!stream || !stream.open) return ok(-1, 3);
  const offset = Number(BigInt(a(1)) | (BigInt(a(2)) << 32n));
  const origin = a(3) | 0;
  const bytes = stream.path ? (r.files.get(stream.path)?.length ?? 0) : 0;
  const base = origin === 0 ? 0 : origin === 1 ? stream.position : bytes;
  const next = base + offset;
  if (next < 0) return ok(-1, 3);
  stream.position = next;
  stream.eof = false;
  return ok(0, 3);
}
function tellStream64(r, a) {
  const stream = streamFor(r, a(0));
  if (!stream || !stream.open) return ok(-1, 1);
  const position = BigInt(stream.position);
  return {
    result: Number(BigInt.asUintN(32, position)),
    resultHigh: Number(BigInt.asIntN(32, position >> 32n)),
    argc: 1,
  };
}
// _lseeki64 is the descriptor form of the same 64-bit seek.
async function seekDescriptor64(r, a) {
  const descriptor = a(0) >>> 0;
  const handle = crtFdState(r).get(descriptor);
  if (handle === undefined) return ok(-1, 3);
  const seek = win32Handler(r, 'SetFilePointer');
  const response = await seek(
    r,
    (index) =>
      [handle, a(1) >>> 0, a(2) >>> 0, a(3) >>> 0 === 1 ? 1 : a(3) >>> 0 === 2 ? 2 : 0][index] ?? 0,
  );
  const low = response.result >>> 0;
  if (low === 0xffffffff) return ok(0xffffffff, 3);
  return { result: low, resultHigh: r.cpu.r[2].value | 0, argc: 3 };
}
// Allocate and register one stream record, the shape every opener in this file
// already uses.
function createStream(r, fields) {
  const state = stdioState(r);
  if (state.byAddress.size >= 256) throw Error('stdio stream limit exceeded');
  const address = r.allocate(STDIO_STRUCT_BYTES, true);
  const stream = {
    address,
    path: null,
    position: 0,
    mode: 'r',
    reading: true,
    writing: true,
    append: false,
    open: true,
    error: false,
    eof: false,
    ...fields,
  };
  state.byAddress.set(address, stream);
  r.write32(address + 12, 0x0001);
  r.write32(address + 16, 0);
  return stream;
}
// tmpfile creates a uniquely named file in the volume's temp directory and
// wraps it in a "w+b" stream, the CRT's own contract.
function tmpfileImpl(r) {
  r.virtualDirectories ??= new Set();
  r.virtualDirectories.add('temp/');
  r.crtTempCounter = (r.crtTempCounter ?? 0) + 1;
  const path = `temp/tmp${r.crtTempCounter.toString(36)}.tmp`;
  r.files.set(path, new Uint8Array());
  r.dirty.add(path);
  touchFile(r, path, { created: true, write: true });
  const stream = createStream(r, { path, mode: 'w+b', temporary: true });
  return ok(stream.address, 0);
}
function tmpfileS(r, a) {
  const out = a(0);
  if (!out) {
    r.write32(errnoCell(r, 'errno'), EINVAL);
    return ok(EINVAL, 1);
  }
  const created = tmpfileImpl(r);
  r.write32(out, created.result);
  return ok(created.result ? 0 : 12, 1);
}
// tmpnam/tmpnam_s produce a unique name "s<counter>" the caller can open. The
// caller owns the buffer; the non-_s form allocates one when handed NULL.
function tmpnamImpl(r, a, wide, withSize) {
  const separator = process.env.WINEBROWSER_TMPDIR || '\\';
  const text = `${separator}${separator === '\\' ? '' : ''}s${(r.crtTempCounter = (r.crtTempCounter ?? 0) + 1).toString(36)}`;
  const buffer = a(withSize ? 1 : 0);
  if (buffer) {
    const size = withSize ? a(2) >>> 0 : undefined;
    if (size !== undefined && text.length + 1 > size) {
      r.write32(errnoCell(r, 'errno'), ERANGE);
      return ok(ERANGE, 3);
    }
    r.check(buffer, (text.length + 1) * (wide ? 2 : 1), true);
    if (wide) {
      for (let i = 0; i <= text.length; i++)
        r.guestMemory.write(buffer + i * 2, i === text.length ? 0 : text.charCodeAt(i), 2);
    } else {
      for (let i = 0; i <= text.length; i++)
        r.data[buffer + i] = i === text.length ? 0 : text.charCodeAt(i) & 0xff;
    }
    return ok(withSize ? 0 : buffer, withSize ? 3 : 1);
  }
  return ok(r.allocString(text, wide), withSize ? 3 : 1);
}
// The wide single-character and string stream forms read and write the same
// byte streams; a UTF-16 unit below 0x80 maps to its byte.
function fgetwcImpl(r, a) {
  const result = fgetc(r, a).result >>> 0;
  return ok(result === 0xffffffff ? 0xffff : result, 1);
}
function fputwcImpl(r, a) {
  return fputc(r, a);
}
function fgetwsImpl(r, a) {
  const buffer = a(0),
    capacity = a(1) | 0;
  const stream = streamFor(r, a(2));
  if (!stream || !stream.open || !buffer || capacity <= 0) return ok(0, 3);
  if (stream.standard === 'stdin') {
    stream.eof = true;
    return ok(0, 3);
  }
  const bytes = r.files.get(stream.path) ?? new Uint8Array();
  let written = 0;
  while (written < capacity - 1 && stream.position < bytes.length) {
    const byte = bytes[stream.position++];
    r.guestMemory.write(buffer + written * 2, byte, 2);
    written++;
    if (byte === 0x0a) break;
  }
  r.guestMemory.write(buffer + written * 2, 0, 2);
  if (!written) {
    stream.eof = true;
    return ok(0, 3);
  }
  touchFile(r, stream.path, { read: true });
  return ok(buffer, 3);
}
function fputwsImpl(r, a) {
  const pointer = a(0);
  const stream = streamFor(r, a(1));
  if (!stream || !stream.open || !pointer) return ok(0xffff, 2);
  const bytes = [];
  for (let i = 0; i < 0x1000000; i++) {
    const code = r.guestMemory.read(pointer + i * 2, 2);
    if (!code) break;
    bytes.push(code & 0xff);
  }
  const written = writeStream(r, stream, Uint8Array.from(bytes));
  return ok(written >= 0 ? written : 0xffff, 2);
}
// _fsopen/_wfsopen open with an explicit sharing mode; the runtime's virtual
// filesystem is process-local and already permits the default sharing, so the
// extra argument is validated and ignored.
function fsopenImpl(r, a, wide) {
  return openStream(r, a, wide);
}

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

  // Stream position, temporary files and the wide stream forms. These act on the
  // same stream records fread/fwrite use.
  add('fgetpos', fgetpos);
  add('fsetpos', fsetpos);
  add('rewind', rewindStream);
  add('_fseeki64', seekStream64);
  add('_ftelli64', tellStream64);
  add('_lseeki64', seekDescriptor64);
  add('tmpfile', tmpfileImpl);
  add('tmpfile_s', tmpfileS);
  add('tmpnam', (r, a) => tmpnamImpl(r, a, false, false));
  add('_tempnam', (r, a) => tmpnamImpl(r, a, false, false));
  add('_wtmpnam', (r, a) => tmpnamImpl(r, a, true, false));
  add('tmpnam_s', (r, a) => tmpnamImpl(r, a, false, true));
  add('_wtmpnam_s', (r, a) => tmpnamImpl(r, a, true, true));
  add('fgetwc', fgetwcImpl);
  add('_fgetwc_nolock', fgetwcImpl);
  add('fputwc', fputwcImpl);
  add('_fputwc_nolock', fputwcImpl);
  add('getwc', fgetwcImpl);
  add('putwc', fputwcImpl);
  add('fgetws', fgetwsImpl);
  add('fputws', fputwsImpl);
  add('_fsopen', (r, a) => fsopenImpl(r, a, false));
  add('_wfsopen', (r, a) => fsopenImpl(r, a, true));
  add('_wfopen', (r, a) => openStream(r, a, true));
  add('_wfreopen', (r, a) => {
    if (a(0) >>> 0 === 0) return openStream(r, a, true);
    const stream = streamFor(r, a(0));
    if (stream?.open) fclose(r, (index) => (index === 0 ? stream.address : 0), 1);
    return openStream(r, a, true);
  });
  add('_wfopen_s', (r, a) => {
    const out = a(0);
    if (!out) return ok(22, 4);
    r.check(out, 4, true);
    const opened = openStream(r, (index) => a(index + 1), true);
    r.write32(out, opened.result);
    return ok(opened.result ? 0 : 2, 4);
  });
  add('_wfdopen', (r, a) => fdOpen(r, a));
}
registerStdio();

registerStreamPrintf(msvcrtApis, {
  streamFor,
  standardStreams,
  writeStream,
  errnoCell,
  fputc,
  fgetc,
});

registerScanf(msvcrtApis, {
  streamFor,
  standardStreams,
  touchRead: (r, path) => touchFile(r, path, { read: true }),
});

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
  // _creat(path, pmode) is _open with O_CREAT|O_TRUNC|O_WRONLY.
  add('_creat', (r, a) =>
    openDescriptor(r, (index) => [a(0), O_WRONLY | O_CREAT | O_TRUNC][index] ?? 0),
  );
  add('_wcreat', (r, a) =>
    openDescriptor(r, (index) => [a(0), O_WRONLY | O_CREAT | O_TRUNC][index] ?? 0),
  );
  // _sopen_s(out, path, oflag, shflag, pmode) writes the descriptor and returns
  // an errno_t rather than the descriptor itself.
  add('_sopen_s', async (r, a) => {
    const opened = await openDescriptor(r, (index) => [a(1), a(2), a(3)][index] ?? 0);
    const descriptor = opened.result | 0;
    if (a(0)) r.write32(a(0), descriptor);
    return ok(descriptor < 0 ? 9 : 0, 5);
  });
}
registerCrtDescriptors();

// ---------------------------------------------------------------------------
// The CRT date/time family. `time_t` is 32-bit on Win32 (so `time`/`_time32`
// return one register) and 64-bit in the `_time64`/`_localtime64` forms, whose
// value the runtime returns in EAX:EDX. The runtime's guest clock is a UTC
// second count, and the runtime already models local time as UTC (the same
// choice `FileTimeToLocalFileTime` makes), so localtime and gmtime agree.
//
// struct tm is 36 bytes on i386 MSVC: nine ints, tm_sec first and tm_isdst last.
const TM_BYTES = 36;
const CLOCKS_PER_SEC = 1000; // MSVC's clock() tick is one millisecond.
const EINVAL = 22;
const ERANGE = 34;
const STRUNCATE = 80; // The `s` functions' "destination truncated" result.

function guestSeconds(r) {
  return Math.floor(r.systemNow() / 1000);
}
// A program-visible struct tm lives in guest memory and is read and written
// field by field; only the documented fields are meaningful.
function readTm(r, pointer) {
  const field = (index) => r.read32(pointer + index * 4) | 0;
  return {
    sec: field(0),
    min: field(1),
    hour: field(2),
    mday: field(3),
    mon: field(4),
    year: field(5),
    wday: field(6),
    yday: field(7),
    isdst: field(8),
  };
}
function writeTm(r, pointer, value) {
  r.check(pointer, TM_BYTES, true);
  const order = [value.sec, value.min, value.hour, value.mday, value.mon, value.year];
  order.forEach((entry, index) => r.write32(pointer + index * 4, entry | 0));
  r.write32(pointer + 24, value.wday | 0);
  r.write32(pointer + 28, value.yday | 0);
  r.write32(pointer + 32, value.isdst | 0);
}
// Converts a millisecond epoch value into the calendar fields struct tm holds.
function tmFromMilliseconds(milliseconds) {
  const date = new Date(milliseconds);
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  return {
    sec: date.getUTCSeconds(),
    min: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    mday: date.getUTCDate(),
    mon: date.getUTCMonth(),
    year: year - 1900,
    wday: date.getUTCDay(),
    yday: Math.floor((date.getTime() - start) / 86400000),
    isdst: 0,
  };
}
// The inverse: the milliseconds an in-range struct tm denotes. Out-of-range
// fields are normalized the way mktime documents (month 12 rolls the year), so
// the arithmetic runs on the raw field values before they are clamped back.
function millisecondsFromTm(tm) {
  const year = tm.year + 1900,
    mon = tm.mon,
    day = tm.mday,
    hour = tm.hour,
    min = tm.min,
    sec = tm.sec;
  if (![year, mon, day, hour, min, sec].every((value) => Number.isFinite(value))) return Number.NaN;
  return Date.UTC(year, mon, day, hour, min, sec);
}
function timeFromTm(r, pointer) {
  const milliseconds = millisecondsFromTm(readTm(r, pointer));
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.floor(milliseconds / 1000);
  writeTm(r, pointer, tmFromMilliseconds(seconds * 1000));
  return seconds;
}
// A stable per-process buffer for the functions that return a static pointer.
function timeBuffer(r, key, size) {
  r.msvcrtTimeBuffers ??= new Map();
  if (!r.msvcrtTimeBuffers.has(key)) r.msvcrtTimeBuffers.set(key, r.allocate(size, true));
  return r.msvcrtTimeBuffers.get(key);
}
// The 32-bit time_t: written through an optional pointer, returned in EAX.
function time32(r, a) {
  const seconds = guestSeconds(r);
  if (a(0)) {
    r.check(a(0), 4, true);
    r.write32(a(0), seconds);
  }
  return ok(seconds, 1);
}
// The 64-bit form returns the value in EAX:EDX, so the low half is `result` and
// the high half `resultHigh`.
function time64(r, a) {
  const seconds = guestSeconds(r);
  if (a(0)) {
    r.check(a(0), 8, true);
    r.view.setBigInt64(a(0), BigInt(seconds), true);
  }
  return { result: seconds >>> 0, resultHigh: Math.floor(seconds / 0x100000000) | 0, argc: 1 };
}
function localtimeImpl(r, a, wide) {
  const seconds = wide ? Number(r.view.getBigInt64(a(0), true)) : r.read32(a(0)) | 0;
  writeTm(
    r,
    timeBuffer(r, wide ? 'localtime64' : 'localtime', TM_BYTES),
    tmFromMilliseconds(seconds * 1000),
  );
  return ok(timeBuffer(r, wide ? 'localtime64' : 'localtime', TM_BYTES), 1);
}
function gmtimeImpl(r, a, wide) {
  const seconds = wide ? Number(r.view.getBigInt64(a(0), true)) : r.read32(a(0)) | 0;
  writeTm(
    r,
    timeBuffer(r, wide ? 'gmtime64' : 'gmtime', TM_BYTES),
    tmFromMilliseconds(seconds * 1000),
  );
  return ok(timeBuffer(r, wide ? 'gmtime64' : 'gmtime', TM_BYTES), 1);
}
function mktimeImpl(r, a, wide) {
  const seconds = timeFromTm(r, a(0));
  if (seconds === null) return ok(0xffffffff, 1);
  if (wide)
    return { result: seconds >>> 0, resultHigh: Math.floor(seconds / 0x100000000) | 0, argc: 1 };
  return ok(seconds, 1);
}
// "Www Mmm dd hh:mm:ss yyyy\n" — the asctime/ctime layout, always 26 bytes.
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function asctimeText(tm) {
  const day = DAY_NAMES[((tm.wday % 7) + 7) % 7];
  const month = MONTH_NAMES[((tm.mon % 12) + 12) % 12];
  const pad = (value, width) => String(value).padStart(width, '0');
  return (
    `${day} ${month} ${pad(tm.mday, 2)} ${pad(tm.hour, 2)}:${pad(tm.min, 2)}:${pad(tm.sec, 2)} ` +
    `${tm.year + 1900}\n`
  );
}
function writeText(r, pointer, text, capacity, wide) {
  const unit = wide ? 2 : 1;
  const count = Math.min(text.length, capacity - 1);
  for (let i = 0; i < count; i++) {
    const code = text.charCodeAt(i);
    if (wide) r.guestMemory.write(pointer + i * 2, code, 2);
    else r.data[pointer + i] = code & 0xff;
  }
  if (wide) r.guestMemory.write(pointer + count * 2, 0, 2);
  else r.data[pointer + count] = 0;
  return count;
}
function asctimeImpl(r, a, wide) {
  const text = asctimeText(readTm(r, a(0)));
  const buffer = timeBuffer(r, wide ? 'asctime_w' : 'asctime', 64);
  writeText(r, buffer, text, 32, wide);
  return ok(buffer, 1);
}
function ctimeImpl(r, a, wide) {
  const seconds = a(0)
    ? wide
      ? Number(r.view.getBigInt64(a(0), true))
      : r.read32(a(0)) | 0
    : guestSeconds(r);
  const text = asctimeText(tmFromMilliseconds(seconds * 1000));
  const buffer = timeBuffer(r, wide ? 'ctime_w' : 'ctime', 64);
  writeText(r, buffer, text, 32, wide);
  return ok(buffer, 1);
}
// difftime returns a double, which on i386 comes back in ST(0) rather than in
// EAX; the runtime's doubleResponse performs that.
function difftimeImpl(r, a) {
  const later = doubleArg(r, a, 0),
    earlier = doubleArg(r, a, 2);
  return doubleResponse(r, later - earlier, 4);
}
function clockImpl(r) {
  // clock() reports processor time; the runtime's guest clock is monotonic, so
  // its elapsed nanoseconds map to the millisecond CLOCKS_PER_SEC tick MSVC uses.
  return ok(Number(r.performanceClock.read() / 1000000n) | 0, 0);
}
// strftime writes at most `max` characters including the terminator and returns
// the length written excluding it, or 0 when the result does not fit. The
// runtime has one locale, so the language-dependent specifiers use English.
function strftimeImpl(r, a, wide) {
  const buffer = a(0),
    max = a(1) >>> 0,
    format = wide ? r.wideString(a(2)) : r.string(a(2)),
    tm = readTm(r, a(3));
  if (!buffer || !max) return ok(0, 4);
  const pad = (value, width) => String(value).padStart(width, '0');
  const hours12 = tm.hour % 12 === 0 ? 12 : tm.hour % 12;
  let output = '';
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') {
      if (output.length + 1 >= max) return ok(0, 4);
      output += format[i];
      continue;
    }
    const code = format[++i];
    const piece = () => {
      switch (code) {
        case 'a':
          return DAY_NAMES[((tm.wday % 7) + 7) % 7];
        case 'A':
          return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
            ((tm.wday % 7) + 7) % 7
          ];
        case 'b':
        case 'h':
          return MONTH_NAMES[((tm.mon % 12) + 12) % 12];
        case 'B':
          return [
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
          ][((tm.mon % 12) + 12) % 12];
        case 'c':
          return asctimeText(tm).trimEnd();
        case 'd':
          return pad(tm.mday, 2);
        case 'H':
          return pad(tm.hour, 2);
        case 'I':
          return pad(hours12, 2);
        case 'j':
          return pad(tm.yday + 1, 3);
        case 'm':
          return pad(tm.mon + 1, 2);
        case 'M':
          return pad(tm.min, 2);
        case 'p':
          return tm.hour < 12 ? 'AM' : 'PM';
        case 'S':
          return pad(tm.sec, 2);
        case 'U':
          return pad(Math.floor((tm.yday + 7 - tm.wday) / 7), 2);
        case 'w':
          return String(((tm.wday % 7) + 7) % 7);
        case 'W':
          return pad(Math.floor((tm.yday + 7 - ((tm.wday + 6) % 7)) / 7), 2);
        case 'x':
          return `${pad(tm.mon + 1, 2)}/${pad(tm.mday, 2)}/${pad(tm.year % 100, 2)}`;
        case 'X':
          return `${pad(tm.hour, 2)}:${pad(tm.min, 2)}:${pad(tm.sec, 2)}`;
        case 'y':
          return pad(((tm.year % 100) + 100) % 100, 2);
        case 'Y':
          return String(tm.year + 1900);
        case 'Z':
          return 'UTC';
        case 'z':
          return '+0000';
        case '%':
          return '%';
        default:
          return `%${code ?? ''}`;
      }
    };
    const text = piece();
    if (output.length + text.length >= max) return ok(0, 4);
    output += text;
  }
  writeText(r, buffer, output, max, wide);
  return ok(output.length, 4);
}
// The `_s` forms validate their arguments and write a NUL-terminated result.
function localtimeS(r, a, wide) {
  const destination = a(0),
    source = a(1);
  if (!destination || !source) return ok(EINVAL, 2);
  try {
    r.check(source, wide ? 8 : 4);
  } catch {
    return ok(EINVAL, 2);
  }
  const seconds = wide ? Number(r.view.getBigInt64(source, true)) : r.read32(source) | 0;
  writeTm(r, destination, tmFromMilliseconds(seconds * 1000));
  return ok(0, 2);
}
function gmtimeS(r, a, wide) {
  const destination = a(0),
    source = a(1);
  if (!destination || !source) return ok(EINVAL, 2);
  try {
    r.check(source, wide ? 8 : 4);
  } catch {
    return ok(EINVAL, 2);
  }
  const seconds = wide ? Number(r.view.getBigInt64(source, true)) : r.read32(source) | 0;
  writeTm(r, destination, tmFromMilliseconds(seconds * 1000));
  return ok(0, 2);
}
function ctimeS(r, a, wide) {
  const buffer = a(0),
    size = a(1) >>> 0,
    source = a(2);
  if (!buffer || size < 26) return ok(EINVAL, 3);
  try {
    r.check(buffer, size * (wide ? 2 : 1), true);
    if (source) r.check(source, wide ? 8 : 4);
  } catch {
    return ok(EINVAL, 3);
  }
  const seconds = !source
    ? guestSeconds(r)
    : wide
      ? Number(r.view.getBigInt64(source, true))
      : r.read32(source) | 0;
  writeText(r, buffer, asctimeText(tmFromMilliseconds(seconds * 1000)), size, wide);
  return ok(0, 3);
}
function asctimeS(r, a, wide) {
  const buffer = a(0),
    size = a(1) >>> 0,
    source = a(2);
  if (!buffer || size < 26 || !source) return ok(EINVAL, 3);
  try {
    r.check(buffer, size * (wide ? 2 : 1), true);
    r.check(source, TM_BYTES);
  } catch {
    return ok(EINVAL, 3);
  }
  writeText(r, buffer, asctimeText(readTm(r, source)), size, wide);
  return ok(0, 3);
}
// errno is one process-visible integer. `_errno()` hands back its address, which
// is how the CRT's own errno macro reaches it, and the accessors read/write the
// same cell.
function errnoCell(r, key) {
  r.msvcrtErrno ??= new Map();
  if (!r.msvcrtErrno.has(key)) r.msvcrtErrno.set(key, r.allocate(4, true));
  return r.msvcrtErrno.get(key);
}
function setErrno(r, a, key) {
  r.write32(errnoCell(r, key), a(0) | 0);
  return ok(0, 1);
}
function getErrno(r, a, key) {
  if (!a(0)) return ok(EINVAL, 1);
  r.check(a(0), 4, true);
  r.write32(a(0), r.read32(errnoCell(r, key)) | 0);
  return ok(0, 1);
}
// The bounded ("secure") string and memory functions. Each validates its
// arguments, writes a NUL-terminated result where the CRT does and reports the
// documented errno_t code, so a caller's error branch runs instead of the buffer
// being silently overrun.
function memcpyS(r, a, move) {
  const destination = a(0),
    destinationSize = a(1) >>> 0,
    source = a(2),
    count = a(3) >>> 0;
  if (!destination || destinationSize === 0) return ok(EINVAL, 4);
  r.check(destination, destinationSize, true);
  if (!source && count) {
    r.data.fill(0, destination, destination + destinationSize);
    return ok(EINVAL, 4);
  }
  if (count > destinationSize) {
    r.data.fill(0, destination, destination + destinationSize);
    return ok(ERANGE, 4);
  }
  try {
    r.check(source, count);
  } catch {
    r.data.fill(0, destination, destination + destinationSize);
    return ok(EINVAL, 4);
  }
  if (move) {
    const snapshot = r.data.slice(source, source + count);
    r.data.set(snapshot, destination);
  } else r.data.copyWithin(destination, source, source + count);
  // The CRT zeroes whatever follows the copied bytes, which is what makes the
  // call safe to use on a partially filled buffer.
  r.data.fill(0, destination + count, destination + destinationSize);
  return ok(0, 4);
}
function strcpyS(r, a) {
  const destination = a(0),
    destinationSize = a(1) >>> 0,
    source = a(2);
  if (!destination || destinationSize === 0) return ok(EINVAL, 3);
  r.check(destination, destinationSize, true);
  if (!source) {
    r.data[destination] = 0;
    return ok(EINVAL, 3);
  }
  const sourceText = ansiLength(r, (index) => (index === 0 ? source : 0)).result;
  if (sourceText + 1 > destinationSize) {
    r.data[destination] = 0;
    return ok(ERANGE, 3);
  }
  r.data.copyWithin(destination, source, source + sourceText + 1);
  return ok(0, 3);
}
function strncpyS(r, a) {
  const destination = a(0),
    destinationSize = a(1) >>> 0,
    source = a(2),
    count = a(3) | 0;
  if (!destination || destinationSize === 0) return ok(EINVAL, 4);
  r.check(destination, destinationSize, true);
  if (!source) {
    r.data[destination] = 0;
    return ok(EINVAL, 4);
  }
  const sourceText = ansiLength(r, (index) => (index === 0 ? source : 0)).result;
  const truncate = count === -1; // _TRUNCATE
  if (!truncate && count < 0) return ok(EINVAL, 4);
  const limit = truncate ? destinationSize - 1 : Math.min(count, destinationSize - 1);
  if (!truncate && count >= destinationSize && sourceText >= destinationSize) {
    r.data[destination] = 0;
    return ok(ERANGE, 4);
  }
  const copy = Math.min(sourceText, limit);
  r.data.copyWithin(destination, source, source + copy);
  r.data[destination + copy] = 0;
  if (truncate && sourceText > copy) return ok(STRUNCATE, 4);
  return ok(0, 4);
}
function strcatS(r, a) {
  const destination = a(0),
    destinationSize = a(1) >>> 0,
    source = a(2);
  if (!destination || destinationSize === 0) return ok(EINVAL, 3);
  r.check(destination, destinationSize, true);
  if (!source) {
    r.data[destination] = 0;
    return ok(EINVAL, 3);
  }
  const destinationText = ansiLength(r, a).result;
  const sourceText = ansiLength(r, (index) => (index === 0 ? source : 0)).result;
  if (destinationText + sourceText + 1 > destinationSize) {
    r.data[destination] = 0;
    return ok(ERANGE, 3);
  }
  r.data.copyWithin(destination + destinationText, source, source + sourceText + 1);
  return ok(0, 3);
}
function strncatS(r, a) {
  const destination = a(0),
    destinationSize = a(1) >>> 0,
    source = a(2),
    count = a(3) | 0;
  if (!destination || destinationSize === 0) return ok(EINVAL, 4);
  r.check(destination, destinationSize, true);
  if (!source && count) {
    r.data[destination] = 0;
    return ok(EINVAL, 4);
  }
  const destinationText = ansiLength(r, a).result;
  const sourceText = source ? ansiLength(r, (index) => (index === 0 ? source : 0)).result : 0;
  const truncate = count === -1;
  const room = destinationSize - destinationText - 1;
  const copy = truncate ? Math.min(sourceText, room) : Math.min(sourceText, count, room);
  if (!truncate && destinationText + copy + 1 > destinationSize) {
    r.data[destination] = 0;
    return ok(ERANGE, 4);
  }
  if (source) r.data.copyWithin(destination + destinationText, source, source + copy);
  r.data[destination + destinationText + copy] = 0;
  if (truncate && sourceText > copy) return ok(STRUNCATE, 4);
  return ok(0, 4);
}
// strtok_s keeps the scan position in a caller-owned context pointer, so
// successive calls continue one tokenization without CRT-global state.
function strtokS(r, a) {
  const string = a(0),
    delimiters = a(1),
    context = a(2);
  if (!delimiters || !context) return ok(0, 3);
  r.check(context, 4, true);
  if (!string) return ok(0, 3);
  const isDelimiter = (byte) => {
    for (let i = 0; ; i++) {
      const entry = r.data[delimiters + i];
      if (!entry) return false;
      if (entry === byte) return true;
    }
  };
  let cursor = string;
  while (r.data[cursor] && isDelimiter(r.data[cursor])) cursor++;
  if (!r.data[cursor]) {
    r.write32(context, 0);
    return ok(0, 3);
  }
  const start = cursor;
  while (r.data[cursor] && !isDelimiter(r.data[cursor])) cursor++;
  if (r.data[cursor]) {
    r.data[cursor] = 0;
    r.write32(context, cursor + 1);
  } else r.write32(context, 0);
  return ok(start, 3);
}
function strerrorS(r, a) {
  const buffer = a(0),
    size = a(1) >>> 0,
    code = a(2) | 0;
  if (!buffer || size === 0) return ok(EINVAL, 3);
  r.check(buffer, size, true);
  const text = code ? `Error ${code}` : 'No error';
  writeText(r, buffer, text, size, false);
  return ok(0, 3);
}
export function registerCrtTime() {
  const add = (name, handler) => {
    if (msvcrtApis[`msvcrt.dll!${name}`]) return;
    msvcrtApis[`msvcrt.dll!${name}`] = handler;
  };
  // time_t forms: the plain names alias the 32-bit ones on Win32.
  add('time', time32);
  add('_time32', time32);
  add('_time64', time64);
  add('localtime', (r, a) => localtimeImpl(r, a, false));
  add('_localtime32', (r, a) => localtimeImpl(r, a, false));
  add('_localtime64', (r, a) => localtimeImpl(r, a, true));
  add('gmtime', (r, a) => gmtimeImpl(r, a, false));
  add('_gmtime32', (r, a) => gmtimeImpl(r, a, false));
  add('_gmtime64', (r, a) => gmtimeImpl(r, a, true));
  add('mktime', (r, a) => mktimeImpl(r, a, false));
  add('_mktime32', (r, a) => mktimeImpl(r, a, false));
  add('_mktime64', (r, a) => mktimeImpl(r, a, true));
  add('_mkgmtime', (r, a) => mktimeImpl(r, a, false));
  add('_mkgmtime32', (r, a) => mktimeImpl(r, a, false));
  add('_mkgmtime64', (r, a) => mktimeImpl(r, a, true));
  add('ctime', (r, a) => ctimeImpl(r, a, false));
  add('_ctime32', (r, a) => ctimeImpl(r, a, false));
  add('_ctime64', (r, a) => ctimeImpl(r, a, true));
  add('asctime', (r, a) => asctimeImpl(r, a, false));
  // The wide string forms: _wctime/_wasctime write UTF-16 into the same
  // per-process buffer their ANSI twins use. _wctime32/_wctime64 differ only in
  // the width of the time argument, exactly like _ctime32/_ctime64.
  add('_wctime', (r, a) => ctimeImpl(r, a, true));
  add('_wctime32', (r, a) => ctimeImpl(r, a, true));
  add('_wctime64', (r, a) => ctimeImpl(r, a, true));
  add('_wasctime', (r, a) => asctimeImpl(r, a, true));
  add('difftime', difftimeImpl);
  add('_difftime32', difftimeImpl);
  add('_difftime64', difftimeImpl);
  add('clock', clockImpl);
  add('strftime', (r, a) => strftimeImpl(r, a, false));
  add('_strftime', (r, a) => strftimeImpl(r, a, false));
  // The bounded variants.
  add('localtime_s', (r, a) => localtimeS(r, a, false));
  add('_localtime32_s', (r, a) => localtimeS(r, a, false));
  add('_localtime64_s', (r, a) => localtimeS(r, a, true));
  add('gmtime_s', (r, a) => gmtimeS(r, a, false));
  add('_gmtime32_s', (r, a) => gmtimeS(r, a, false));
  add('_gmtime64_s', (r, a) => gmtimeS(r, a, true));
  add('ctime_s', (r, a) => ctimeS(r, a, false));
  add('_ctime32_s', (r, a) => ctimeS(r, a, false));
  add('_ctime64_s', (r, a) => ctimeS(r, a, true));
  add('asctime_s', (r, a) => asctimeS(r, a, false));
  // errno.
  add('_errno', (r) => ok(errnoCell(r, 'errno'), 0));
  add('_set_errno', (r, a) => setErrno(r, a, 'errno'));
  add('_get_errno', (r, a) => getErrno(r, a, 'errno'));
  add('__doserrno', (r) => ok(errnoCell(r, 'doserrno'), 0));
  add('_set_doserrno', (r, a) => setErrno(r, a, 'doserrno'));
  add('_get_doserrno', (r, a) => getErrno(r, a, 'doserrno'));
  // Bounded strings and memory.
  add('memcpy_s', (r, a) => memcpyS(r, a, false));
  add('memmove_s', (r, a) => memcpyS(r, a, true));
  add('strcpy_s', strcpyS);
  add('strncpy_s', strncpyS);
  add('strcat_s', strcatS);
  add('strncat_s', strncatS);
  add('strtok_s', strtokS);
  add('strerror_s', strerrorS);
}
registerCrtTime();
registerCrtExtended(msvcrtApis, {
  streamFor,
  standardStreams,
  writeStream,
});

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
// convention. The versioned runtimes need the same treatment: their decorated
// C++ names carry no `@<bytes>` suffix, so operator new reads exactly like a
// stdcall name while being cdecl. Data exports are not called at all;
// GetProcAddress returns their address through the dedicated path.
export const MSVCRT_CDECL = new Set();
for (const name of VERSIONED_CRT_CDECL_EXPORTS) {
  const key = `msvcrt.dll!${name}`;
  if (VERSIONED_CRT_DATA_EXPORTS.has(name)) continue;
  const handler = msvcrtApis[key];
  if (!handler) continue;
  MSVCRT_CDECL.add(key);
  msvcrtApis[key] = async (r, a) => {
    const response = await handler(r, a);
    return { ...response, convention: 'cdecl' };
  };
}
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
