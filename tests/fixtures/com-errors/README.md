# Native COM error-info ownership

Original WineBrowser contributors, MIT. `oracle.c` supplies two real test
IErrorInfo objects with reference counters, then records transfer, replacement,
reserved/null arguments, thread isolation and automatic thread-exit release.

Build with `i686-w64-mingw32-gcc -m32 oracle.c -o oracle.exe -loleaut32` and run
on native Wine. `wine-oracle.json` records 16 native observations. No test
executable is published. The runtime test calls actual guest COM vtable thunks
and uses a real scheduled guest thread, including its teardown.
