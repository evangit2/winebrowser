# Legacy Windows text APIs

Original MIT PE32 fixture for byte-preserving ANSI and UTF-16 string copies,
bounded copying and concatenation, character categories, CP1252/CP437 OEM
conversion with embedded NULs/in-place buffers, and the distinct five-argument
GetStringTypeA and four-argument GetStringTypeW calling conventions.

Copyright (c) 2026 WineBrowser contributors. Licensed under the repository's
MIT license. CT_CTYPE1 uses the browser Unicode tables and the bootstrap ACP;
other type families and locales remain explicit limits.
