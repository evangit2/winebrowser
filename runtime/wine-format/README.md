# Wine formatter guest DLL

`public/runtime/wine-format.dll` is a small x86 PE DLL containing the unchanged
Wine 11.0 formatter routines `wsprintfA/W` and `wvsprintfA/W` from
`dlls/user32/wsprintf.c`. The DLL is not full Wine or user32. It has no CRT
imports; its only imports are `IsDBCSLeadByte`, `MultiByteToWideChar`, and
`WideCharToMultiByte` from Kernel32. The Wine bodies use those Windows routines
for the same narrow/wide character conversions as upstream.

The source is pinned at Wine commit
`db11d0fe6a169c457e23d007e20404643d067aa8`, SHA-256
`e00663b26d1f8290afc1e6ad01a2c6e7d7d58170159701b0f8fea0916ed4d421`. The
complete LGPL 2.1 license text is retained in `COPYING.LIB`; the upstream
source includes its copyright and license notice. The debug header shim only
disables Wine TRACE logging and supplies Wine's `ARRAY_SIZE` macro; the formatter
function bodies are copied byte-for-byte.

Build with `python3 scripts/build-wine-format.py` and i686 MinGW GCC/binutils.
The freestanding `memcpy` helper removes the CRT dependency. GCC's `libgcc`
provides the 64-bit division/remainder helpers used for integer formatting;
these helpers are linked into the DLL, not imported. The build writes a hash
and import/export inventory to `runtime/wine-format/manifest.json`. For the
pinned i686 MinGW GCC 16.1.0 build, `__udivdi3` and `__umoddi3` are statically
linked from libgcc under GPL-3.0-or-later with the GCC Runtime Library
Exception 3.1. Both GCC notices (`COPYING3` and `COPYING.RUNTIME`) are retained
in `third_party/gcc/`, copied beside the component and into `public/runtime/`,
and hash-checked by the build script.

The source keeps Wine's Windows API declarations and calling-convention
macros. The MinGW build sets `WINUSERAPI` empty only so the four definitions
are not marked `dllimport`; `WINAPI` and `WINAPIV` remain intact, so the
`wvsprintf` exports are stdcall and the variadic `wsprintf` exports are cdecl.
The debug shim discards only TRACE output and defines Wine's equivalent
`ARRAY_SIZE` macro. Wine code still calls the guest Kernel32 character-conversion
functions; it does not replace those conversions with a local approximation.
