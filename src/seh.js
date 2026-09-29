// i386 structured-exception delivery.
//
// Windows compilers implement __try/__except and _except_handler4 by building an
// exception registration chain anchored at fs:[0]. Each frame is `{ next,
// handler }` and the list ends at 0xffffffff. When a guest access faults, the
// kernel hands that chain an EXCEPTION_RECORD, the frame itself and a CONTEXT of
// the faulting thread, then calls each handler as cdecl with four arguments.
//
// This module builds those structures and walks the chain. It follows the
// documented i386 layouts (Wine's winnt.h records the same offsets) and is pure
// with respect to the guest: memory access and the handler call arrive as
// callbacks, so the walk can be unit-tested without a CPU.
//
// An empty chain is not an exception: the caller must treat the fault as genuine
// and stop the run, exactly as it did before. Delivering to a nonexistent handler
// would swallow real errors.

export const EXCEPTION_MAXIMUM_PARAMETERS = 15;
// EXCEPTION_RECORD = Code, Flags, ExceptionRecord, ExceptionAddress,
// NumberParameters (5 * 4) + 15 parameters * 4 = 80 bytes on i386.
export const EXCEPTION_RECORD_BYTES = 20 + EXCEPTION_MAXIMUM_PARAMETERS * 4;
// I386_CONTEXT = 0xcc bytes of registers plus 512 bytes of extended registers.
export const CONTEXT_BYTES = 0xcc + 512;
const CONTEXT_FLAGS =
  0x00010000 | 0x00010001 | 0x00010002 | 0x00010004 | 0x00010008 | 0x00010010;

// Register offsets inside I386_CONTEXT, from winnt.h's documented comments.
export const CONTEXT_OFFSETS = Object.freeze({
  ContextFlags: 0x00,
  Dr0: 0x04,
  Dr1: 0x08,
  Dr2: 0x0c,
  Dr3: 0x10,
  Dr6: 0x14,
  Dr7: 0x18,
  FloatSave: 0x1c,
  SegGs: 0x8c,
  SegFs: 0x90,
  SegEs: 0x94,
  SegDs: 0x98,
  Edi: 0x9c,
  Esi: 0xa0,
  Ebx: 0xa4,
  Edx: 0xa8,
  Ecx: 0xac,
  Eax: 0xb0,
  Ebp: 0xb4,
  Eip: 0xb8,
  SegCs: 0xbc,
  EFlags: 0xc0,
  Esp: 0xc4,
  SegSs: 0xc8,
});

const CHAIN_END = 0xffffffff;
const MAX_FRAMES = 64;

export const EXCEPTION_CODE = Object.freeze({
  BREAKPOINT: 0x80000003,
  ACCESS_VIOLATION: 0xc0000005,
  ILLEGAL_INSTRUCTION: 0xc000001d,
  INTEGER_DIVIDE_BY_ZERO: 0xc0000094,
  STACK_OVERFLOW: 0xc00000fd,
});

// The value a registered frame handler RETURNS is EXCEPTION_DISPOSITION, not
// the filter constants. Windows and Wine both define:
//   ExceptionContinueExecution 0  resume at the (repaired) context
//   ExceptionContinueSearch    1  the next frame decides
//   ExceptionNestedException   2  a nested exception is in progress
//   ExceptionCollidedUnwind    3  an unwind collided with this frame
export const ExceptionContinueExecution = 0;
export const ExceptionContinueSearch = 1;
export const ExceptionNestedException = 2;
export const ExceptionCollidedUnwind = 3;

/**
 * A guest access fault carrying the information exception delivery needs. It is
 * a distinct class so the dispatcher can tell "the emulator rejected a guest
 * access" apart from "the emulator itself failed", which must never be offered
 * to guest code.
 */
export class GuestFault extends Error {
  constructor(message, { code = EXCEPTION_CODE.ACCESS_VIOLATION, address = 0, write = false, size = 0 } = {}) {
    super(message);
    this.name = 'GuestFault';
    this.sehCode = code >>> 0;
    this.sehAddress = address >>> 0;
    this.sehWrite = !!write;
    this.sehSize = size >>> 0;
  }
}

/**
 * Signals that RtlUnwind was called and the guest stack must be unwound.
 *
 * `RtlUnwind` never returns to its caller; it walks the chain and resumes the
 * accepting frame. The runtime cannot do that from inside an API handler, so
 * the handler throws this signal and the dispatcher performs the walk.
 */
export class GuestUnwind extends Error {
  constructor({ endFrame, targetIp, retval, faultEip }) {
    super('Guest requested a structured unwind');
    this.name = 'GuestUnwind';
    this.endFrame = endFrame >>> 0;
    this.targetIp = targetIp >>> 0;
    this.retval = retval >>> 0;
    this.faultEip = faultEip >>> 0;
  }
}

