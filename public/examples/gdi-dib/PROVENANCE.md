# Native bitmap transfers

Original WineBrowser contributors C program, MIT.

MinGW compiles the authored Windows SDK client into PE32 x86 input. The
browser translates the unchanged executable to Wasm while it runs.
No application-specific precompiled Wasm or third-party binary is included.

Executable SHA-256: `fa3475b27dce7cf485b2858224d0ee297a9b9b2533c3b0568414ab43e4e76fa3`

Source SHA-256: `339454b7253f0322583f74373db4825477aa5be74861ac8b312f13234e65b180`

Source: `tests/fixtures/gdi-dib/client.c`; rebuild from the source archive
with `sh scripts/build-gdi-dib-fixture.sh` after installing i686 MinGW.
