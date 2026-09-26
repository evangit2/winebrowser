# Native window lookup fixture

The freestanding PE32 checks FindWindow and FindWindowEx A/W, class names and
atoms, null versus empty titles, hidden windows, direct child controls, sibling
order, activation, title changes and destruction. Nested controls are rendered
through separate client layers; browser checks cover geometry, ancestor state,
focus and cleanup. It counts WM_GETTEXT messages
to verify that lookup reads stored captions without invoking guest callbacks.
No application Wasm is supplied; the original x86 instructions run in the browser.

Rebuild with `npm run build:window-find`; `npm run test:window-find` runs the EXE
and a ZIP containing that EXE and companion files through the ordinary upload UI.
Evidence and the fixture hash go to `evidence/window-find-browser-results.json`.

Lookup covers windows in the current guest process. Message-only windows,
owned windows and SetWindowPos are not yet implemented. Topmost bands are covered
by the separate native popup fixture. Case
comparison uses non-expanding BMP mappings from the browser; exact Windows NLS
case tables remain unfinished. The no-match FindWindow result preserves last
error, as documented by Microsoft, rather than the pinned Wine ANSI wrapper's
ERROR_CANNOT_FIND_WND_CLASS behavior.

References: Microsoft [FindWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-findwindowa),
[FindWindowEx](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-findwindowexw),
and pinned Wine `dlls/user32/tests/win.c` / `dlls/win32u/window.c` stored-caption
and direct-sibling behavior.
