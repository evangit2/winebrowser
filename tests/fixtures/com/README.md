# Native in-process COM fixtures

These repository-owned PE32 C programs use MinGW's real COM headers and import
libraries. Rebuild with `npm run build:com`; the script strips symbols and
normalizes PE timestamps/checksums. No application code is precompiled to Wasm.

The client registers `plugins/counter.dll` through native registry APIs. It
creates native objects through `CoCreateInstance` and `CoGetClassObject`, calls
their vtables, checks native HRESULTs for unsupported interfaces and aggregation,
balances initialization, and exercises factory references, server locks and
`DllCanUnloadNow` before unload/reload. Each object owns independent heap-backed
state. The DLL checks that its real process-attach callback ran.

Before COM initialization the client also parses mixed-case GUIDs, formats them
as uppercase UTF-16, checks null/malformed inputs, HRESULTs and buffer bounds,
and resolves a guest registry ProgID to the CLSID used for native activation.
Unit checks additionally cover partial output on malformed GUID fields, all byte
values in text round trips, signed buffer capacities and process isolation.
`CLSIDFromString`, `IIDFromString` and `StringFromGUID2` use these generic services.
The ProgID lookup reads a direct `CLSID` subkey; `CurVer` aliases and OLE 1 class
generation remain unfinished, as do activation-context registrations.

`npm test` runs these and additional failure tests in Node. `npm run test:com`
runs the client and DLL in an isolated Chromium worker and writes hashed input
evidence to `evidence/com-browser-results.json`. A nonzero client exit code is a
failing C source line.

The runtime implements one guest-thread apartment and same-apartment in-process
activation. It uses the process-local HKCR registry, falling back to per-user
and machine `Software\Classes` registrations. Compatible `Apartment`, `Free`
and `Both` servers are supported; missing threading metadata requires the STA.
Cross-apartment activation, neutral apartments, marshaling, external servers,
activation manifests and the merged Windows HKCR registry view remain unfinished.
Unsupported activation options fail explicitly. No built-in class is fabricated
for an unregistered CLSID.

References: Microsoft's [CoCreateInstance](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-cocreateinstance),
[CoInitializeEx](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-coinitializeex)
and [InprocServer32](https://learn.microsoft.com/en-us/windows/win32/com/inprocserver32)
contracts.

Identifier references: Microsoft's [CLSIDFromString](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-clsidfromstring)
and [IIDFromString](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-iidfromstring),
plus the pinned Wine `dlls/combase/combase.c` implementation and
`dlls/ole32/tests/compobj.c` field-level failure checks.
