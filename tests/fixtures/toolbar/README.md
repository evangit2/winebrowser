# Native toolbar EXE and resource DLL

Original MIT PE32 x86 source by WineBrowser contributors, copyright 2026.
The DLL calls CreateToolbarEx with standard common-control images and adds
its own RT_BITMAP strip. Native TBBUTTON and TBBUTTONINFO calls exercise
data, state, A/W strings, geometry, insert/delete, hide and text changes.
The EXE unloads the DLL before browser interaction, then verifies actual
native command callbacks, checked groups and native shutdown.

The solid-color bitmap source is reproduced by the build script; it contains
no third-party or proprietary media. Wine standard icon assets used by the
runtime have separate LGPL source/notices in `public/runtime/toolbar/`.

Build with `npm run build:toolbar`; run Chromium acceptance with
`npm run test:toolbar`. This verifies supported horizontal toolbars, rather
than complete common-control or editor compatibility.
