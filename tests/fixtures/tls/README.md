# PE static TLS fixtures

The C and DEF sources in this directory were written for this repository and
are released under the MIT License in `LICENSE`. They build tiny freestanding
x86 PE images with native TLS templates, callback arrays, and a DLL entry
point. `app.exe` checks callback ordering and reads and changes its TLS value
independently of `tls.dll`. On process detach, `tls.dll` writes its observed
callback and entry-point event sequence to stdout through imported
`GetStdHandle` and `WriteFile` calls.

The original fixtures were also run with Wine 11.0 from a fresh working copy
and an isolated prefix, using `WINEDEBUG=-all wine app.exe`. It exited with
code 0 and wrote exactly `TLS events:12349678\r\n` to stdout (hex
`544c53206576656e74733a31323334393637380d0a`). Wine ran the EXE attach TLS
callback but did not run its process-detach TLS callback; the DLL's two
process-detach callbacks ran before its `DllMain` detach entry. The JSON
record in `evidence/tls-native-wine.json` preserves the command, result, and
fixture hashes.

Rebuild the checked-in binaries with `scripts/build-tls-fixtures.sh`. The build
requires an i686 MinGW-w64 compiler, dlltool, and strip.
