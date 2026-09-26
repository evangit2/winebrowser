# Duplicate kernel handles

`NtDuplicateObject` and Win32 `DuplicateHandle` now duplicate same-process
thread, event and object-directory handles. A current-thread pseudo-handle
becomes an ordinary independently closeable handle to that specific thread.
Aliases retain shared signal state and thread identity, with independent access
and inheritance. Closing one alias does not stop the thread or invalidate others.
A duplicated main-thread handle becomes signaled when the main thread exits
while workers remain, allowing a worker to wait for it and read its exit code.

Both SAME_ACCESS and native SAME_ATTRIBUTES are supported; Win32 exposes only
CLOSE_SOURCE/SAME_ACCESS. Explicit rights are mapped for the object type and
limited to the source's granted rights; rights elevation requiring a security
access check is not implemented. Thread query/set access includes its limited-
information equivalent. Inheritance is recorded; process creation/inheritance
is a separate unsupported capability. CLOSE_SOURCE closes recognized real
source handles even if duplication fails. A null target with CLOSE_SOURCE
performs a close-only operation and ignores output/access/attribute parameters.

The target process must be the current-process pseudo-handle. Real process
handles, cross-process duplication, tokens, files, sections, registry handles,
protect-from-close attributes and null-output duplication are not implemented.
They fail explicitly. File duplication will require sharing a file-position
object; copying a handle record would be incorrect.

Unit tests cover event alias state, access checks, reference counts, current-
thread conversion/signaling, generic/implied rights and failure/close semantics.
Native fixtures execute DuplicateHandle through both the ordinary browser
provider and real Wine KernelBase/NTDLL in Node and Chromium. They close the
original worker handle, join the duplicate, check event access/state, and wait
for a duplicated main-thread handle after main-thread ExitThread. They run with
`scripts/test-threads-browser.mjs` and `scripts/test-threads-native.mjs`.

The unchanged Microsoft HelloTriangle EXE now passes current-thread duplication
and next stops at `NtCreateSemaphore` in its native MinGW runtime. It still has
no rendered application frame.

Sources: Microsoft's [Nt/ZwDuplicateObject](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-zwduplicateobject),
[DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle),
and the pinned Wine `server/thread.c` access mapping.
