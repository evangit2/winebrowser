# First guest Wine component

`public/runtime/shell32.dll` exports **CommandLineToArgvW only**. It is an x86 PE DLL dynamically loaded and relocated by the same loader as application DLLs. Its body is extracted unchanged from Wine 11.0 `dlls/shcore/main.c`, commit `db11d0fe6a169c457e23d007e20404643d067aa8`. Wine's upstream implementation lives in SHCORE; this subset exports the Windows-visible Shell32 entry point directly.

This is not a full shell32/shcore or Wine distribution. Its six Kernel32 imports use the explicit browser host provider: allocation, free, error state, module filename, UTF-16 length and copy. There is no generated-argument special case: the compiled Wine parser executes for every call and handles quoting/backslashes in guest code.

Rebuild with `python3 scripts/build-wine-library.py` using MinGW i686. The complete original source and LGPL 2.1 text are retained in `third_party/wine/`; the extracted translation unit and DEF are here. You can modify the C function, rebuild with the compiler command in the script, and replace the DLL. Update `runtime/wine/manifest.json` to its new SHA-256 so the worker's integrity check accepts the replacement. For an unmodified extraction, running the script reproduces the DLL and manifest. The script regenerates the translation unit, so change the upstream input for durable edits.

Only scalar compilation and no CRT are selected; no function body is rewritten to accommodate the translator. Compiler-emitted instruction gaps are fixed in the CPU, with independent tests. The separately downloaded winapiexec 1.2 x86 application is the first third-party caller.
