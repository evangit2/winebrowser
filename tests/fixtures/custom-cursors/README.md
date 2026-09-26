# Native resource cursor fixture

`npm run build:custom-cursors` generates CUR files, compiles their resource table
and builds a freestanding PE32 EXE plus resource-only DLL. All images are generated
by `generate.py`. `npm run test:custom-cursors` uploads both files and a ZIP through
the normal UI and checks decoded cursor pixels, hotspots, selection and visibility.

Keys 1–8 select monochrome, 4-bit, 8-bit, 24-bit, alpha, multi-size, blank and
upscaled cursor resources. D selects the DLL's cursor; H/S hide/show, N selects
null, R restores the window-class cursor, and Escape exits. Resource handles are
shared; the program does not try to destroy them. See [scope](../../../docs/custom-cursors.md).
