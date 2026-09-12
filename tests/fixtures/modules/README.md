# Guest module-linking fixture

`modules.zip` contains a freestanding PE32 executable and two guest DLLs. The
executable imports `math.dll` by name and ordinal and imports `ForwardSum` from
`forward.dll`; `ForwardSum` is a PE export forwarder to `math.sum`. The math DLL
also invokes a callback located in the executable. Both DLLs prefer base
`0x10000000`, and `math.dll` stores an absolute function pointer so loading both
at distinct bases exercises HIGHLOW relocation. Their `DllMain` routines track
process attach state, which the exported checks require.

The C sources and `.def` files are retained alongside the generated binaries.
Run `scripts/build-module-fixtures.sh` with the i686 MinGW GCC/binutils tools to
regenerate them. The script strips COFF symbol tables, normalizes PE header
timestamps/checksums, and writes a ZIP with fixed timestamps and entry order.
