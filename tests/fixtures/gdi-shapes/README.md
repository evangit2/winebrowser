# Native shape GUI

Original WineBrowser contributors, MIT. Unchanged Windows SDK PE32 code is
translated from x86 to Wasm inside the browser. Buttons choose alternate or
winding fills of a self-intersecting polygon, a polygon hole, a rounded
rectangle, an ellipse, or clipping with a copied polygon after deleting its
source region. Native GetPixel checks run before each completed stage.

Rebuild with `sh scripts/build-gdi-shapes-fixture.sh` using i686 MinGW.
The public source ZIP rebuilds the exact EXE; no proprietary assets are used.

`oracle.c` runs on desktop Wine 11.0 and captures actual SDK RGNDATA geometry.
`wine-oracle.json` records 289 cases: odd/even ellipses, rounded/reversed/negative
and degenerate inputs, random self-intersecting polygons with both fill rules,
nested polygons with both orientations, and the five displayed GUI shapes.
The browser checks 96,000 actual pixels per stage against this reference.

To reproduce the reference independently, compile and run on desktop Wine:

```
i686-w64-mingw32-gcc -O2 -Wall -Wextra -Werror -Wl,--no-insert-timestamp \
  tests/fixtures/gdi-shapes/oracle.c -o oracle.exe -lgdi32
WINEDEBUG=-all wine oracle.exe > oracle-output.json
```

Wine startup diagnostics can precede the JSON; retain the complete JSON array
and wrap it with the reference string used in `wine-oracle.json`. Identical
native oracle cases were reproduced across two runs. General window regions,
nonidentity XFORMs, full GDI mapping and universal DLL support remain unfinished.
