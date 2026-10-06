Authored MIT native PE32 fixture; rebuild with `npm run build:combo-pointer`.

`npm run test:combo-pointer` uploads this unchanged executable into Chromium. Its actual COMBOBOX, ComboLBox and EDIT subclasses call the original procedures. F6 verifies native state while a popup or held pointer remains active; clicking a verification button would dismiss the popup before those assertions could run.

Checks cover F4 list capture and hover without selection notifications; outside restoration; held arrow pressed state; host-to-list capture and coordinate handoff; dragged selection and release notification order; arrow release leaving the popup open; F7 native cancel mode; unmatched editable Unicode text restoration without edit notifications; and ordinary simple combo selection. A final rapid drag performs no intermediate selection/capture waits. All stage assertions and normal destruction must pass for exit zero. The fixture contains no third-party binaries.
