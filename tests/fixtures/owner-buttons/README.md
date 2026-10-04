Project-authored MIT PE32 fixture; reproduce with `npm run build:owner-buttons`.

`npm run test:owner-buttons` uploads the unchanged executable into Chromium. Native ANSI/Unicode BS_OWNERDRAW buttons validate DRAWITEMSTRUCT, selected font and color HDC state, action/state flags and command ordering. Browser pixels verify held-pointer/focus/disabled painting, drag-out cancellation, Space/Enter, programmatic state/click, resizing and native exit zero. No proprietary application binary is included.

Fixed-style owner-drawn BUTTON support is implemented. Owner-drawn lists/menus, dynamic BM_SETSTYLE, exact pointer/nonclient behavior and universal GUI/DLL compatibility remain incomplete.
