# Windows API-set native clients

These MIT-authored PE32 fixtures import seven contract DLL families rather than
the corresponding implementation DLL names. They check the actual guest PEB
namespace, zeroed heap allocation/reallocation, file byte round trips, nested
registry creation with `KEY_ALL_ACCESS`, value queries, character traversal,
case/revision module aliases, reference balancing and missing exports.

`host.exe` exercises the shared browser services. `native.exe` additionally
imports NTDLL's `ApiSetQueryApiSetPresenceEx`, causing ordinary uploads to select
the published source-built Wine closure. Its original NTDLL code checks assigned,
unassigned and absent schema names. The JS unit gate independently queries all
672 entries through that unchanged Wine export.

Build with `npm run build:api-sets`; verify actual EXE uploads with
`WINEBROWSER_NORMAL_CHROMIUM=1 npm run test:api-sets`. The import libraries are
generated in the ignored scratch directory. No program source compiles to Wasm
during packaging: the browser translates these native x86 executables at run time.
