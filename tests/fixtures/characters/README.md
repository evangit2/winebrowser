# Native character conversion fixture

This freestanding PE32 imports all eight User32 `CharLower`, `CharUpper`,
`CharLowerBuff` and `CharUpperBuff` A/W exports. The bridge calls the corresponding
native KernelBase exports; the original Wine machine code and supplied NLS tables
perform the conversion. There is no JavaScript casing fallback.

Checks cover low-word character arguments, in-place pointer returns, ANSI CP1252,
BMP Latin/Greek/Cyrillic, a Deseret surrogate pair, a lone high surrogate,
null arguments, counted buffers containing NUL, and adjacent sentinel bytes.
The pinned non-linguistic Wine case table leaves U+0130 unchanged; the expected
bytes reflect that table rather than JavaScript's expanding lowercase operation.
A nonzero exit code identifies the failed C source line. The successful path uses
native Wine ExitProcess, DLL shutdown and NtTerminateProcess.

Build with `npm run build:characters`. The full test requires the optional Wine
base closure and NLS data; the public upload harness does not yet bundle those
components. Run `npm run probe:characters -- <wine-i386-directory> <nls-directory>
--report evidence/characters-startup.json`, adding `--browser` and using
`evidence/characters-startup-browser.json` for the isolated Chromium worker.
The launcher verifies the Wine/NLS hashes and current source-loader patch.

Primary references: [CharLowerW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-charlowerw),
[CharLowerBuffW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-charlowerbuffw),
and Wine 11's `dlls/kernelbase/string.c`, `dlls/kernelbase/locale.c` and
`nls/sortdefault.nls` at revision `db11d0fe6a169c457e23d007e20404643d067aa8`.
