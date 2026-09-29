# Structured exception delivery

`src/seh.js` implements i386 structured-exception delivery. It is used when a
guest memory access faults: the runtime offers the fault to the exception
registration chain at `fs:[0]` before treating it as fatal.

## Structures

The layouts follow the documented i386 ABI, which Wine's `winnt.h` records with
the same offsets:

- `EXCEPTION_RECORD` (80 bytes) — `ExceptionCode`, `ExceptionFlags`, a nested
  record pointer, `ExceptionAddress`, `NumberParameters` and 15 parameter
  slots. For an access violation `ExceptionInformation[0]` is 0 for a read and
  1 for a write, and `[1]` is the faulting address.
- `I386_CONTEXT` (`0xcc` bytes plus 512 extended bytes) — `ContextFlags`, the
  debug registers, `FloatSave`, the four segment selectors, then `Edi`, `Esi`,
  `Ebx`, `Edx`, `Ecx`, `Eax`, `Ebp`, `Eip`, `SegCs`, `EFlags`, `Esp`, `SegSs`.
  The integer and control registers sit at the offsets `winnt.h` documents, and
  the module exports `CONTEXT_OFFSETS` so callers do not re-derive them.

## Search

A fault is delivered by walking the chain from `fs:[0]` to `0xffffffff`. Each
handler is called as cdecl with `(record, frame, context, dispatcher)`. A
handler returns an `EXCEPTION_DISPOSITION`:

| Return                       | Value | Meaning                                                                                        |
| ---------------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `ExceptionContinueExecution` | 0     | Resume at the context's (possibly repaired) `Eip`; the runtime applies the repaired registers. |
| `ExceptionContinueSearch`    | 1     | The next frame decides.                                                                        |
| `ExceptionNestedException`   | 2     | A nested exception is in progress; the search continues.                                       |
| `ExceptionCollidedUnwind`    | 3     | An unwind collided with this frame.                                                            |

The disposition enum is _not_ the filter enum. `EXCEPTION_EXECUTE_HANDLER` (1),
`EXCEPTION_CONTINUE_SEARCH` (0) and `EXCEPTION_CONTINUE_EXECUTION` (-1) are the
values a `__except` _filter expression_ returns; the compiler's frame handler
translates one into the other.

An empty chain, or one every handler declines, is reported as unhandled and the
fault stops the run exactly as before. A genuine emulator failure is never
offered to guest code at all: only a checked guest access violation becomes a
`GuestFault`.

## Unwind

`unwindExceptionChain` implements the i386 `RtlUnwind` walk. It builds a
`STATUS_UNWIND` record when the caller supplies none, sets `EXCEPTION_UNWINDING`
(and `EXCEPTION_EXIT_UNWIND` when no end frame is given) on every delivery, and
stops at `endFrame` — the frame whose own `__finally` body is running, which is
therefore not re-entered. The handler runs on the caller's resume stack, and
`retval` is placed in `EAX` when the walk completes, matching Wine's
`__regs_RtlUnwind`.

## Fault attribution

A translated block records the guest address of the instruction it is executing
in a Wasm global immediately before any checked memory access (an explicit
memory operand, or an implicit stack access). A fault therefore names the exact
instruction rather than the block's start. Register-only instructions do not
touch the global, so the common path pays nothing.

## Limits

Vectored exception handlers, `NtContinue`/`ZwContinue`, 64-bit exception paths
and C++ exception _objects_ are not implemented. A nested exception during a
handler runs the same search from the current chain head.
