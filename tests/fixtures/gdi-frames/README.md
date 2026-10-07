# Native frame and focus GUI

Original WineBrowser contributors, MIT. The unchanged Windows SDK PE32 EXE
is translated from x86 to Wasm inside the browser with actual Wine base DLLs.

Six buttons show a solid frame, an XOR focus outline, the outline drawn twice
to restore the background, a shifted transparent hatch frame, a copied color
pattern frame, or a frame/focus outline clipped to a region containing a hole.
The source pattern bitmap is deleted before creating the window. Native pixel,
selection, color and saved-origin assertions precede each completed title.

Rebuild with `sh scripts/build-gdi-frames-fixture.sh` using i686 MinGW. The
public source ZIP contains the exact client, build script, oracle and license.

`oracle.c` runs real desktop Wine SDK DrawFocusRect/FrameRect/GetPixel calls.
`wine-oracle.json` records 26 small full pixel cases, plus six GUI snapshots
as horizontal runs of pixels differing from the pastel background. All pixels
in the 480 by 180 drawing area are checked against those native snapshots.

```
i686-w64-mingw32-gcc -Wall -Wextra -Werror -O2 \
  tests/fixtures/gdi-frames/oracle.c -o oracle.exe -lgdi32 -luser32
WINEDEBUG=-all wine oracle.exe > oracle-output.json
```

Retain the complete JSON array after any Wine startup diagnostics. Separate
cases with `pixels` from GUI cases with `runs`, and wrap them with the reference
string in the saved oracle. No proprietary game assets are included. These
checks do not establish universal DLL support or nonidentity DC mapping.
