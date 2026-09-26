# Native DirectInput state fixture

Build with `npm run build:dinput-state` (i686 MinGW); exercise ordinary EXE/ZIP
uploads with `npm run test:dinput-state`.

The original PE configures the standard keyboard and eight-button mouse layouts,
sets foreground cooperation, acquires devices and polls immediate and buffered
state. Playwright performs actual key presses/releases, an exact 24×12 mouse
movement, a right click and a -120 wheel change. The EXE checks those values and
buffered offsets/sequence ordering. Focusing the Stop button loses acquisition;
refocusing the client reacquires without a stuck B key. Native exit must be zero.

Unit tests also cover copied custom layouts, bounds and required/optional objects,
extended scan codes, buffer peek/flush/overflow, invalid reads preserving relative
movement, absolute mouse coordinates, cooperative-level failures, property rules
and input recorded before device creation. Unsupported methods still trap.

Current bounds are 1,024 layout objects, 65,536 output bytes and a 4,096-slot event
buffer (usable capacity is size minus one). Browser events are scoped to the
virtual desktop; background acquisition does not grant global operating-system
input. Leaving the browser/desktop loses acquisition for all devices. Exclusive
acquisition prevents competing guest devices and guest window input messages; it
does not lock the OS pointer. Pointer lock, gamepads, complete locale/media-key
coverage, non-position format aspects, EnumObjects/GetObjectInfo, additional
properties/action maps, force feedback and event-notification handles are unfinished.

The scan-code mapping reuses Hamsterball's browser adapter. ABI and event semantics
were checked against the retained DirectWebGPU/Theseus input code and Wine revision
`db11d0fe6a169c457e23d007e20404643d067aa8` (`dlls/dinput/device.c`, `keyboard.c`,
`mouse.c` and `data_formats.c`). No game-specific pretranslated module is used.
