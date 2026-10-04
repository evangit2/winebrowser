Authored native PE32 GUI fixture, reproducible with `npm run build:dialog-fonts`.
Source and binary are project test assets. No third-party application binary is included.

`npm run test:dialog-fonts` uploads the ordinary executable to Chromium. Its native code opens classic ANSI and extended Unicode resource dialogs and checks real `HFONT` attributes, initialization order, child font handles, mapped positions/client geometry and font destruction. A fontless resource checks default dialog units. A final modal dialog exercises browser presentation and native closure.

Font substitution uses the browser host's fonts at 96dpi. Exact Windows rasterization and per-monitor DPI are outside this fixture's scope.
