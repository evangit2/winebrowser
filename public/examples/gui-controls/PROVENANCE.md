# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `5f927ed745444f06348090e262565e578b399555bc69ed4f62cab91124fd4dc7`

C source SHA-256: `c27eeba0a62bfe694136aa07947596448f06ff22c3b6b18fbd9c0fd6cb22ad1a`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
