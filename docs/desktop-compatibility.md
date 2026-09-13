# Desktop compatibility expansion

Independent desktop targets drive this work. The hash-pinned wesmar Tetris release now passes the checked browser gameplay sequence in `npm run test:tetris`; the exact run is recorded in [`evidence/tetris-browser.json`](../evidence/tetris-browser.json). This exercises ordinary runtime services without executable-name branches, but establishes compatibility only for this binary and path. Minesweeper remains blocked by 32 unresolved imports (see [`tests/targets.json`](../tests/targets.json)).

## Offscreen GDI drawing

`src/win32-gdi.js` supports memory DCs, compatible bitmaps, bitmap selection/restoration and deletion, and `BitBlt(SRCCOPY)`. Each memory DC starts with a monochrome 1×1 bitmap, as on Windows. Color bitmaps created against window/display DCs have separate pixel storage. A bitmap can be selected into only one memory DC at a time; applications must restore the old bitmap before deleting a selected bitmap. Deleting a memory DC releases its selection without deleting the application's bitmap.

Copies clip against the destination and preserve source pixels when source and destination overlap. Unsupported raster operations fail explicitly. There are no mapping-mode transforms, general clip regions, palettes, or bitmap-resource loading yet. Existing per-window framebuffers use the same drawing path.

The current shape/text subset also includes one-pixel `PS_SOLID` pens with `MoveToEx`/`LineTo`, the six hatch brushes, `SetBkMode`, `CreateFontA/W`, and `TextOutA/W`. Text glyph masks are rasterized by the worker's `OffscreenCanvas` and composited into the same DC surfaces; repeated label rasterization uses a bounded per-worker cache. Browser font matching may substitute faces and metrics vary with installed fonts. Font width, rotation, nondefault precision/pitch options, text alignment/transforms, other pen styles/widths, and font enumeration are unsupported. TextOut fails when the Canvas backend is unavailable, and `GetDC` does not expose GDI pixels for DOM-backed child controls. ANSI text currently uses Windows-1252.

## Registry storage

`src/win32-registry.js` supplies process-local keys and typed value bytes through the six Unicode registry calls used by the independent target: create, open, query, set, delete and close. Names are case-insensitive. Querying a value's size and retrying with a larger buffer follow the Windows status/byte-count contract. Tests cover missing keys, permissions, invalid handles, exact values, short buffers and deletion.

The virtual registry starts empty and is process-local; values do not persist between runs. It does not expose the host's registry or user configuration. Registry notifications, security descriptors, WOW64 views and the ANSI entry points remain unsupported.

## Message and text boundaries

`src/win32-accelerators.js` owns process-local ACCEL tables. Translation matches keyboard/character messages and modifiers, then synchronously calls the application's WndProc with WM_COMMAND. Modifier state follows dequeued keyboard messages; a later browser key-up cannot retroactively change an earlier shortcut. Resource accelerator tables, window menus and WM_SYSCOMMAND routing remain unsupported.

`src/win32-window-text.js` converts synchronous WM_SETTEXT/WM_GETTEXT messages between ANSI callers and Unicode window procedures, or the reverse. The WndProc retains control over the returned text. The bootstrap ANSI code page is Windows-1252; `src/encoding.js` owns its conversion map. MultiByteToWideChar also handles explicit UTF-8, including invalid-input errors, size queries and UTF-16 surrogate pairs. This does not provide full Windows locale, keyboard layout or IME support.

## Wine guest formatting

The old JavaScript wvsprintfW subset is replaced by a guest call into Wine 11.0's unchanged formatter bodies. `src/win32-format.js` only adapts the x86 caller's stack to Wine's `va_list` entry point and preserves cdecl versus stdcall cleanup. The first formatting call loads `wine-format.dll` through the existing PE module graph. The browser downloads and verifies the pinned component before loading a package. Direct Runtime consumers must supply the component in their package or `builtinFiles` map.

The component and rebuild instructions are in [`runtime/wine-format`](../runtime/wine-format/README.md). It retains Wine's LGPL source plus the licenses for linked GCC integer arithmetic helpers. Tests exercise integer boundaries, precision, alignment, ANSI/Unicode strings, 64-bit varargs, output limits, relocation and caller stack cleanup. No formatter source is compiled in the browser; the native DLL's instructions execute through the x86-to-Wasm translator.

The Tetris window uses browser-provided font matching, so font faces and metrics may differ from Windows. Shell icon extraction is not implemented; the tested path can run without displaying the game's requested icon. These results do not amount to arbitrary application support.

Contracts were checked against Microsoft's [BitBlt](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt), [accelerator translation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-translateacceleratora), and [registry query](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regqueryvalueexw) documentation, and Wine's pinned formatter source. Each passing case is evidence for that behavior only.

`GetWindowTextLength` retains the WndProc's reported size. Windows explicitly permits this size to overestimate the converted text length for mixed ANSI/Unicode calls; use the copied count from GetWindowText when an exact count is needed.
