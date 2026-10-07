# Native bitmap icon GUI

Original WineBrowser contributors, MIT. This unchanged Windows SDK PE32
executable is translated from x86 to Wasm inside the browser.

Color/Alpha/Mono/Copy/Info/Clip buttons show normal, mask-only and image-only
channels. Color and monochrome masks can invert destination pixels. Alpha
icons blend their real source colors. Copy survives source destruction;
Info reconstructs an icon from independently owned GetIconInfo bitmap planes.
All original source HBITMAPs are deleted before creating the window. The
window caption also uses the actual alpha icon. Close to finish.

Rebuild with `sh scripts/build-icon-bitmap-fixture.sh` using i686 MinGW.
`oracle.c` runs actual desktop Wine 11 SDK CreateIconIndirect/CopyIcon/
CopyImage/GetIconInfo/DrawIconEx/GetPixel calls. Its 16 independent 4x4 pixel
snapshots include all mask/image channels, color/alpha/monochrome planes,
source deletion, resizing and an alpha-plane roundtrip. Compile with:

```
i686-w64-mingw32-gcc -Wall -Wextra -Werror \
  tests/fixtures/icon-bitmap/oracle.c -o oracle.exe -luser32 -lgdi32
WINEDEBUG=-all wine oracle.exe > oracle-output.json
```

Retain the JSON array after any Wine startup diagnostics, wrapped with the
reference string in wine-oracle.json. Browser acceptance checks every pixel
in the 480 by 180 drawing area in seven stages, in EXE/ZIP/catalog modes.

`bitmap-oracle.c` and its separate captured JSON verify color bitmap
resampling, monochrome copying, same-size alpha retention and resized-alpha
clearing through actual Wine CopyImage/GetDIBits. They rebuild with the same
MinGW/Wine commands as the main oracle.

Custom bitmap-created cursors, animated/flicker-brush icon drawing,
CopyImage monochrome/DIB-section/resource-reload flags and indexed color
source bitmaps remain unsupported. These checks do not prove universal DLL
support or native common-controls execution.
