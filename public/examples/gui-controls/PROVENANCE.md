# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `670977f821806409551dd6efaaf5f2aed84484a0f0b07a67d3fec65882ad40d2`

C source SHA-256: `74f0d9b814f94c64252e1cffc655e08b7890b3ff01d791f0587cf0ce380181ea`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
