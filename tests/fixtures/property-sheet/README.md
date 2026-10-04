# Native property sheet acceptance

Copyright (c) 2026 WineBrowser contributors. MIT license, see the repository LICENSE.
These are authored freestanding PE32 Windows binaries, compiled reproducibly with
`npm run build:property-sheet`; their native x86 executes through browser translation.

The EXE loads `settings-pages.dll`. The DLL creates modal and modeless Unicode
property sheets using its own dialog resources. The browser acceptance checks
lazy page creation, retained edits, keyboard Tab navigation, native validation
vetoes for tab switching/Apply/Cancel, dirty state, modal result/owner restoration,
modeless result polling/destruction, and page release/reset callbacks. The EXE
checks the counters and exits zero. A separate unit test covers ANSI descriptors,
page handles, descriptor copies/reference counts, malformed data and unsupported
wizard styles. These fixtures do not establish arbitrary application compatibility.

The DLL also loads/saves the authored UTF16 `native-settings.ini` through native
profile APIs. It reopens settings, checks the saved BOM through ordinary ReadFile,
and the browser acceptance checks the exported Unicode text and preserved comment.
