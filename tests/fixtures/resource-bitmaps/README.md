# Native resource bitmaps

Original MIT Windows EXE and DLL. Bitmap files are generated from authored pixel
and palette data, embedded as RT_BITMAP resources, and loaded by native APIs.
The DLL's process-attach code runs in the browser. Native checks cover ordinal 8,
custom/default color maps, immutable resources, module unload and GDI lifetimes,
named/ordinal resources, indexed/CORE/monochrome/RGB24/bitfield DIBs and rendering.

Copyright (c) 2026 WineBrowser contributors. Licensed under the repository MIT
license. CMB_MASKED and predefined OEM system bitmaps remain unsupported.
