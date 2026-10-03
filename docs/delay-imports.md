# Delay-loaded DLLs

PE32 executables and DLLs can now carry a delay-import directory. The parser
validates descriptors, module-handle slots, named/ordinal lookup tables, IAT
slots and optional bound/unload table ranges. RVA and legacy VA metadata are
accepted. MinGW omits the null descriptor from its directory size; one trailing
terminator is accepted only within checked mapped image bytes. Descriptor and
entry limits remain bounded, and malformed pointers fail before execution.

Delay imports are separate from eager imports. They create no startup module
or reference, so an unused optional DLL can be absent. Original IAT entries
continue to point to guest lazy thunks; relocation moves those thunk addresses
with their image. The application's delay helper executes as x86 compiled to
Wasm inside the browser and owns loading, hooks, failure recovery and slot
updates through the shared Wine loader. This also preserves named/ordinal
lookup and the guest calling convention.

A delayed CRT import in an EXE or supplied DLL now selects the native Wine
base before initialization. Native Kernel32/NTDLL cannot be substituted safely
after a program has already initialized their host equivalents. Optional DLLs
are still resolved only on demand.

The authored native fixtures independently exercise MinGW's original delay
helper and Wine NTDLL's actual LdrResolveDelayLoadedAPI. Both load the original
companion DLL on demand, resolve named/ordinal exports, reuse their patched
IATs, delay-load native MSVCRT and unload the companion DLL. Missing optional
DLL and procedure errors reach real guest failure hooks, whose returned guest
fallback runs twice without repeating the failed resolutions. Both loose
EXE/DLL and ZIP uploads run in ordinary Chromium.

`tests/pe-delay-imports.test.js` checks metadata, bounds, lazy-slot relocation
and the guest helper with host services. Browser evidence is in
[evidence/delay-imports-browser-results.json](../evidence/delay-imports-browser-results.json).
All four cases also passed ordinary Chromium on live GitHub Pages:
[live results](../evidence/delay-imports-live-browser-results.json).
Legacy VA helper execution, bound-delay address reuse, unload-helper behavior,
PE32+ and general compatibility with every application remain unverified.
