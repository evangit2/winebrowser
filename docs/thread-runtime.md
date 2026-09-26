# Thread context groundwork

Hamsterball's current startup boundary is native Wine `NtCreateThreadEx`.
The call requests a suspended thread in the current process. Thread creation
is still unsupported; no successful thread handle is fabricated.

The runtime now provides two prerequisites for implementing it:

- `CPU.captureContext()` and `restoreContext()` isolate the eight general
  registers, arithmetic/auxiliary/direction/control flags, FS base, eight XMM
  registers and MXCSR, and the supported x87 registers/tags/control/status.
  Snapshots own their data. The dispatcher retains the instruction pointer;
  memory, translated blocks and instruction accounting remain process-wide.
  Existing host-driven guest callbacks use the same context preservation.
- `initializeThreadLayout()` initializes a separately allocated TEB and Wine
  debug block with stack bounds, process/thread identities, self/PEB pointers,
  optional syscall dispatcher, activation stack and Unicode scratch storage.
  It checks the ranges before writing and leaves the PEB/main TEB intact.
  It does not allocate stacks, initialize TLS or deliver DLL notifications.

FS memory operands previously embedded the TEB address at translation time.
That would direct a second thread into the first thread's storage when it reused
a block. The Wasm block ABI now imports a mutable FS-base global after the eight
general registers. Scalar/SIMD/x87 memory lowering and FS-prefixed MOVS use that
global. LEA retains its normal segment-independent address calculation. Executing
a cached block that requires FS with no active TEB fails before execution.

`tests/thread-context.test.js` alternates two contexts while running actual
translated instructions. It checks shared block identity, separate stacks and
TEB writes, x87 arithmetic results, XMM state, flags, independent forward/backward
string copies, process-wide instruction accounting and initialization failure
without partial writes. Existing callback tests cover both return and fault
restoration. These tests do not establish concurrent guest-thread execution.

The next integration needs a scheduler that owns each context and suspended API
call, per-thread last-error/TLS state, thread handles and waits, suspend/resume,
exit, and Wine's actual thread attach/detach path. Host callbacks and nested DLL
operations must resume on the owning context. Awaiting a host promise cannot
leave another context using its registers or stack. Process shutdown must cancel
pending waits and stop other contexts before disposing CPU/audio/window state.

The DirectWebGPU/Theseus reference's `kernel32/thread.rs` supplies useful TEB and
stack structure, but uses host `std::thread::spawn` and ignores creation flags.
It cannot be copied as a browser scheduler. The pinned Wine loader's
`thread_attach()` and shutdown routines supply the DLL ordering requirements.
General guest threads and broad application compatibility remain unfinished.
