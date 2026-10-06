Authored MIT native PE32 fixture; rebuild with `npm run build:monitor-popup`.

`npm run test:monitor-popup` uploads this unchanged executable into Chromium. Its Windows SDK structures and actual USER32, DXGI, D3D8 and D3D9 calls verify shared monitor identity, extended ANSI/Unicode monitor names, exact output layouts and guard bytes. Native display changes to 800×600 and 640×480 must update work-area queries and deliver WM_DISPLAYCHANGE; the fixture restores 1024×768 before exiting.

The real COMBOBOX and ComboLBox procedures verify upward popup placement, hover selection, held-arrow capture handoff with signed coordinates, release notification order, oversized-list clipping, native cancellation and unmatched Unicode edit restoration. Browser measurements independently check the visible popup bounds. F6 verifies native state while the popup or held pointer remains active; F7 sends native WM_CANCELMODE.

Native SystemParametersInfoA/W calls check Windows SDK action identifiers, scalar and mouse buffer guards, modern/XP NONCLIENTMETRICS and icon LOGFONT layouts. Mouse and keyboard-speed settings must round-trip, and the native window procedure must receive WM_SETTINGCHANGE.

Every native assertion, interface release and normal window destruction must pass for exit zero. This fixture contains no third-party binaries. Its acceptance covers one virtual monitor and vertical popup placement; multiple monitors, horizontal edge placement and complete DPI/theme behavior remain unfinished.
