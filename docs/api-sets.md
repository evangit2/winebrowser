# UCRT API-set resolution

The module loader resolves the fifteen `api-ms-win-crt-*-l1-1-0` contracts in
Wine's pinned API-set schema to `ucrtbase.dll`. Resolution is case-insensitive
and applies to IAT imports, export forwarders, LoadLibrary and GetModuleHandle.
All contracts share the implementation's native module, initialization, exports,
reference count and unload behavior. No fake DLL or replacement CRT function
is created. The actual implementation must be present in the package or configured
builtin closure; otherwise loading still fails with a missing dependency.
Qualified file paths and unknown contracts/versions keep their existing behavior.
Other Windows API sets and a generic guest PEB ApiSetMap remain unfinished.

Mapping source: Wine `db11d0fe6a169c457e23d007e20404643d067aa8`,
`dlls/apisetschema/apisetschema.spec` (the fifteen CRT host assignments).
Microsoft's [API-set description](https://learn.microsoft.com/en-us/windows/win32/apiindex/windows-apisets)
explains contract indirection and module loading.

`tests/api-sets.test.js` checks mapping boundaries, shared native identity,
executable exports, references/unloading/reload, and failure rollback.
`test-ucrt-native.mjs` verifies a real PE32 with five distinct API-set import
families against the pinned Wine UCRT, in Node and an isolated browser worker.
It checks allocations/reallocation, narrow/wide strings and conversion,
`__acrt_iob_func`, and native module queries/dynamic loads. Results and exact input
hashes are in `evidence/ucrt-native{,-browser}-results.json`.

The real Microsoft HelloTriangle EXE now passes the UCRT import gate and reaches
`NtCreateSemaphore` in its MinGW runtime, after passing current-thread
handle duplication. This remains an execution failure; no full sample frame has
rendered yet. The independently verified original HLSL shader render remains
separate evidence from application compatibility.
