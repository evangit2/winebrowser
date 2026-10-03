# Native service acceptance

The authored MIT PE32 EXE exercises Wine's actual KernelBase path/character
bodies and source-built Version DLL, including the version resource compiled
from native-services.rc. It independently compares the returned resource
signature and four version components.

The same program checks ephemeral CSP entropy over Web Crypto's per-call size
limit, provider reference counts and invalid handles, BCrypt system entropy,
legacy default registry values, local/remote connection results, explicit
unsupported hive operations, and shared native handle flags/protected close.
The EXE and ZIP upload paths both run through the normal browser UI.

Build with `sh scripts/build-native-services-fixture.sh`; test with
`node scripts/test-native-services-browser.mjs`. The fixture contains no
proprietary application code or assets.
