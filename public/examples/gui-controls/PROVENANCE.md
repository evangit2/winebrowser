# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32, COMDLG32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `d280ab25820e0fba18f923421d75a971787f1a4c9919fb53f907749b78510f4b`

C source SHA-256: `7b7a12086355648d64d39feb7bd976c0a0a5f118f3220e986667024901d610a9`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
