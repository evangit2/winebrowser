# Native event synchronization fixture

`npm run build:events` builds unchanged PE32 programs using MinGW i686.
`npm run test:events` uploads the ordinary EXE and a ZIP with companion files,
and verifies exit code zero in Chromium. The native program tests automatic and
manual reset events, A/W named aliases, local/global namespaces, restricted
handles, WaitAny/WaitAll, finite timeouts, signal-and-wait, pulse, close and
last-handle name deletion. Signal consumption is checked by subsequent zero-time
waits rather than by inspecting implementation state.

To run the same contract through real Wine DLLs, plus `NtQueryEvent`, previous
signal state, ANSI/Unicode module lookup and `RtlGetActiveActivationContext`:

```sh
node scripts/test-events-native.mjs "$WINEBROWSER_WINE_DIR" "$WINEBROWSER_NLS_DIR"
node scripts/test-events-native.mjs "$WINEBROWSER_WINE_DIR" "$WINEBROWSER_NLS_DIR" --browser
```

The native checks use the integrity-checked optional Wine/NLS closure from
`loadWineProbeInputs`, including the source-built loader. They run original
KernelBase event functions and NTDLL syscall wrappers. The ordinary upload
fixture needs no Wine DLL closure. Both paths share the same event objects.
Evidence is recorded in `evidence/events-browser-results.json` and
`evidence/events-native{,-browser}-results.json`.

`tests/sync-objects.test.js` additionally verifies genuinely pending waits,
manual broadcast versus automatic single-waiter release, signal coalescing,
WaitAll atomic consumption, relative and absolute deadlines, a late signal
after a stalled timer, access failures, and cancellation on close/disposal.
Guest CPU calls await host signals/timeouts without polling or blocking the
worker's JavaScript event loop.

This implementation supports event handles only. Names and Local/Global aliases
are isolated to one guest process; custom ACLs, cross-process sharing, mutexes,
semaphores, waitable timers, APC delivery and guest thread creation remain
unfinished. The virtual NT directories are `\BaseNamedObjects` and the current
session's `BaseNamedObjects`. Limits are 4096 live synchronization handles, 4096
pending waits and 64 handles per wait. Handles are not recycled during a run.
Closing a handle with a pending wait cancels that wait with INVALID_HANDLE;
Windows documents closing such a handle as undefined. Runtime disposal cancels
all pending waits and clears their timers.

The TEB now contains the activation-context stack/list and 261-WCHAR scratch
buffer that Wine's host allocator normally initializes. These are per-thread
storage, not replacement implementations of Wine's activation or NLS code.
The native fixture checks actual guest queries and named module resolution.

The event/reset and multi-wait semantics follow Microsoft's
[event object contract](https://learn.microsoft.com/en-us/windows/win32/sync/event-objects)
and [wait contract](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitformultipleobjects),
with the pinned Wine NT adapter source used to verify PE32 layouts and status codes.
