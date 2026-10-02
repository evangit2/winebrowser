# Native installer-service client

Original WineBrowser regression source under the repository's MIT license.
The small PE32 EXE imports the Windows services reported missing by the ATI
Treasure Chest installer. It contains no ATI executable or demo assets.

The client creates owned standard-control dialogs, runs a modal dialog to
`EndDialog`, traverses/reparents controls, checks palette bitmap pixels,
enumerates fonts through a native callback, expands an SZDD payload through
LZ32, resolves common-controls ordinal 17 and round-trips a selected package
folder through Shell32 and IMalloc.

Build: `sh scripts/build-installer-apis.sh`.
Acceptance: `node scripts/test-installer-apis-browser.mjs`.
The test packages a synthetic compressed file and folder alongside this EXE;
only successful guest checks produce `INSTALLER APIS PASS` and exit code 0.
