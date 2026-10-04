# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32, COMDLG32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `479e181a6ecb8990f947ad2b211280ea5ee90891fd5a956f321c1c936d9fc135`

C source SHA-256: `225604d15336e476d6b6cb828ee5194e7b373f89101f66b77578f1a3f546f8ec`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
