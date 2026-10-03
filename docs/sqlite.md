# Native SQLite DLL execution

The catalog includes SQLite 3.50.4's unchanged official Windows x86 DLL and an
MIT-authored PE32 client. Ordinary ZIP uploads, loose EXE/DLL uploads and the
catalog entry select the source-built Wine base before startup. The client
loads the supplied DLL with LoadLibrary/GetProcAddress and releases it when
the checks finish. Both programs compile from x86 to Wasm during browser
execution. No program-specific runtime path or SQL implementation is added.

The checks exercise in-memory SQL, transactional file writes, rollback,
Unicode text and blobs, competing writer connections, close/reopen and
PRAGMA integrity_check. The resulting 8 KiB database is independently read
using Python's native SQLite library. Evidence records translation and total
execution time for each upload path; these runs are not a general benchmark.

The upstream binary and source archives are pinned by SHA-256. The original
DLL is public domain; its dedication, unchanged amalgamation, original binary
archive and authored client source accompany the hosted ZIP. Rebuild the client
and package with `npm run build:sqlite`. Verify browser uploads using
`WINEBROWSER_NORMAL_CHROMIUM=1 npm run test:sqlite`, or supply
`WINEBROWSER_TEST_URL` for static/live Pages acceptance.

## Shared file behavior

- NtReadFile/NtWriteFile accept an opaque OVERLAPPED context for immediately
  completed synchronous positioned I/O when no APC routine is requested.
- NtLockFile/NtUnlockFile enforce shared/exclusive byte ranges using 64-bit
  offsets, including SQLite's locking regions beyond the end of the file.
  Exact handle/range matching is required to unlock. Closing an owner releases
  its locks. Waiting guest threads park until unlock or owner close; closing
  their handle fails the request, and terminating a parked thread cancels it.
  Completion events are signaled after the result is written. Both NT and host ReadFile/WriteFile enforce the same lock table.
- NtFlushBuffersFile validates the file and write rights. Writes already update
  the shared memory volume; the worker persists outputs after the process run.
- Native delete handles enforce DELETE access and delete sharing. Existing
  handles remain usable while deletion is pending, new opens fail, and the file
  is removed after the last handle closes. FileDispositionInformation can set
  or cancel the request. Deleting an actively mapped file is rejected.
- Deleted files are tombstones in the output result. They are removed from
  browser storage, and no empty journal download is created. The browser test
  seeds a stale journal, reruns the same upload and verifies its removal.

Legacy SSE half-vector moves preserve the unmodified 64-bit half and raw NaN
bits. Packed DWORD addition/subtraction wrap independently in each lane;
PSRLDQ/PSLLDQ shift all 128 bits with zero fill. CPU tests check aliasing,
unaligned half moves, aligned vector operands, flags and memory fault atomicity.
These instructions were reached by the original upstream DLL.

APC completion routines, WAL mode, background I/O,
cross-process access and crash durability remain unfinished or unverified.
The guest volume's existing file/total-size limits still apply.

Evidence: [Chromium results](../evidence/sqlite-browser-results.json).
Provenance: [upstream pins and licenses](../public/examples/sqlite/PROVENANCE.md).

Native threaded file/event evidence: [browser results](../evidence/file-locks-browser-results.json).
