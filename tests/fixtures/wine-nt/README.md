# Wine i386 dispatcher fixture

This repository-owned assembly DLL reproduces the Wine i386 syscall wrapper ABI for portable tests, including both the shared-trampoline form and `call fs:[0xc0]` (`TEB.WOW32Reserved`) form. It contains no Wine implementation, CRT, imports or TLS. Its dispatcher pointer starts at zero; the normal loader installs the host bridge and the TEB dispatcher slot before its real DllMain runs.

Rebuild with `bash scripts/build-wine-nt-fixture.sh` using MinGW i686. `tests/wine-nt.test.js` executes the resulting PE through the same loader and CPU as uploaded programs. It checks clock and virtual-memory services, dispatch through both entry forms, invalid pointers, stack cleanup, native process termination, and rejection of altered or occupied dispatcher slots.

The separate optional installed-Wine probe executes the whole unmodified upstream DLL; this fixture is not presented as an independent Windows application.

Termination checks verify that a null process handle leaves the sole calling
thread running, an invalid handle returns `STATUS_INVALID_HANDLE`, and the
current-process pseudo-handle ends guest execution with the requested status.
Separate TLS runtime tests verify clean process detach, recursion, unload during
detach, repeated shutdown, and abrupt termination without cleanup callbacks.
