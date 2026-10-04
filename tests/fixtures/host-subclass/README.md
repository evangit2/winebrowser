# Native host-control subclasses

This original MIT Windows EXE and companion DLL install per-window subclasses
on ANSI/Unicode Edit, Button and ListBox controls. The EXE adds a forwarding layer
over the DLL. It tests callable original procedures, text and click vetoes,
native notifications, keyboard/Tab ownership, independent siblings, restoration,
destruction callbacks and invalid HWND handling. Build with
`npm run build:host-subclass`; run with `npm run test:host-subclass`.

Copyright (c) 2026 WineBrowser contributors. Licensed under the MIT license in
the repository root. This fixture establishes bounded native contracts, not
general Windows application or library compatibility.
