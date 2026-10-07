# Native nearest-color checks

Original WineBrowser contributors, MIT. Desktop Wine snapshots cover display
and memory DCs, default monochrome bitmaps, 555/565, 24/32-bit RGB, indexed and
monochrome DIBs. Default and selected logical palettes, flagged COLORREF values
and direct DIB palette indices are compared in 352 native cases.

`oracle.c` builds with MinGW i686 GCC and `-lgdi32`. Capture stdout on desktop
Wine. `native-cases.h` contains those independently captured expected values.
The freestanding native SDK client checks each result, preserved LastError and
normal object cleanup without linking a C runtime.

Build: `sh scripts/build-gdi-nearest-fixture.sh`.
The client remains an ordinary PE32 executable with x86 instructions.
