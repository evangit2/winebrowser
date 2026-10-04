# Native GDI object queries and fonts

Original MIT Windows EXE and DLL. Native calls exercise the one-argument
CreateFontIndirectA/W calling convention inside the DLL, LOGFONT A/W fields,
CP1252 and Unicode faces, size probes, every short buffer size, untouched tails,
LOGPEN and solid/hatch LOGBRUSH layouts. The EXE selects and draws both fonts
after unloading the library. The browser acceptance checks actual glyph pixels.

Copyright (c) 2026 WineBrowser contributors. Licensed under the repository MIT
license. Browser font matching may substitute unavailable faces; rotated text,
explicit widths and full Windows font mapping remain incomplete.
