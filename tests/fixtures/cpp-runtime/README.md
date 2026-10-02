# Native Visual C++ runtime ABI client

This MIT-authored PE32 client imports MSVCP140, MSVCP140_1 and VCRUNTIME140,
then dynamically loads ConCRT140. The browser translates its original machine
code and the source-built Wine DLL code during execution.

Checks cover mutex ownership and failed try-lock semantics, independently
owned exception-message copies, 64-byte aligned allocation/deallocation
through native C++ thiscall virtual methods, mangled Concurrency::Alloc/Free
exports, reference balancing and clean process exit. The C++ runtime itself
retains its own ConCRT reference after the client releases its reference.

The same checks are exported from `cpp-client.dll`. A ZIP places this plugin
under `app/plugins/`, and `plugin-host.exe` imports only Kernel32. It loads the
plugin, executes the checks, unloads it and repeats. The regression requires
both passes and removal of the plugin and MSVCP140_1 after each release.
Wine-owned references keep MSVCP140 and ConCRT resident. DLL detach
callbacks can recursively release their dependencies without unmapping code
still executing in the outer cleanup.

Build the EXE and plugin with `sh scripts/build-cpp-runtime-fixture.sh`; verify an ordinary
upload with `WINEBROWSER_NORMAL_CHROMIUM=1 node scripts/test-cpp-runtime-browser.mjs`.
The fixture compiler creates temporary import libraries in ignored scratch
storage. No Microsoft runtime redistributables or game assets are included.

The native Wine libraries come from the same pinned, published source archive
as the base DLL closure. MSVCP140_2 is not supplied: its pinned Wine special-math
exports are stubs. Exception unwinding, general C++ application execution and
broader concurrency behavior remain separate compatibility work.
