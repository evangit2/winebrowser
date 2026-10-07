# Native interactive scrollbar controls

Original WineBrowser contributors, MIT Windows SDK client. Click arrow buttons
or the track, drag a thumb, or focus a scrollbar and use arrow/page/Home/End keys.
The application handles native WM_HSCROLL/WM_VSCROLL messages and reads the full
track position from GetScrollInfo. **Limits** uses positions above 65535.
Try a full-page thumb and independently disabled arrows, then **Reset**.
Use **Disable** and **Enable** to change the actual window state. The application
checks IsWindowEnabled and WS_DISABLED; disabled controls reject browser input.

The unchanged PE32 EXE translates into Wasm inside the browser with native Wine
base DLLs. The source archive includes its deterministic MinGW build.
The native SDK captures cover API state, direct messages, legacy structures,
keyboard and pointer callbacks, and 240 classic pixel cases. The pixel probe
runs with uxtheme disabled and a normalized palette restored on exit.
Another 120 native captures verify arrow flags, EnableWindow, WM_ENABLE and
redraw-dependent SetScrollInfo transitions for visible and hidden controls.

Ordinary standalone horizontal/vertical SCROLLBAR controls are covered.
Nonclient window scrollbars, alignment/size-box styles, mouse auto-repeat,
complete subclass behavior and universal Windows/DLL compatibility are unfinished.
The original sample includes no third-party game assets or app Wasm.
The shared Wine frame painter retains LGPL-2.1-or-later sources and notices.
