# Native window-query SDK client

Original WineBrowser contributors, MIT. Ordinary PE32 Windows SDK executable,
translated from unchanged x86 instructions to Wasm inside the browser. The
client calls real Wine base DLLs and browser window services.

Checks POINT-by-value stack arguments, parent client coordinates, exclusive
bounds, overlapping immediate children, independent invisible/disabled/transparent
skip flags, hierarchy and z-order, nested versus owned windows, and aliased
RECT copy/intersection/union/subtraction operations with an output guard.
Transparent native custom children verify the actual WM_PAINT callback sequence
(opaque back, transparent middle, transparent front) through the guest message
loop, BeginPaint and EndPaint.

Rebuild with `sh scripts/build-window-query-fixture.sh` using i686 MinGW.
There are no third-party game assets or application-specific Wasm builds.
