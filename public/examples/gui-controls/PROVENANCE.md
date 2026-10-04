# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32, COMDLG32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `6292e3fcb1d5b2f1cbf206eb140dd3c2fc100aa6f9f997a9c075e9b15d8f5ee7`

C source SHA-256: `c0a4c70d65e11c0357c94473d868a150aca13ac293e1a07de7282119c37bb88a`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
