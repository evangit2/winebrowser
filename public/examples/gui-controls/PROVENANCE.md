# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32, COMDLG32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `9f13170634e62ce5dcb6c9ec92c862bbc964009a1165ec59ff37ab7292576a39`

C source SHA-256: `08cd63279ede501c97542ad7dd3a27d9d175056edc8f14a825319f2190257722`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
