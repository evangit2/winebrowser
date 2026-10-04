# Native GDI object queries and fonts

Original MIT Windows EXE and DLL. Native calls exercise the one-argument
CreateFontIndirectA/W calling convention inside the DLL, LOGFONT A/W fields,
CP1252 and Unicode faces, size probes, every short buffer size, untouched tails,
LOGPEN and solid/hatch LOGBRUSH layouts. The EXE selects and draws both fonts
after unloading the library. The browser acceptance checks actual glyph pixels.
Native width calls through the DLL check the four-argument ABI, proportional
integer/fractional advances, A/W ABC field layout, CP1252 Euro equivalence and
untouched output tails. TEXTMETRIC A/W checks read the selected font styles and
charset through native structures.

Copyright (c) 2026 WineBrowser contributors. Licensed under the repository MIT
license. Browser font matching may substitute unavailable faces; rotated text,
explicit widths and full Windows font mapping remain incomplete.
