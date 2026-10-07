# Native classic control GUI

Original WineBrowser contributors, MIT SDK client. Try pushed, checked, disabled,
flat, monochrome and transparent push buttons, checkboxes, three-state controls,
four scroll arrows and menu marks. **Holes** applies a complex clip. **Adjust**
marks the rectangles returned by DrawFrameControl in blue. **Reset** restores
the normal drawing. Close the window to finish.

Build: `sh scripts/build-frame-controls-fixture.sh`. The unchanged x86 EXE
translates into Wasm inside the browser, with actual Wine base DLLs.

The independently captured SDK probes normalize classic system colors and
restore the user's Wine colors afterward. `oracle.c` captures 311 API/pixel
cases; `gui-oracle.c` paints the same `layout.h` used by the client. Compile
them with MinGW i686 GCC and `-lgdi32`, then capture stdout on desktop Wine.
Their JSON references retain exact pixels, DC state and rectangle results.

WineBrowser's separate control geometry adapter derives from Wine under
LGPL-2.1-or-later. Its editable source and upstream notices are published at
`runtime/frame-controls/`. The original SDK client is MIT. Caption/radio controls,
menu bullets, size grips and complete Windows drawing compatibility remain
unfinished. This sample contains no third-party game assets or app Wasm.
