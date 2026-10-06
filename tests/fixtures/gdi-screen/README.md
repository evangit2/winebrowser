Authored MIT native PE32 fixture; rebuild with `npm run build:gdi-screen`.

`npm run test:gdi-screen` uploads the unchanged executable into Chromium. Native Windows SDK constants check GetDeviceCaps on screen, window and compatible memory DCs, including pixel dimensions, true-color format, palette absence, DPI, refresh, clip/raster support and printer-only fields. Native screen clipping and EnumDisplayMonitors must agree with USER32.

The same retained screen DC paints and reads four colored corners at 1024×768, 800×600, 640×480 and restored 1024×768. The browser independently scans the full emitted GDI image at every stage: exact dimensions, four 8×8 colored corner squares, an opaque black center and exactly 256 colored pixels. F6 advances the native display mode. Native DC release, invalid-handle rejection and normal destruction must exit zero.

The GDI renderer uses 96-dpi RGBA8 backing pixels, including when the separate D3D virtual mode selects RGB565. Physical millimetres are nominal values derived from 96 dpi, not measurements of the host screen. Full DPI, printer devices, palette/color-management behavior and mapping transforms remain unfinished. No third-party binaries are included.
