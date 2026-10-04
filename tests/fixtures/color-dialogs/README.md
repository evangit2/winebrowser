Authored native PE32 test executable, reproducible with `npm run build:color-dialogs`.

`npm run test:color-dialogs` uploads the unchanged fixture to Chromium. Native code checks A/W `CHOOSECOLOR` buffers, initial RGB, untouched cancellation, custom palette persistence on Cancel, column-order custom slots, owner disable/restore and registered `commdlg_ColorOK` selection veto. It also checks explicit errors for unsupported hooks. Browser acceptance verifies numeric RGB input, full-open/prevent-full-open presentation and Stop/replacement lifecycle.

Solid RGB selection is implemented. Native common-dialog HWNDs, hooks, templates, help and indexed-palette devices remain incomplete. This fixture is project-authored; no proprietary application binary is published.
