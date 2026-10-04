# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `d8866c9fd51dabcaada9c8494a08f255907cb1b15759013c1f59537cd7253545`

C source SHA-256: `b1ef0cd23adbcf75ad428b6a7070b06eebea6a70a6bcea63a303d8936d0e9cdb`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
