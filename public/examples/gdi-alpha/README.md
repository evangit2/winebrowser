# Native alpha blending GUI

Original WineBrowser contributors, MIT. This unchanged Windows SDK PE32
executable is translated from x86 to Wasm inside the browser.

Global compares constant opacity at 25%, 50% and 100%. Pixel adds each source
pixel's premultiplied alpha. Low compares opacity 1, 2 and 64 out of 255;
Clip applies a copied complex region with a hole; Zero and Full change all
three panels to the same opacity. Close to finish. The authored source
includes a deliberately non-premultiplied channel to probe native arithmetic.
Both msimg32 AlphaBlend and gdi32 GdiAlphaBlend draw actual pixels. A separate
native memory-destination assertion verifies RGB and reserved alpha bytes.

Rebuild with `sh scripts/build-gdi-alpha-fixture.sh` using i686 MinGW.
`oracle.c` captures 17 actual desktop Wine 11 AlphaBlend snapshots through
GetPixel and raw DIB memory, including both alpha modes, rounding boundaries,
nearest scaling and a complex clip. Reproduce with:

```
i686-w64-mingw32-gcc -Wall -Wextra -Werror \
  tests/fixtures/gdi-alpha/oracle.c -o oracle.exe -luser32 -lgdi32 -lmsimg32
WINEDEBUG=-all wine oracle.exe > oracle-output.json
```

Retain the JSON array after Wine startup diagnostics, wrapped with the source,
destination and reference fields in wine-oracle.json. Browser acceptance
checks every pixel in the 480 by 180 drawing area in seven stages in native
EXE, ZIP and catalog modes. Unit checks also verify raw destination alpha,
invalid geometry, overlap, source formats and no-paint cases.

Nonstandard 32-bit channel masks and per-pixel display sources remain
unsupported. Unreadable control background pixels fail explicitly. This
fixture does not establish universal DLL or native common-controls support.
