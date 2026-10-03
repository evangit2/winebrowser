# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `b1ca162ed96f13500c03565dfc2797e9b57de09f54264c45d4be959148070b36`

C source SHA-256: `c08b69134e4a96edc5424913775bc38af9801d67fb0454059b1ab7862a3f2811`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
