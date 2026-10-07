# Counted semaphore synchronization

WineBrowser implements native NtCreateSemaphore, NtOpenSemaphore,
NtReleaseSemaphore and NtQuerySemaphore, plus Win32 CreateSemaphore/Ex and
OpenSemaphore A/W and ReleaseSemaphore. Counts range from zero to a positive
signed 32-bit maximum. A successful wait consumes one count; release adds the
requested positive count and wakes only as many waiting guests as it permits.
Overflow and invalid output pointers leave the count and output unchanged.
Query returns the current and maximum counts. SignalObjectAndWait can release
a semaphore as its signal operation.

Semaphores participate in the same waits as events and thread handles. Wait-all
validates every handle and consumes state only when all objects are ready;
wait-any consumes only its selected object. Timeouts, closing a waited handle,
and runtime disposal use the existing waiter lifecycle. Repeated aliases of a
single semaphore in one wait-all are explicitly rejected before consumption.

Named semaphores share counts across NT and Win32 callers, same-process
DuplicateHandle aliases and uploaded processes in one family. Handles have independent query/modify/synchronize
rights and inheritance flags. The existing local/global guest object namespace
checks event/semaphore/mutex type collisions. The final handle close across the
family removes the name. Independent uploads remain isolated and security
descriptor evaluation remains unsupported. See [process synchronization](process-synchronization.md).

The native `tests/fixtures/threads/semaphore.c` fixture runs as both an ordinary
EXE and nested ZIP in Chromium, and through actual Wine Kernel32/KernelBase/
NTDLL in Node and Chromium. Three guest threads announce readiness, block on
one semaphore, and complete only as the main thread releases counts. The
fixture also checks overflow, named and duplicated aliases, restricted access,
close-before-use of an alias, mixed event/semaphore wait-all, signal-and-wait,
and final name removal. Unit tests cover NT query, invalid counts and buffers,
expired waiters, atomic failed waits, cancellation, and namespace collisions.

The original Microsoft HelloTriangle PE now passes its two native semaphore
creations and reaches `shell32.dll!CommandLineToArgvW` at 295,745 guest
instructions. No full Microsoft application frame has rendered yet. Its report
is `evidence/microsoft-d3d12-startup-browser.json`.

References: Microsoft's [ReleaseSemaphore](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-releasesemaphore)
and [CreateSemaphoreExW](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createsemaphoreexw),
and pinned Wine `dlls/ntdll/unix/sync.c`, `dlls/ntdll/tests/sync.c`, and
`server/semaphore.c` at `db11d0fe6a169c457e23d007e20404643d067aa8`.
