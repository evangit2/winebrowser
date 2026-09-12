# Wine i386 dispatcher fixture

This repository-owned assembly DLL reproduces the Wine i386 syscall wrapper ABI for portable tests. It contains no Wine implementation, CRT, imports or TLS. Its dispatcher pointer starts at zero; the normal loader installs the host bridge before its real DllMain runs.

Rebuild with `bash scripts/build-wine-nt-fixture.sh` using MinGW i686. `tests/wine-nt.test.js` executes the resulting PE through the same loader and CPU as uploaded programs. It checks clocks, invalid pointers, virtual-memory lifecycle, stack cleanup, and rejection of an altered trampoline.

The separate optional installed-Wine probe executes the whole unmodified upstream DLL; this fixture is not presented as an independent Windows application.
