# Native GUI controls

Copyright (c) 2026 WineBrowser contributors, MIT.

Original freestanding C source, compiled to a Windows PE32 x86 executable
with MinGW. The app calls USER32, COMCTL32, COMDLG32 and GDI32; its x86 code is
translated to WebAssembly inside the browser. No app-specific Wasm
artifact is included.

Executable SHA-256: `8c6ace2410127c6e68d1378fca6c7cd654336256400e5f450434356154699596`

C source SHA-256: `0db380917f395bdaf585a288964254e66afcb63d056ab21848cd3833a956fb07`

Source: `demos/gui-controls/` in the WineBrowser repository. The source
archive includes the standalone reproducible MinGW build script.
