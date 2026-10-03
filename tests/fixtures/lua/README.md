# Native Lua client

MIT-authored PE32 client imports only Kernel32. It dynamically loads the original
upstream Lua 5.4.2 Windows DLL, opens its standard libraries, loads main.lua from
the package, runs it with protected error handling,
closes the Lua state, unloads the DLL and exits. Lua executes the supplied script
inside the x86 guest; no browser implementation substitutes for its engine.

Rebuild with `npm run build:lua`. Lua SDK headers and import libraries are not
needed; the original upstream DLL is packaged unchanged. The package retains
its pinned official DLL archive, original Lua source and MIT license.

The script checks exact 64-bit integer arithmetic above the binary64 exact range,
a native guest C callback with 64-bit parameters/results, sine, Unicode length, callback sorting, coroutine yields/resumption, protected
errors, garbage collection and packed integer/float file write/read/unpack.
`npm run test:lua` additionally changes the uploaded script, independently decodes
the resulting binary and tests ZIP, loose files and the hosted catalog path.
Use `WINEBROWSER_NORMAL_CHROMIUM=1` for ordinary visible Chromium and
`WINEBROWSER_TEST_URL` for static/live Pages acceptance.

This fixture does not establish support for all Lua native modules, network or
process APIs, arbitrary Windows software, or startup time across applications.
