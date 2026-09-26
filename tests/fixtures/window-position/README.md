# Native window positioning fixture

Build with `npm run build:window-position` (i686 MinGW); run the ordinary EXE and
ZIP upload checks with `npm run test:window-position`.

The unchanged PE executes its own window procedure in browser-translated x86.
It checks mutable WINDOWPOS callbacks, NCCALCSIZE, default MOVE/SIZE delivery,
NOSENDCHANGING, ignored geometry, FRAMECHANGED, suppressed default notifications,
and topmost transitions. Browser keyboard input then moves/resizes the window,
reorders overlapping bordered child controls, hides a child and activates a window
behind an explicit sibling. The browser checks geometry and DOM hit targets.

The host window model remains bounded to 1–1024 by 1–768 client pixels and one
GUI thread. Custom nonclient layout, WVR_VALIDRECTS/alignment, owner groups,
minimize/maximize state, full activation notifications and inter-thread placement
are unfinished. DEFERERASE/ASYNCWINDOWPOS/NOOWNERZORDER have no independent work
in this model. Unsupported custom nonclient behavior fails explicitly.
