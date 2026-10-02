# Windows API-set resolution

The loader now uses all 672 contracts from the pinned Wine schema, covering
555 assigned destinations across 93 DLLs and 117 unassigned contracts. It
preserves major/minor versions and literal paths. Case-insensitive matching
ignores only the final revision, matching Wine's v6 loader. Unknown contracts
and unassigned destinations still fail when no corresponding DLL is supplied.

All aliases share the destination module's exports, initialization, references
and unload behavior. Source/package DLLs retain search precedence. KernelBase
exposes the intersection of its pinned Wine export names and implemented
Kernel32, Advapi32 and User32 services. Native-only forwarders and unsupported
functions remain absent; this adds no success stubs or arbitrary DLL support.

Each process also receives a real version 6 `PEB.ApiSetMap`. Wine's unchanged
native NTDLL independently queries all 672 entries, distinguishes unassigned
from absent contracts, and checks revision and extension behavior. Ordinary
native EXE uploads exercise seven contract families through heap allocation,
file byte round trips, registry creation/value queries, character traversal,
module aliases and missing-export failure. The native variant automatically
loads the source-built Wine closure and calls its own schema queries.

Process-owned registry keys now accept `KEY_ALL_ACCESS` in the Win32 boundary,
consistent with the existing NT boundary. Either WOW64 view selector is ignored
as on 32-bit Windows; contradictory selectors are rejected. NT input registry
strings consume their checked `Length` bytes without requiring a meaningful
`MaximumLength`, matching Wine's recursive key traversal. Native nested-key
creation, cross-view identity and malformed input lengths are verified.
ACL editing/link APIs remain outside this change.

The generated data and export boundary can be regenerated or checked with
`python3 scripts/generate-api-set-schema.py [--check]`. The generator verifies
the published full source archive before reading either specification. Exact
source hashes and counts are in `runtime/wine/api-set-schema-manifest.json`.
Native upload evidence is in `evidence/api-sets-browser-results.json`.

Mapping source: Wine `db11d0fe6a169c457e23d007e20404643d067aa8`,
`dlls/apisetschema/apisetschema.spec` and `dlls/kernelbase/kernelbase.spec`.
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
`CommandLineToArgvW`, after passing native semaphore creation and current-thread
handle duplication. This remains an execution failure; no full sample frame has
rendered yet. The independently verified original HLSL shader render remains
separate evidence from application compatibility.
