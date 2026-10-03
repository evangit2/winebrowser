# Native Lua Windows DLL

The Lua catalog example executes the unchanged upstream LuaBinaries 5.4.2
Windows x86 DLL through an authored MIT native client. Drop the ZIP, or select
the client EXE, original DLL and main.lua together. The native Wine base is
selected before startup; the EXE and original DLL compile from x86 to Wasm
inside the browser. Lua's original VM loads and runs the supplied script file.

The example checks exact 64-bit integers above binary64's exact range, floating-
point sine, Unicode length, sorting callbacks, coroutine yield/resumption,
protected errors, garbage collection and packed binary file I/O. Lua also calls
an authored guest C function with 64-bit parameters and a 64-bit result. The
original DLL then unloads and the process exits cleanly.

Browser acceptance changes the uploaded script while keeping the EXE/DLL bytes
identical. Its generated binary changes accordingly. Node independently reads
the two 64-bit integers and double from the 24-byte output. A script raising a
non-string Lua error produces an ordinary exit status and readable message,
rather than dereferencing a null error string.

The official DLL archive, original Lua source archive, MIT licenses, client
source/build recipe, script and SHA-256 pins accompany the public example.
No proprietary game binaries are used. Rebuild/package with `npm run build:lua`;
test with `WINEBROWSER_NORMAL_CHROMIUM=1 npm run test:lua`, adding
`WINEBROWSER_TEST_URL` for static or live Pages acceptance.

These workloads do not establish support for all native Lua modules,
networking, process creation or every Windows DLL. Timings record this workload;
they are not a general startup or performance guarantee.

Evidence: [browser results](../evidence/lua-browser-results.json).
Provenance: [upstream archives and hashes](../public/examples/lua/PROVENANCE.md).
