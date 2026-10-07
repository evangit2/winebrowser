# Native bitmap scaling GUI

Original WineBrowser contributors, MIT. This unchanged Windows SDK PE32 GUI
runs from an EXE or ZIP upload. Its x86 instructions compile to WebAssembly
inside the browser; the application has no prebuilt Wasm version.

Zoom, Mirror, Clip, Crop, Ink, Save, Clear and Shrink compare BLACKONWHITE,
WHITEONBLACK, COLORONCOLOR and HALFTONE bitmap transfers. The client checks
native raw alpha bytes, saved DC scaling modes and normal object cleanup.

Build: `sh scripts/build-gdi-stretch-fixture.sh` (MinGW i686 GCC).
Browser acceptance: `node scripts/test-gdi-stretch-browser.mjs`.
Native pixel oracles: compile the four `*-oracle.c`/`oracle.c` programs using
`i686-w64-mingw32-gcc -O1 -Wall -Wextra -Werror input.c -lgdi32 -o output.exe`,
then run on desktop Wine. Capture stdout JSON. The checked-in snapshots include
GetPixel colors and raw 32-bit destination DIB bytes.

The runtime implements uncompressed 1/4/8/16/24/32-bit DIB input, RGB and logical
palette tables, supported RGB bitfield masks, signed source/destination extents,
complex clips and eight source/destination raster operations. Compressed DIBs,
other raster operations and complete Windows/DLL compatibility remain unfinished.
