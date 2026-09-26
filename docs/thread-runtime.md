# Guest threads

PE32 guest threads now run in the existing browser worker. `src/guest-threads.js`
schedules a shared CPU and translated-block cache, with private registers, flags,
XMM/MXCSR, supported x87 state, stack, TEB and last-error value for each thread.
Compiled FS operands read the active TEB through a mutable Wasm global. Guest
memory stays in one worker; a translated block never yields during a LOCK operation.
This provides interleaving, not execution on multiple host CPU cores.

Blocking event/thread waits, delays, host requests and window-message waits release
the CPU. Their JavaScript continuations resume only after the owning context and
guest call depth are restored. CPU-only loops yield at dispatcher checkpoints
every 2,048 blocks. Runnable threads are selected by base priority, with round-robin
ordering among equals. Dynamic priority boosts, affinity and scheduling classes
are not implemented. Module transactions and DLL notifications share a reentrant
loader lock across guest callbacks and suspension.

The ordinary upload path implements `CreateThread`, suspended creation,
`SuspendThread`/`ResumeThread`, identities, base priorities, exit codes,
`ExitThread`, thread-handle waits and `DisableThreadLibraryCalls`. Closing a thread
handle does not stop execution. Each worker receives existing static TLS templates
and thread attach/detach callbacks. Loading new static TLS modules while other
threads exist is explicitly unsupported. Ordinary dynamic `TlsAlloc` APIs remain
unfinished.

The optional source-built Wine path supplies `NtCreateThreadEx` with client-ID and
TEB output attributes, suspend/resume, thread queries, base priority and delay.
`NtAlertThreadByThreadId` and `NtWaitForAlertByThreadId` support Wine's contended
lock wait/wake path. `ThreadZeroTlsCell` clears the requested dynamic TLS index
across every live TEB. The new private `WineBrowserThreadAttach` export calls
Wine's actual FLS allocation, TLS allocation and DLL thread-attach routines.
Returning workers enter actual `RtlExitUserThread` and `LdrShutdownThread`, including
native FLS callbacks and DLL notifications. The complete Wine bridge still rejects
static TLS PE images; its dynamic TLS/FLS implementation remains Wine-owned.

Main-thread `ExitThread` keeps the process alive until the last worker exits.
Process exit from any thread cancels other contexts and unwinds their pending
JavaScript stacks before CPU, audio and window disposal. Worker faults propagate
to the process report instead of silently disappearing. Forced process termination
does not deliver worker DLL thread-detach notifications. Native `NtTerminateThread`
currently supports only self-termination. SEH, APC delivery, remote processes and
general cross-thread USER32 message ownership remain unfinished.

Allocation is bounded by the current 64 MiB guest arena and host heap. There are
at most 32 live thread records, with a minimum 64 KiB stack and maximum accepted
4 MiB requested stack size. Stacks use fixed committed storage; there is no
guard-page growth. These limits do not establish arbitrary Windows compatibility
or a near-native performance guarantee.

`tests/thread-context.test.js` checks real translated instructions with alternating
contexts, shared blocks, separate stack/TEB writes, SIMD/x87 state and flags.
`tests/guest-threads.test.js` checks real PE workers, priority ordering, joins,
independent static TLS, DLL callback ordering, alerts, output/access validation,
faults and cancellation cleanup. The [native fixtures](../tests/fixtures/threads/README.md)
add ordinary browser EXE/ZIP coverage and optional Wine Node/Chromium coverage,
including dynamic TLS/FLS and process shutdown. Reports are in
`evidence/threads-browser-results.json`, `evidence/threads-native-results.json`
and `evidence/threads-native-browser-results.json`.

Original Hamsterball now initializes two workers, creates its 800×600 window and
passes D3D8 display/depth queries. Chromium now creates its fullscreen device
and passes capability/viewport/transform setup and custom cursor loading before mapping the first texture file and stopping at the `IDirect3DDevice8.GetDirect3D`;
Node stops at creation without WebGPU.
See [presentation support](d3d-display.md). No game frame renders yet. The reference Theseus
`kernel32/thread.rs` uses host `std::thread::spawn`; this browser scheduler instead
uses the existing guest CPU and Wine's lifecycle routines.