/** True when an error may be offered to the guest exception chain. */
export function isGuestFault(error) {
  return (
    error instanceof GuestFault ||
    (error instanceof Error && Number.isInteger(error.sehCode) && Number.isInteger(error.sehAddress))
  );
}

/** Writes an EXCEPTION_RECORD at `pointer`. */
export function writeExceptionRecord(write32, pointer, { code, faultEip, faultAddress, write }) {
  write32(pointer, code >>> 0);
  write32(pointer + 4, 0); // ExceptionFlags: continuable.
  write32(pointer + 8, 0); // ExceptionRecord: no nested exception.
  write32(pointer + 12, faultEip >>> 0);
  write32(pointer + 16, 2); // NumberParameters.
  // ExceptionInformation[0] is 0 for a read and 1 for a write; [1] is the
  // faulting address. Later entries stay zero.
  write32(pointer + 20, write ? 1 : 0);
  write32(pointer + 24, faultAddress >>> 0);
  for (let i = 2; i < EXCEPTION_MAXIMUM_PARAMETERS; i++) write32(pointer + 20 + i * 4, 0);
}

/**
 * Writes an I386_CONTEXT describing `cpu` at the faulting instruction.
 *
 * The segment registers report the flat selector the emulator uses, and Esp
 * reports the faulting frame's stack so a handler that repairs the fault resumes
 * on the same stack.
 */
export function writeContext(write32, pointer, cpu, faultEip, fsBase) {
  for (let offset = 0; offset < CONTEXT_BYTES; offset += 4) write32(pointer + offset, 0);
  const set = (offset, value) => write32(pointer + offset, value >>> 0);
  set(CONTEXT_OFFSETS.ContextFlags, CONTEXT_FLAGS);
  set(CONTEXT_OFFSETS.Edi, cpu.r[7].value);
  set(CONTEXT_OFFSETS.Esi, cpu.r[6].value);
  set(CONTEXT_OFFSETS.Ebx, cpu.r[3].value);
  set(CONTEXT_OFFSETS.Edx, cpu.r[2].value);
  set(CONTEXT_OFFSETS.Ecx, cpu.r[1].value);
  set(CONTEXT_OFFSETS.Eax, cpu.r[0].value);
  set(CONTEXT_OFFSETS.Ebp, cpu.r[5].value);
  set(CONTEXT_OFFSETS.Eip, faultEip);
  set(CONTEXT_OFFSETS.Esp, cpu.r[4].value);
  set(CONTEXT_OFFSETS.SegFs, fsBase);
  set(CONTEXT_OFFSETS.SegCs, 0x1b);
  set(CONTEXT_OFFSETS.SegSs, 0x23);
  set(CONTEXT_OFFSETS.SegDs, 0x23);
  set(CONTEXT_OFFSETS.SegEs, 0x23);
  set(CONTEXT_OFFSETS.SegGs, 0x23);
  set(CONTEXT_OFFSETS.EFlags, 0x202);
}

/** Applies a CONTEXT a handler modified back onto the CPU register file. */
export function readContext(read32, pointer, cpu) {
  const get = (offset) => read32(pointer + offset) >>> 0;
  cpu.r[7].value = get(CONTEXT_OFFSETS.Edi) | 0;
  cpu.r[6].value = get(CONTEXT_OFFSETS.Esi) | 0;
  cpu.r[3].value = get(CONTEXT_OFFSETS.Ebx) | 0;
  cpu.r[2].value = get(CONTEXT_OFFSETS.Edx) | 0;
  cpu.r[1].value = get(CONTEXT_OFFSETS.Ecx) | 0;
  cpu.r[0].value = get(CONTEXT_OFFSETS.Eax) | 0;
  cpu.r[5].value = get(CONTEXT_OFFSETS.Ebp) | 0;
  cpu.r[4].value = get(CONTEXT_OFFSETS.Esp) | 0;
}

/**
 * Reads the exception registration chain from fs:[0], returning the frame links
 * up to the terminator. Exposed separately so the walk is inspectable.
 */
export function readRegistrationChain(read32, fsBase, limit = MAX_FRAMES) {
  const frames = [];
  let frame = read32((fsBase + 0) >>> 0) >>> 0;
  while (frame !== CHAIN_END && frame !== 0 && frames.length < limit) {
    const next = read32(frame) >>> 0;
    const handler = read32((frame + 4) >>> 0) >>> 0;
    frames.push({ frame, next, handler });
    if (next === frame) break; // A self-referential chain would never terminate.
    frame = next;
  }
  return frames;
}

