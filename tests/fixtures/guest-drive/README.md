# Native guest drive GUI

Original WineBrowser contributors, MIT. These Windows SDK clients are ordinary
PE32 x86 executables. WineBrowser translates their unchanged machine code into
WebAssembly inside the browser during execution; they have no bespoke Wasm build.

Use **Write 8 KiB**, **Resize to 4 KiB**, and **Delete file** to change a real guest
file. The GUI queries free capacity after each operation and checks each change
in guest code. **Open file…** opens the file dialog and reads the selected file
through native Wine. You can import your own file there. Close the window to exit;
a remaining demo file is deleted.

Startup checks exercise both A/W disk-space APIs, NULL and C volume roots,
existing and missing package directories, optional outputs, output guards,
native drive enumeration, and short/exact multistring character capacities.
The host-only executable exercises the browser fallbacks using the same SDK
contracts. The GUI uses real Wine Kernel32, KernelBase and NTDLL.

Rebuild both executables with `sh scripts/build-guest-drive-fixture.sh` using
`i686-w64-mingw32-gcc` and `i686-w64-mingw32-strip`. No application sources are
compiled by the browser: native x86 instructions are compiled to Wasm there.

The guest content budget is 128 MiB, with a 16 MiB growth bound per file and a
4096-byte reporting unit. Imports can exceed the writable budget; free space
then reports zero. Shrinking and overwriting existing content remain supported
within the supported I/O bounds. This demo verifies a bounded guest filesystem,
not arbitrary Windows filesystem compatibility.
