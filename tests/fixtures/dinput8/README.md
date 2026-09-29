# Native DirectInput 8 initialization fixture

Build with `npm run build:dinput8` (i686 MinGW), test ordinary EXE/ZIP uploads
with `npm run test:dinput8`.

The original PE executes DirectInput 8 creation, version rejection, native
stdcall enumeration callbacks, filters and early stopping. It creates keyboard
and mouse objects, checks capabilities and device information, switches A/W
interfaces and checks shared IUnknown identity and reference counts.

This fixture covers initialization. Device formats, acquisition, immediate and
buffered input are tested separately by `npm run test:dinput-state`. Aggregation, joystick
and force-feedback devices, action maps and control panels are unfinished. The
runtime currently reserves at most 64 COM interface pointers (32 A/W pairs);
released pointers stay reserved to detect stale calls.

References: the DirectInput ABI and keyboard/mouse model in
`directwebgpu-wined3d/patches/theseus.patch` and its retained Theseus source; Wine
revision `db11d0fe6a169c457e23d007e20404643d067aa8`, `dlls/dinput/{ansi,dinput,device,mouse,keyboard}.c`;
Microsoft's [DirectInput 8 interface reference](<https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ee417799(v=vs.85)>).
No game-specific translated module is loaded.