// EXCEPTION_UNWINDING / EXCEPTION_EXIT_UNWIND, set on every record an unwind
// walk delivers so a handler can tell an unwind from a first-chance search.
export const EXCEPTION_UNWINDING = 0x2;
export const EXCEPTION_EXIT_UNWIND = 0x4;
// A record raised with this flag set may not be resumed with ContinueExecution.
export const EXCEPTION_NONCONTINUABLE = 0x1;

/**
 * Walks the registration chain from fs:[0] to `endFrame`, calling each handler
 * with EXCEPTION_UNWINDING set, then reports where the walk stopped.
 *
 * This is the i386 RtlUnwind contract (Wine's __regs_RtlUnwind records the same
 * behaviour): the handler return value is ignored except for
 * ExceptionCollidedUnwind, and the caller resumes at `targetIp` with the record
 * in EAX. Handlers invoked this way run their __finally bodies and pop their own
 * frames, which is why the walk reads each frame's `next` before calling it.
 *
 * The caller supplies the record so the same one the search used is delivered.
 */
export async function unwindExceptionChain({
  read32,
  write32,
  cpu,
  fsBase,
  allocate,
  callHandler,
  endFrame = 0,
  resumeEsp = 0,
  retval = 0,
  faultEip = 0,
}) {
  const chain = readRegistrationChain(read32, fsBase);
  const stop = endFrame >>> 0;
  const record = allocate(EXCEPTION_RECORD_BYTES);
  const context = allocate(CONTEXT_BYTES);
  if (!record || !context) throw Error('SEH unwind staging allocation failed');
  // A record with no search behind it is STATUS_UNWIND (0xc0000027), exactly
  // what RtlUnwind builds when its caller passes no record.
  writeExceptionRecord(write32, record, {
    code: 0xc0000027,
    faultEip,
    faultAddress: 0,
    write: false,
  });
  let delivered = 0;
  for (const entry of chain) {
    // The walk stops at the frame that accepted the exception: its own
    // __finally body is what RtlUnwind is leaving, so it is not re-entered.
    if (stop && entry.frame === stop) break;
    if (!entry.handler) continue;
    const flags = read32(record + 4) >>> 0;
    write32(record + 4, flags | EXCEPTION_UNWINDING | (stop ? 0 : EXCEPTION_EXIT_UNWIND));
    writeContext(write32, context, cpu, faultEip, fsBase);
    // A handler entered for unwinding runs on the caller's stack, which is
    // where control returns once RtlUnwind is done.
    write32(context + CONTEXT_OFFSETS.Esp, resumeEsp >>> 0);
    const action = await callHandler(entry.handler, [record, entry.frame, context, 0]);
    delivered++;
    if (![ExceptionContinueSearch, ExceptionCollidedUnwind].includes(action))
      throw Error('Invalid disposition from an unwind handler: ' + action);
  }
  cpu.r[0].value = retval | 0;
  return { delivered, frames: chain.length };
}

/**
 * Offers a fault to the registration chain at fs:[0].
 *
 * `callHandler(handler, [record, frame, context, dispatcher])` must invoke the
 * guest handler as cdecl and resolve to its return value. `allocate(bytes)`
 * supplies guest memory for the record and context.
 *
 * Returns `{ handled: true, resume, frames }` when a handler asked to continue
 * execution at the (possibly repaired) context EIP, `{ handled: false, frames }`
 * when every handler declined, and `{ handled: false, frames: 0 }` when no chain
 * exists — in which case the caller must stop the run.
 */
export async function deliverGuestException({
  read32,
  write32,
  cpu,
  fsBase,
  allocate,
  callHandler,
  fault,
}) {
  const frames = readRegistrationChain(read32, fsBase);
  if (!frames.some((entry) => entry.handler)) return { handled: false, frames: 0 };

  const record = allocate(EXCEPTION_RECORD_BYTES);
  const context = allocate(CONTEXT_BYTES);
  if (!record || !context) throw Error('SEH staging allocation failed');
  writeExceptionRecord(write32, record, {
    code: fault.sehCode,
    faultEip: fault.faultEip >>> 0,
    faultAddress: fault.sehAddress,
    write: fault.sehWrite,
  });

  for (const entry of frames) {
    if (!entry.handler) continue;
    writeContext(write32, context, cpu, fault.faultEip, fsBase);
    const action = await callHandler(entry.handler, [record, entry.frame, context, 0]);
    if (action === ExceptionContinueExecution) {
      const resume = read32((context + CONTEXT_OFFSETS.Eip) >>> 0) >>> 0;
      readContext(read32, context, cpu);
      return { handled: true, resume, frames: frames.length };
    }
  }
  return { handled: false, frames: frames.length };
}
