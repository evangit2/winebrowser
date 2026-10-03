# Delay-import DLL fixtures

MIT-authored native Windows PE32 clients and DLL. Rebuild with
`npm run build:delay-imports` (MinGW-w64 and Python); test loose EXE/DLL and
nested ZIP uploads using `npm run test:delay-imports`. Set
`WINEBROWSER_NORMAL_CHROMIUM=1` for ordinary visible Chromium and
`WINEBROWSER_TEST_URL` for static/live Pages testing.

`dlltool --output-delaylib` generates real delay descriptors, lookup/address
tables and lazy x86 thunks. The original toolchain `__delayLoadHelper2` is linked
from MinGW's runtime. Startup requires neither the delayed DLL nor the absent
optional DLL. The clients verify first-call named/ordinal resolution, DLL
process attach, cached slots and notification hooks. They then delay-load a
real MSVCRT function; this dependency selects the native Wine base before
startup. The optional DLL fails to load and its requested export also fails,
with the correct errors delivered to guest failure hooks. A returned guest
fallback executes twice without repeating those failures. The delayed DLL is
explicitly unloaded before clean exit.

`delay-native.exe` resolves its first DLL using actual Wine NTDLL's
`LdrResolveDelayLoadedAPI`, then calls through the patched original IATs. It
requires the native Wine base. `delay-imports.exe` uses the ordinary MinGW helper.
`absent-optional.dll` deliberately does not exist; only its import definition
is retained. All guest executable code is translated to Wasm during execution.

The parser also checks legacy VA descriptors and rebasing of lazy thunk
addresses. Those parser tests do not establish execution of legacy helpers,
bound delay tables or unload-helper compatibility.
