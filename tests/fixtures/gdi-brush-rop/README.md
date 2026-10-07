# Native brush raster GUI

Original WineBrowser contributors, MIT Windows SDK client. Select solid,
monochrome, or color brushes, opaque or transparent hatches, clipping with an
elliptical hole, and reversed extents. The sixteen tiles show all paint rules
that combine a brush and the pixels already in the window. Reset restores the
solid brush. Close the window to finish.

Build: `sh scripts/build-gdi-brush-rop-fixture.sh`. This is an ordinary PE32
executable; the browser translates its x86 instructions into WebAssembly during
execution. The source archive includes the complete deterministic native build.
No application Wasm or third-party game assets are included.

`oracle.c` independently captures 1,327 desktop Wine cases: all 256 ternary
raster truth tables, the sixteen valid brush/destination operations, native
API results, error retention, solid/color/mono/null brushes, transparent and
opaque hatches, reversed/empty/offscreen bounds and complex clips.
`gui-oracle.c` captures eight stages using the shared `layout.h` drawing inputs.
Build each probe with MinGW i686 GCC and `-luser32 -lgdi32`; capture stdout on
desktop Wine. All output pixels are retained as exact row runs in the JSON
references. Every GUI paint also checks that a source-dependent operation fails
atomically without changing LastError.

PatBlt has no source image. Source-dependent operations require other blit APIs;
this increment does not provide complete Windows GDI or DLL compatibility.
