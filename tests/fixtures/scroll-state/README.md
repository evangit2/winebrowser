# Native scrollbar state inspector

Original WineBrowser contributors, MIT Windows SDK client. Choose **Range**,
**Move**, **Page**, **Reverse**, **Limits**, **Legacy**, or **Callback** to inspect
the native minimum, maximum, page, position and track-position values.
**Normal** and **Reset** restore the defaults. Close the window to finish.

The unchanged x86 EXE translates into Wasm inside the browser using actual
Wine base DLLs. Build with `sh scripts/build-scroll-state-fixture.sh`.
The client asserts the native API replies and reads its displayed values
through GetScrollInfo. Callback exercises a compiled custom window procedure.

The SDK probes capture actual desktop Wine API behavior: `oracle.c` supplies
860 state/mask cases, `extra-handles.c` adds 170 validation cases, and
`callback.c` captures custom-control messages and replies. `extra.c` is the
earlier validation probe. Compile with MinGW i686 GCC and `-luser32`, run
on desktop Wine, and capture stdout. JSON references retain native values,
errors, structure contents and callback messages.

This inspector tests API state and custom message forwarding. Actual standard
scrollbar widgets, thumb tracking and universal Windows/DLL compatibility are
unfinished. This original sample includes no third-party game assets or app Wasm.
