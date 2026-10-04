# Native modeless Find/Replace dialogs

Original MIT Windows PE32 EXE and DLL, compiled with MinGW. The EXE exercises
FindTextA/W, ReplaceTextA, FINDREPLACE flags/buffer guards, Help, termination and
modeless owner input. The DLL provides a native hook that vetoes the first Find
Next and an ordinal Unicode RT_DIALOG template. The EXE subclasses that dialog
and forwards to its original callable host WNDPROC through CallWindowProcW.
Native replacement uses EM_SETSEL/EM_REPLACESEL to change actual owner edit text.
Native startup checks cover Unicode CreateDialog/DialogBox resource and memory
templates, EndDialog results, a Unicode-named DLL resource, SizeofResource/
LoadResource argument order and FreeResource data lifetime. A FindTextW dialog
uses caller-owned GlobalAlloc template memory, sends notifications and closes
without taking ownership of the allocation.

Build: `npm run build:find-dialogs`. Chromium acceptance:
`npm run test:find-dialogs`. Unit coverage also exercises ReplaceTextW output,
limits, flags, invalid layouts and invalid template-handle errors.

Copyright (c) 2026 WineBrowser contributors. Licensed under the repository MIT
license. This authored fixture verifies bounded native contracts; arbitrary
editors, all custom controls and exact Windows layout remain unverified.
