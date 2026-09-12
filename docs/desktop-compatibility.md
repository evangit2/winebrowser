# Desktop compatibility expansion

Independent desktop targets drive this work. The hash-pinned wesmar Tetris release still needs standard child controls, more GDI rendering, and shell/module services before it can run. Resolving an import does not establish that the game works. The new services below have separate behavioral tests and run through the ordinary runtime provider; none branches on an executable name.

## Offscreen GDI drawing

`src/win32-gdi.js` supports memory DCs, compatible bitmaps, bitmap selection/restoration and deletion, and `BitBlt(SRCCOPY)`. Each memory DC starts with a monochrome 1×1 bitmap, as on Windows. Color bitmaps created against window/display DCs have separate pixel storage. A bitmap can be selected into only one memory DC at a time; applications must restore the old bitmap before deleting a selected bitmap. Deleting a memory DC releases its selection without deleting the application's bitmap.

Copies clip against the destination and preserve source pixels when source and destination overlap. Unsupported raster operations fail explicitly. There are no mapping-mode transforms, general clip regions, palettes, or bitmap-resource loading yet. Existing per-window framebuffers use the same drawing path.

## Registry storage

`src/win32-registry.js` supplies process-local keys and typed value bytes through the six Unicode registry calls used by the independent target: create, open, query, set, delete and close. Names are case-insensitive. Querying a value's size and retrying with a larger buffer follow the Windows status/byte-count contract. Tests cover missing keys, permissions, invalid handles, exact values, short buffers and deletion.

The virtual registry starts empty and is not persisted between runs. It does not expose the host's registry or user configuration. Registry notifications, security descriptors, WOW64 views and the ANSI entry points remain unsupported.

## Message and text boundaries

`src/win32-accelerators.js` owns process-local ACCEL tables. Translation matches keyboard/character messages and modifiers, then synchronously calls the application's WndProc with WM_COMMAND. Modifier state follows dequeued keyboard messages; a later browser key-up cannot retroactively change an earlier shortcut. Resource accelerator tables, window menus and WM_SYSCOMMAND routing remain unsupported.

`src/win32-window-text.js` converts synchronous WM_SETTEXT/WM_GETTEXT messages between ANSI callers and Unicode window procedures, or the reverse. The WndProc retains control over the returned text. The bootstrap ANSI code page is Windows-1252; `src/encoding.js` owns its conversion map. MultiByteToWideChar also handles explicit UTF-8, including invalid-input errors, size queries and UTF-16 surrogate pairs. This does not provide full Windows locale, keyboard layout or IME support.

## Wine guest formatting

The old JavaScript wvsprintfW subset is replaced by a guest call into Wine 11.0's unchanged formatter bodies. `src/win32-format.js` only adapts the x86 caller's stack to Wine's `va_list` entry point and preserves cdecl versus stdcall cleanup. The first formatting call loads `wine-format.dll` through the existing PE module graph. The browser downloads and verifies the pinned component before loading a package. Direct Runtime consumers must supply the component in their package or `builtinFiles` map.

The component and rebuild instructions are in [`runtime/wine-format`](../runtime/wine-format/README.md). It retains Wine's LGPL source plus the licenses for linked GCC integer arithmetic helpers. Tests exercise integer boundaries, precision, alignment, ANSI/Unicode strings, 64-bit varargs, output limits, relocation and caller stack cleanup. No formatter source is compiled in the browser; the native DLL's instructions execute through the x86-to-Wasm translator.

Contracts were checked against Microsoft's [BitBlt](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt), [accelerator translation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-translateacceleratora), and [registry query](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regqueryvalueexw) documentation, and Wine's pinned formatter source. Each passing case is evidence for that behavior only.

`GetWindowTextLength` retains the WndProc's reported size. Windows explicitly permits this size to overestimate the converted text length for mixed ANSI/Unicode calls; use the copied count from GetWindowText when an exact count is needed.
