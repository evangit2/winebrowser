Project-authored MIT PE32 fixture; rebuild with `npm run build:gdi-clipping`.

`npm run test:gdi-clipping` uploads this unchanged executable into Chromium and checks native complex-region return values, SaveDC/RestoreDC, clipped pixel access and actual rendered pixels. Unit coverage additionally checks lines, shapes, text, icons and destination blits against holes and temporary text clips. General region handles and transformed coordinate systems remain incomplete.
