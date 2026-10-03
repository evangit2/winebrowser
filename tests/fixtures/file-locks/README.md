# Native file-lock and completion-event fixture

MIT-authored PE32, linked only to Kernel32. Rebuild with
`npm run build:file-locks` (MinGW-w64); run `npm run test:file-locks` for EXE
and ZIP uploads through the published native Wine base. Set
`WINEBROWSER_TEST_URL` to test a static or live Pages deployment and
`WINEBROWSER_NORMAL_CHROMIUM=1` for ordinary visible Chromium.

The main thread locks eight bytes. A guest worker opens the same file and
blocks in Wine's LockFileEx until the main thread unlocks. The worker verifies
its completion event, reads the exact bytes with an OVERLAPPED whose event has
the low-bit completion-port suppression tag, verifies that event, unlocks and
returns its exit code. The main thread joins it and checks the result.

A second worker is terminated while parked on the same contended lock. The
owner immediately unlocks; the terminated request must neither acquire an
orphaned lock nor signal its event. The main thread verifies that the region
is available, closes handles, deletes the output file and exits cleanly.

These checks cover synchronous native file handles. They make no claim for
APCs, completion ports, cross-process locks or asynchronous file handles.
