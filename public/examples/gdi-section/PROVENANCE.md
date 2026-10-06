# Native shared bitmap GUI

Original WineBrowser contributors C program, MIT.

MinGW compiles the authored Windows SDK client into PE32 x86 input. The
browser translates the unchanged EXE and DLL to Wasm while they run.
No application-specific precompiled Wasm or third-party binary is included.

Executable SHA-256: `3295a313a521e700b0c0892f7d7818fa14bc2714a65c436d1ac5f1e9570ec75c`

Native DLL SHA-256: `00ebea6a1e1a685f4b20fd6d5b370344d167dd480c023290b52581d2a8667faf`

Client source SHA-256: `1ff016433454c295448d6c669eb8df60ee9da4b305fe99cda4809db78ce52018`

Producer source SHA-256: `f22fdf5c5942ed7b1b348bc6d9517f12548618e5870dbb6d80ee25e6130255e1`

Sources: `tests/fixtures/gdi-section/client.c` and `producer.c`; rebuild from the source archive
with `sh scripts/build-gdi-section-fixture.sh` after installing i686 MinGW.
