# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `464a98fb9959f43fcc5055be2d71e7449d474ca31fa821d7d66140ce28c3a812`

C source SHA-256: `2c704fedfe077608154b1c58a78cea6eb766392556f0c60c84e0b0b2fee9c58e`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
