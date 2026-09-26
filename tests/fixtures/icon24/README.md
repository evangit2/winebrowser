# Native 24-bit icon fixture

`generate.py` writes a deterministic 32x32 BGR icon with a transparent border.
The native PE32 loads its resource through LoadIconA/W, verifies the shared handle,
registers a class with that icon, creates a window and runs its message loop.
Closing the window exits the original x86 program normally.

Rebuild with `npm run build:icon24`. `npm run test:icon24` uses the ordinary EXE
upload UI and compares every titlebar-icon canvas pixel with an independent
expected RGBA pattern. Evidence includes the PE hash and rendered pixel hash.
Unit tests additionally check padded rows, non-byte-aligned masks, truncation and
group-header mismatches. PNG and other unimplemented icon formats still fail
explicitly.

References: Microsoft [BITMAPINFOHEADER](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader)
and [ICONINFO](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-iconinfo).
