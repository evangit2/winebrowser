# Process-family synchronization

Each uploaded package run owns a shared kernel object namespace. Named events,
semaphores and mutexes opened by its parent, children or grandchildren refer to
the same objects. `Local\\` and unprefixed names resolve to the guest session;
`Global\\` names resolve to its global namespace. Global names still belong to
this upload run: independent runs and browser tabs cannot access each other's
objects. This provides synchronization between uploaded processes without host
OS handles or executable-specific behavior.

Each process retains a private handle table, access masks, inheritance flags and
waits. Signals dispatch across the process family. Automatic events release one
waiter; manual events release all eligible waiters; semaphore waits consume the
available counts. Wait-all acquires every object atomically. Event, semaphore
and mutex names share one typed namespace. Closing one process's handle does
not remove an object still referenced by another process, and exiting a parent
does not invalidate its child's open handles. Process disposal cancels its own
waits and releases its references. Stop discards the entire upload session.

Mutexes are owned by a guest thread, with recursive acquisition and a matching
number of releases. A different thread receives `ERROR_NOT_OWNER` on release.
Creating an existing mutex preserves its state and ignores initial ownership.
An owning thread exiting normally, through `TerminateThread`, or with its process
abandons the mutex. The next successful acquisition returns `WAIT_ABANDONED_0`
(plus the selected index for wait-any), transfers ownership and clears abandonment.
Ownership itself retains the object even if its last handle was closed.
Terminated waiters are cancelled before releasing their thread's ownership.

The NT bridge implements `NtCreateMutant`, `NtOpenMutant`, `NtReleaseMutant` and
`NtQueryMutant` basic/owner information. Win32 CreateMutex/Ex, OpenMutex A/W,
ReleaseMutex and SignalObjectAndWait share the same state. Query reports count,
caller ownership and abandonment using PE32 layouts. Mutation validates output
pointers first. Handle rights and generic access mapping follow the native
contracts. The object namespace remains bounded by the existing 4,096 handles
per process and 16 process records per session; recursive acquisition is bounded
to a signed 32-bit count. Duplicate semaphore/mutex aliases in wait-all are
explicitly rejected.

## Acceptance

`npm run build:process-sync` reproducibly builds the independent MIT PE32 fixture
against MinGW's Windows SDK headers. `npm run test:process-sync` uploads its ZIP
through the ordinary UI, verifies actual Wine KernelBase/NTDLL calls and checks:

- Parent/child event signaling, named semaphore counts and atomic mixed waits.
- Recursive mutex exclusion, type collisions and non-owner release errors.
- Native mutant query layout and output guards.
- Normal/forced thread exit and child-process abandonment.
- A surviving child acquiring its exiting parent's abandoned mutex.
- Main-thread exit while a worker thread waits for its mutex.
- Renamed executables in nested paths, Stop during a pending wait and fresh upload.
- Every process's exit code, exact PASS output and absence of browser errors.

The Pages deployment gate runs the same test on static hosting. Set
`WINEBROWSER_TEST_URL` to target the deployed site and `PROCESS_SYNC_EVIDENCE`
to choose a report path. The checked report is
`evidence/process-sync-browser-results.json`. Unit tests separately exercise
cross-process lifetimes, isolated upload namespaces, captured waiter ownership,
access errors, abandoned wait-any/all and cancellation.

This milestone does not add handle inheritance, pipes, shared memory sections,
cross-process registry/file locks, security descriptor evaluation or IPC between
independent uploads. Those remain separate compatibility work.

Contracts were checked against Microsoft's
[mutex objects](https://learn.microsoft.com/en-us/windows/win32/sync/mutex-objects),
[ReleaseMutex](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-releasemutex),
[WaitForMultipleObjects](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitformultipleobjects),
and Wine's `server/mutex.c`, `server/thread.c` and `dlls/ntdll/unix/sync.c` at
`db11d0fe6a169c457e23d007e20404643d067aa8`.
