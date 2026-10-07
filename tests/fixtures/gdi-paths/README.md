# Native polygon and line GUI

Original WineBrowser contributors, MIT. This unchanged Windows SDK PE32
executable compiles from x86 to Wasm inside the browser.

Stars compares alternate/winding fills and independent line groups. Rings
compares nested contours with alternate, winding and opposite directions.
Clip applies a copied complex region with a hole. Lines compares normal and
clipped groups; Save compares before/saved/restored DC fill mode. Clear tests
empty groups. All three native 32 by 32 memory bitmaps scale to visible panels
through StretchBlt. Close to finish. An owned CreatePenIndirect descriptor
normalizes negative width and retains native LOGPEN metadata.

Rebuild with `sh scripts/build-gdi-paths-fixture.sh` using i686 MinGW.
`oracle.c` captures 112 actual desktop Wine 11 Polygon/PolyPolygon/PolyPolyline
RGB snapshots through GetPixel. They cover random self-intersections, both
fill rules, nested/opposite contours, complex clipping and reversed lines in
all eight directions, including clipped endpoint phase, outlined shapes and degenerate counts. Reproduce with:

```
i686-w64-mingw32-gcc -Wall -Wextra -Werror \
  tests/fixtures/gdi-paths/oracle.c -o oracle.exe -luser32 -lgdi32
WINEDEBUG=-all wine oracle.exe > oracle-output.json
```

Retain the JSON array after Wine diagnostics, wrapped with the reference in
wine-oracle.json. The separate metadata-oracle.c uses the same build command
and captures group validation, SetPolyFillMode and native LOGPEN layouts.
pen-color-oracle.c and its separate JSON compare 18 native color-flag cases
with default/selected logical palettes. LOGPEN keeps flags while actual strokes
resolve palette indices from the current DC, including out-of-range fallback.
Browser acceptance checks every pixel in the 480 by 180 drawing area across
seven stages in native EXE, ZIP and catalog modes. Units also check saved mode,
no partial painting after invalid later groups and independent pen ownership.

Path arrays have a 1,024-point budget. CreatePenIndirect currently implements
solid one-pixel and null pens. Wider/dashed pens and direct DIBINDEX colors fail explicitly. Polygon
fills and thin lines match the captured native cases; ellipse/arc drawing and
unimplemented DC mapping remain separate compatibility work. These checks do
not establish universal DLL or native common-controls execution.
