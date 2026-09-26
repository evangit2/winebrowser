# Native cursor fixture

This freestanding PE32 loads fourteen predefined system cursors through both A/W
entry points and checks stable handles, SetCursor's previous-handle result,
GetCursor while hidden, invalid handles, null selection, and nested ShowCursor
counts. It creates a real guest window with an IDC_HAND class cursor and handles
keyboard changes through its native window procedure.

Build with `npm run build:cursors`. `npm test` runs the EXE and checks its emitted
cursor sequence, parent overrides, class selection and mouse-capture behavior.
`npm run test:cursors` uploads the original EXE through the normal UI, sends
browser mouse/keyboard input, verifies the computed browser cursor, and closes
the native window cleanly. Results are in `evidence/cursors-browser-results.json`.

In the fixture, W selects wait, H decrements the display count, S increments it,
N selects a null cursor, and R restores the class hand cursor. Moving the mouse
keeps the native WM_SETCURSOR override until R clears it.

Cursor shapes use the browser's system theme, rather than Windows bitmap pixels;
IDC_UPARROW uses the directional n-resize cursor. Packaged custom cursor images,
named system resources, deprecated SIZE/ICON cursors and newer PIN/PERSON assets
remain unsupported. Client mouse input sends WM_SETCURSOR synchronously when
retrieved, unless mouse capture is active; ordinary PostMessage does not simulate
hardware movement. Browser window frames retain their own drag/resize cursors.

References: Microsoft [LoadCursor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-loadcursorw),
[WM_SETCURSOR](https://learn.microsoft.com/en-us/windows/win32/menurc/wm-setcursor),
and [ShowCursor](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showcursor).
Wine's `dlls/win32u/defwnd.c` at revision
`db11d0fe6a169c457e23d007e20404643d067aa8` supplies the parent/target-class behavior.
