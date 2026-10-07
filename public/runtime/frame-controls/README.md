# Editable classic control adapter

`gdi-frame-controls.js` adapts Wine's classic `DrawFrameControl` geometry to
WineBrowser's raster/DC interfaces. It is LGPL-2.1-or-later, copyright 1997
Dimitrie O. Paun and Bertho A. Stultiens, with browser changes copyright 2026
WineBrowser contributors. `COPYING.LIB` retains the complete license.

`wine-uitools.c` is the complete upstream reference from Wine revision
`db11d0fe6a169c457e23d007e20404643d067aa8`. The original SDK client and native
capture probes are separate MIT sources under `tests/fixtures/frame-controls`.

To modify or replace the adapter, clone the complete source repository at
https://github.com/evangit2/winebrowser, edit `src/gdi-frame-controls.js`, run
`npm ci`, `npm test` and `npm run build`. `src/gdi-raster.js`, `src/gdi-paths.js`
and the `src/win32-gdi.js` integration remain available in that repository.
`python3 scripts/package-frame-controls.py` republishes the editable adapter
and source references. Vite bundles the source; no binary application patch
or external source compiler is required for running the unchanged Windows EXE.
