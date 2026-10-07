# Native pattern GUI

Original WineBrowser contributors, MIT. This unchanged native Windows SDK
PE32 executable is translated from x86 to Wasm inside the browser.

Five buttons choose color tiles, monochrome tiles, a shifted indirect brush,
a shifted diagonal-cross hatch, or a patterned ellipse clip. The color and
monochrome source bitmaps are deleted before the window starts. Brush pixels
remain independent of their original source memory and handles. A standard
STATIC label also receives its actual patterned brush through the native
WM_CTLCOLORSTATIC procedure. Native GetPixel checks finish before each title.

The executable tests DDB WORD-aligned rows, LOGBRUSH source-handle provenance,
SaveDC/RestoreDC brush origins, transparent-mode monochrome foreground and
background colors, copied clip geometry and normal native object destruction.

Rebuild with `sh scripts/build-gdi-pattern-fixture.sh` using i686 MinGW.
The public source ZIP independently rebuilds the exact native EXE.

`oracle.c` captures actual desktop Wine 11.0 SDK tiles after deleting each
source bitmap. `wine-oracle.json` records color/mono/shifted brushes and all six
native hatch styles, including shifted diagonal-cross phase. Compile with:

```
i686-w64-mingw32-gcc -Wall -Wextra -Werror -O2 -Wl,--no-insert-timestamp \
  tests/fixtures/gdi-pattern/oracle.c -o oracle.exe -lgdi32 -luser32
WINEDEBUG=-all wine oracle.exe > oracle-output.json
```

Wine startup diagnostics can precede the JSON array. Retain that complete
array and wrap it with the reference string used by `wine-oracle.json`.
These checks do not establish nonidentity mapping, arbitrary raster operations,
DIB-pattern brush construction or universal Windows/DLL support.
