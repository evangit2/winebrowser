# Native window metadata fixture

The original PE32 exercises GetWindowLong/SetWindowLong A/W from WM_NCCREATE,
WM_CREATE and WM_NCDESTROY. Each window has independent userdata and twelve
extra bytes. Checks cover unaligned offsets, 32-bit pointer values, invalid
indices/handles, previous-value returns, last-error preservation, visibility,
native procedure addresses, instance handles and live child-control identifiers.

Build with `npm run build:window-data`; `npm run test:window-data` runs EXE and
ZIP uploads in Chromium. `npm test` also executes the original x86 fixture in
Node and checks invalid writes without mutating window state.

Metadata reads cover instance, parent, identifier, style, extended style and
userdata; writes cover instance, identifier, userdata and extra bytes. Native
same-encoding WNDPROC reads are available. Procedure replacement, cross-encoding
procedure handles, owner changes and style mutation remain explicit unsupported
operations. PE32 GetWindowLongPtr in Windows headers aliases these 32-bit APIs;
this does not implement PE32+ 64-bit window pointers.

References: Microsoft [GetWindowLongA](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowlonga)
and [SetWindowLongA](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowlonga),
plus pinned Wine `dlls/win32u/window.c` for extra-byte bounds and metadata lifetime.
