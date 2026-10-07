# Native interactive scrollbar controls

Original WineBrowser contributors, MIT Windows SDK client. Click arrow buttons
or the track, drag a thumb, or focus a scrollbar and use arrow/page/Home/End keys.
The application handles native WM_HSCROLL/WM_VSCROLL messages and reads the full
track position from GetScrollInfo. **Limits** uses positions above 65535.
Try a full-page thumb and independently disabled arrows, then **Reset**.
Use **Disable** and **Enable** to change the actual window state. The application
checks IsWindowEnabled and WS_DISABLED; disabled controls reject browser input.
The DPI label reads GetDpiForWindow in the desktop's 96-DPI coordinate space.
Native captures also check invalid and destroyed handles and LastError.
The thumb-size label reads GetScrollBarInfo. The application checks its screen
rectangle, availability flags, thumb bounds, cbSize, and untouched reserved field.
Another 720 native query captures cover object IDs, malformed structure sizes,
visible/hidden controls, and enabled/disabled transitions. An additional 36
captures query geometry and pressed states during actual pointer callbacks.
Client queries forward SBM_GETSCROLLBARINFO to the original window procedure.

The unchanged PE32 EXE translates into Wasm inside the browser with native Wine
base DLLs. The source archive includes its deterministic MinGW build.
The native SDK captures cover API state, direct messages, legacy structures,
keyboard and pointer callbacks, 48 creation rectangles and 360 classic pixel cases. The pixel probe
runs with uxtheme disabled and a normalized palette restored on exit.
Another 120 native captures verify arrow flags, EnableWindow, WM_ENABLE and
redraw-dependent SetScrollInfo transitions for visible and hidden controls.

Nine standalone horizontal/vertical SCROLLBAR controls include top/bottom and
left/right alignment. The executable checks native window/client rectangles
and style bits. Aligned controls resize to the native 18-pixel cross thickness
while preserving the requested edge, and retain mouse and keyboard input.
Nonclient window scrollbars, size-box/size-grip styles, mouse auto-repeat,
complete subclass behavior and universal Windows/DLL compatibility are unfinished.
The original sample includes no third-party game assets or app Wasm.
The shared Wine frame painter retains LGPL-2.1-or-later sources and notices.
