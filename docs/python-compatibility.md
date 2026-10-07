# Original Windows Python in WineBrowser

The official, unchanged CPython 3.8.10 Win32 embeddable ZIP now executes a
verified workload in ordinary Chromium. Python and its companion native DLLs
remain original x86 binaries; WineBrowser translates executed x86 blocks to
WebAssembly inside the browser. The distribution is downloaded to ignored
`.cache/` for testing and is not included in the public repository or Pages.

`npm run test:python` checks seven original `.pyd` extensions with decimal
arithmetic, Unicode normalization, XML/Expat callbacks, bzip2/LZMA/zlib round
trips, and SQLite transactions, rollback, reopening and integrity checks.
Both calculated results and the saved SQLite database bytes match native Wine.

`npm run test:python-ffi` checks `_ctypes.pyd` and `libffi-7.dll` against native
Wine results. Original SQLite calls a dynamically generated x86 callback that
reenters Python for each selected row. The native Wine CRT executes `qsort`
and repeatedly calls another generated comparison callback. Pointer arguments,
output pointers, callback cookies, integer returns and independent DLL calls
are exercised.

The runtime changes these applications required are general services:

- Standard-output/stderr handle duplication preserves inherited attributes,
  reduced rights and independent lifetimes. Closed handles stop accepting writes.
- Console-mode detection on redirected output returns the captured native NT
  access failure without changing the caller's buffers.
- COM error-info references transfer through the calling thread, retain/release
  real guest objects, and are released on normal thread/process teardown.
  ProgID lookup reads the guest's class registry and uses COM task allocation.
- Executable VM allocation, commit, protection, decommit and release update CPU
  execution ranges and invalidate affected translations. New callbacks can run
  immediately; freed/reused addresses cannot execute stale translated code.

Evidence: `evidence/python-browser-results.json` and
`evidence/python-ffi-browser-results.json`. The static dependency audit in
`evidence/python-import-audit.json` records the earlier baseline, before the
ctypes COM exports were implemented. Native reference sources and captures
are in `tests/fixtures/python`, `tests/fixtures/standard-output` and
`tests/fixtures/com-errors`.

These checks do not establish arbitrary Python package or Windows compatibility.
OpenSSL still needs event-source imports, SSL needs Crypt32 certificate services,
and sockets need additional Winsock/IP Helper services. Standard input, ordinary
file/pipe handle duplication, native cross-process socket duplication, 64-bit
Windows binaries and many other application families remain unfinished. Cold
startup/translation still take tens of seconds, beyond the requested seconds
performance target. The overall arbitrary-application goal remains active.
