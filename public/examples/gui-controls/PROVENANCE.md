# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `826e04e035cdb07689eb2b846fea6ba898eefd288749e18ae50fa6f350c98577`

C source SHA-256: `3bfe319d3f750af605b106ad8e57029f7182b9264725f24a9141e84903b3c545`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
