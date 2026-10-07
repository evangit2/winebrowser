# Native scanline bitmap transfer GUI

Original WineBrowser contributors, MIT. This unchanged Windows SDK PE32 GUI
runs through EXE/ZIP upload and x86-to-Wasm compilation inside the browser.

Full, Partial, Start, Crop, Clip, Extra, Clear and Pixel compare bottom-up and
top-down 32-bit DIBs, padded 24-bit RGB and 16-bit 565 bitfields. The client checks
native return counts, raw alpha bytes, normal close and bitmap/DC cleanup.

Build: `sh scripts/build-gdi-transfer-fixture.sh` (MinGW i686 GCC).
Browser acceptance: `node scripts/test-gdi-transfer-browser.mjs`.
Native captures use the original `oracle.c`, `formats-oracle.c` and
`gui-oracle.c` SDK programs, compiled with
`i686-w64-mingw32-gcc -O1 -Wall -Wextra -Werror input.c -lgdi32 -o output.exe`.
Run on desktop Wine and capture stdout JSON. The complete source archive
contains deterministic client build instructions and all native snapshots.

The runtime implements uncompressed indexed/RGB/bitfield scanline transfers,
partial buffers, selected palettes, raw alpha, clipping and input snapshots
for aliasing. Compressed DIBs and universal Windows/DLL compatibility remain
unfinished.
