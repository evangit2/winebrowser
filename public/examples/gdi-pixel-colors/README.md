# Native bitmap color GUI

Original WineBrowser contributors, MIT. This unchanged Windows SDK PE32 client
compares pixel writes in RGB555, RGB565, RGB24, RGB32, indexed 8-bit,
monochrome and indexed 4-bit DIBs. **RGB**, **Palette**, **Indices** and
**Edges** show different input colors. **Clip** crops the swatches, and
**Reset** returns to RGB. Close the native window to finish.

Startup and each repaint assert native return values, LastError, GetPixel and
raw DIB bytes. The 217 independent desktop Wine snapshots include channel
truncation, bit replication, reserved alpha clearing, row padding, selected
logical-palette flags, direct DIB indices and out-of-range index handling.
Browser acceptance compares all drawing-area pixels in six stages in EXE,
ZIP and catalog modes. The browser translates x86 into Wasm during execution.
No precompiled application Wasm or third-party game assets are included.

Build: `sh scripts/build-gdi-pixel-colors-fixture.sh`.
Regenerate the captured expectations: `python3 scripts/generate-gdi-pixel-cases.py`.
`oracle.c` compiles with MinGW i686 GCC and `-lgdi32`; capture stdout on desktop
Wine to reproduce the evidence. The SDK client can validate its 217 cases and
clean up without opening a window by setting `WINEBROWSER_COLORS_CHECK=1`.
A further 93 native raw-byte cases in `bitfields-wine-oracle.json` cover 444,
332 and 10-bit channels. `bitfields-oracle.c` reproduces these captures.
These checks establish covered bitmap behavior; full Windows compatibility
remains unfinished.
