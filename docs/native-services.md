# Shared native services

The automatic Wine base now includes the source-built version.dll from the
same pinned Wine revision. Version-resource queries execute its actual native
code and KernelBase exports. The authored EXE acceptance independently checks
the version values returned from its compiled PE resource.

SHLWAPI PathCanonicalize, PathCombine and PathSkipRoot A/W call Wine's existing
KernelBase bodies. User32 character forwarders use those native bodies too.
The package inspection now selects Wine before startup for these imports,
including eager EXE imports that previously had host-name coverage but required
a native component at execution. PE DLL headers also select native CRT support
for .pyd, .ocx and other filenames; the filename extension does not determine
whether a supplied binary is a library.

Ephemeral CryptAcquireContext contexts supply CryptGenRandom through the
browser's Web Crypto entropy source. References, release, provider/type/flag
errors and ranges larger than Web Crypto's 65536-byte request limit are checked.
SystemFunction036 and BCryptGenRandom's system-preferred mode share that source.
Persistent key containers, key generation, opened BCrypt algorithms and encryption
are not implemented. A missing keyset or unsupported provider does not succeed.

RegQueryValue and RegSetValue A/W operate on default values in the shared
process registry, with subkey creation, Unicode byte counts and empty defaults.
Local registry connections and synchronous memory flush use that store. Remote
connections return ERROR_BAD_NETPATH, and hive save/load returns
ERROR_NOT_SUPPORTED without creating output files. Registry data remains private
to the process and does not persist between runs.

NtQueryObject/NtSetInformationObject handle-flag requests share inheritance and
close protection with Get/SetHandleInformation. Protected CloseHandle/NtClose
requests preserve the live object; clearing protection allows normal close.
Stale native handle closes return STATUS_INVALID_HANDLE. Other NT object
information classes remain unsupported.

The x86 compiler accepts eligible XACQUIRE/XRELEASE hints with TSX disabled.
They follow ordinary locked operations, implicit atomic exchanges or release
stores in the serialized guest scheduler. Tests independently compare successful
and failing CMPXCHG cases with ordinary LOCK behavior. This does not introduce
transactional memory or shared-Wasm-memory support.

Run `npm run build:native-services` and
`WINEBROWSER_NORMAL_CHROMIUM=1 npm run test:native-services`. Browser evidence:
[native service results](../evidence/native-services-browser-results.json).
These checks establish the listed paths, not universal Windows compatibility.
