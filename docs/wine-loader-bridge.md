# Wine browser loader bridge experiment

This is an **opt-in source patch**, not a production runtime path. `runtime/wine/browser-loader.patch` applies to the clean Wine 11.0 source tree at commit `db11d0fe6a169c457e23d007e20404643d067aa8` (the dereferenced `wine-11.0` tag and pinned installed-DLL source revision). It changes only `dlls/ntdll/loader.c` and `dlls/ntdll/ntdll.spec`. Rebuilt Wine artifacts retain Wine's LGPL-2.1-or-later obligations. Do not apply the patch to the installed DLL or patch its private data by address.

The source-built PE32 ntdll exports private `WineBrowserLoaderBootstrap(batch*)`. It is versioned (`version == 1`) and accepts one atomic batch of 2–64 **already mapped and linked** modules. The host remains responsible for image mapping, relocations, import resolution, static TLS, guest heap and process parameters, NLS sections, attach order, and image rollback. The export creates Wine's `PEB_LDR_DATA` reference and internal `WINE_MODREF` list/hash/address-index entries through `alloc_module()`, initializes Wine's dynamic TLS bitmaps, then calls Wine's own `version_init()`. It never creates another heap, maps an image, or calls a DLL entry point.

All fields are little-endian 32-bit guest values:

| Structure | Offset | Field                                                        |
| --------- | -----: | ------------------------------------------------------------ |
| `batch`   |      0 | `size = 16`                                                  |
|           |      4 | `version = 1`                                                |
|           |      8 | `count`                                                      |
|           |     12 | pointer to contiguous `module[count]`                        |
| `module`  |      0 | `size = 16`                                                  |
|           |      4 | already mapped PE image base                                 |
|           |      8 | pointer to NUL-terminated NT path (`\??\C:\...`)             |
|           |     12 | flags: `1` main EXE, `2` ntdll, `4` already process-attached |

Exactly one main EXE and one ntdll are required; bases, image ranges, and case-insensitive basenames must be distinct. The main base must equal `PEB.ImageBaseAddress`. The ntdll flag must identify the validated image range containing the bridge function address; the PE ntdll link does not expose Wine's generated `__wine_spec_nt_header` symbol to this object. Every image must be i386 PE32. Legacy images without `NX_COMPAT` are accepted, while browser DEP remains permanently enabled: `ProcessExecuteFlags` queries return `0x0d`, identical updates succeed, and requests to disable DEP or change that permanent policy return `STATUS_ACCESS_DENIED`. This does not make guest data executable. This first gate rejects static TLS directories because Wine's TLS slot table has not been unified with the host's. The host must list already-attached modules in their actual attach order; those entries are linked into Wine's initialization-order list and marked attached. `STATUS_INVALID_PARAMETER` and `STATUS_OBJECT_NAME_COLLISION` reject malformed or duplicate batches before publication; `STATUS_INVALID_DEVICE_STATE` rejects a second bootstrap or an existing loader owner. An allocation failure removes only new Wine metadata, including all three list links and the address index, and restores `PEB.LdrData` and `PEB.LoaderLock`. Image mappings, the heap, parameters, and NLS remain host-owned. A guest exception inside `version_init()` still requires the host's enclosing ntdll-image/process rollback; the export cannot turn a fault into an NTSTATUS. The host must serialize this call with module operations and validate guest descriptors and mapped ranges before invoking it.

Wine owns **dynamic** `TlsAlloc` state in this gate. The bootstrap requires `PEB.TlsBitmap` (`+0x40`) and `PEB.TlsExpansionBitmap` (`+0x150`) to be null, both backing bit arrays (`+0x44`, `+0x154`) to be zero, and no existing TEB expansion slots or ordinary TEB TLS slot values. It initializes both `RTL_BITMAP`s only after every metadata allocation succeeds, then reserves slot 0 and `NTDLL_TLS_ERRNO` (slot 16), matching Wine's `loader_init()`. The host's static TLS vector remains separate and static TLS PE directories are still rejected. An allocation failure leaves all dynamic TLS fields untouched; an exception during bitmap setup or `version_init()` requires the enclosing host rollback to restore the PEB, TEB, and ntdll image, including the bitmap globals.

Before a callback is configured, the original ownership guards remain: only basename lookup with `UNCHANGED_REFCOUNT` is allowed; loading, procedure lookup, refcount changes and unloading return `STATUS_NOT_SUPPORTED`. The existing bootstrap tests still verify this mode.

The source-built ntdll also exports private `WineBrowserLoaderConfigure(version, callback)` and `WineBrowserLoaderSync(base, ntPath, flags, refs)`. Configure accepts version 1 once, after bootstrap. Its stdcall callback takes six 32-bit arguments: an operation plus five arguments. Operations 1–5 delegate `LdrLoadDll`, `LdrGetProcedureAddress`, `LdrGetDllHandleEx`, `LdrAddRefDll` and `LdrUnloadDll`, respectively, to `src/wine-loader.js`. Operation 6 delegates `LdrShutdownProcess` to the runtime's shared process-detach pass and requires five zero arguments. The callback validates counted strings and output buffers before changing references; named/ordinal exports, forwarded exports, full package paths, same-basename DLLs, pinning and refcounts use the same browser graph as host Win32 calls. Load flags other than zero and encoded native search policies remain unsupported. Ordinary native search-path lists are confined to package directories; builtin/host fallback follows the graph policy.

Sync creates or updates Wine metadata without mapping or calling guest entry points. `ntPath == NULL` removes only metadata; flag 4 records completed process attach, and `refs` is a bounded count or -1 for a resident/pinned module. The host synchronizes newly mapped DLLs before DllMain, records successful attaches, removes failed/unloaded modules from Wine before erasing their mappings, and restores retained records after graph rollback. Host and Wine module names use the same package paths, including `@host` and `@runtime` directories. Static TLS in the complete Wine bridge remains unsupported.

Normal browser-provided DLLs now have real relocatable PE32 headers, sorted export-name tables, sparse explicit ordinals, and read-only executable stubs. An export stub tail-calls its host thunk while preserving the caller's arguments, registers and flags. IAT and GetProcAddress pointers equal the PE export address. These generic images let native import resolvers inspect modules without pretending an opaque high address is a PE. Only configured APIs appear; diagnostic trap imports still stop with their exact name when called.

Wine's internal `load_dll` remains guarded because all public loader operations now delegate to the browser. `loader_init` and `LdrShutdownThread` still raise `STATUS_NOT_SUPPORTED` before changing lifecycle state. `LdrShutdownProcess` also rejects calls before callback configuration. Once configured, it sets Wine's process-detaching flag and delegates once to operation 6. The host owns reverse-order TLS/DllMain detach; recursive or repeated shutdown cannot repeat callbacks, and unload requests during detach leave that pass in control. `NtTerminateProcess(NULL, status)` lets the sole guest thread continue into cleanup; the current-process pseudo-handle terminates execution without additional notifications. These callbacks do not establish general exception handling or guest thread support. The full Wine callback path is opt-in in the diagnostic; the normal harness uses mapped host DLL images but does not bundle the full Wine base closure.

First gate: build the patched ntdll separately; keep the stock ntdll path unchanged. In a diagnostic runtime with the pre-existing guest heap, process parameters, NLS, registry, and token identity, pass the main EXE, ntdll, and one mapped DLL in one batch. Verify a second batch fails, `RtlGetVersion` returns Wine's initialized version, `LdrGetDllHandleEx(UNCHANGED_REFCOUNT, basename)` returns each original base, and a requested load/unload/ref mutation returns `STATUS_NOT_SUPPORTED` without changing maps or attach counts. `version_init()` itself queries `SystemWineVersionInformation` and reads registry version settings, so those NT operations must return real statuses. Do not enable the bridge in normal package loading until failure rollback and the ownership assertions pass against the pinned binary.

## Rebuild and verify

Install Wine's normal configure/build prerequisites, an i686 MinGW toolchain, and Bison 3.0 or newer. Run:

```sh
npm run build:wine-loader
npm run probe:wine-loader -- .cache/wine-loader/manifest.json /path/to/wine/nls
npm run probe:wine-loader -- .cache/wine-loader/manifest.json /path/to/wine/nls --browser
```

The script verifies the 53,844,515-byte source archive against SHA-256 `18aaee150ad540885b9706ae73ccf6febca904049de2792199a9dc18a2772e6a`. Each patch hash has its own source/build cache. Configure uses `--enable-archs=i386 --disable-tests`; make builds only `dlls/ntdll/i386-windows/ntdll.dll`. `BISON` can select an installed parser generator; on macOS the script also checks standard Homebrew paths. The manifest records compiler versions and the DLL hash. This is a repeatable build procedure; output hashes can differ across toolchains and absolute debug paths. No generated DLL is copied into `public/`.

The optional NLS directory supplies the existing hash-pinned Wine data. The Chromium mode uses the same probe assertions in a module worker, with a real browser Wasm decoder and translator. Verified artifacts are served only through intercepted local test requests. The browser makes no external requests. The ordinary installed-Wine probe retains its separate original-DLL hash check.

The [Node evidence](../evidence/wine-loader-results.json) and [Chromium worker evidence](../evidence/wine-loader-browser-results.json) pass fifteen cases against the current patch, including a main PE without `NX_COMPAT`: invalid/duplicate batches, explicit allocation-failure rollback, retry and second-bootstrap rejection, real `RtlGetVersion` (Wine's default Windows 10 build 19045), case-insensitive module lookup, rejected ownership changes, native NT page protection, and pre-configuration process/thread lifecycle guards. The allocation failure is diagnostic injection at the fourth `RtlAllocateHeap` call; it tests cleanup after the first module has entered Wine's indexes. The original bootstrap phase preserves the process heap and graph without additional DLL entry calls. The callback phase then verifies real host PE export calls, native named/ordinal/forwarded lookups, full paths, same-basename DLL isolation, pinning, unloading, two rejected-DllMain retries, malformed arguments, and failures at all three native metadata allocations followed by successful retry. It independently walks Wine’s PEB loader list to verify removal and rollback. A final native shutdown case verifies the process-detaching flag, DLL detach order, repeated-call suppression and `RtlExitUserProcess` termination. The evidence records the exact patch and rebuilt DLL hashes for this revision.

`SystemWineVersionInformation` describes Wine's Unix host, which this runtime does not have. The NT provider returns `STATUS_INVALID_INFO_CLASS` without fabricating host metadata. Wine's unchanged `version_init()` handles that absence and selects its own Windows version defaults. These checks establish loader metadata and bounded dynamic module operations. They do not establish general CRT startup, static TLS, exceptions, graphics, or application compatibility.

Before callback configuration, the lifecycle guard test deliberately stops at the exported `RtlRaiseStatus` boundary and verifies `STATUS_NOT_SUPPORTED` for process shutdown, thread shutdown and a second process/thread loader entry. This verifies the guards without claiming structured-exception dispatch works.

## CRT diagnostic and NT services

```sh
npm run probe:wine-loader-crt -- /path/to/i386-windows /path/to/wine/nls
npm run probe:wine-loader-crt -- /path/to/i386-windows /path/to/wine/nls --browser
```

This separate diagnostic maps the pinned whole msvcrt/kernel32/kernelbase closure with the generic rebuilt ntdll, registers that complete graph before DLL attach, and completes normal guest DLL initialization. It does not run an application entry point. [Node evidence](../evidence/wine-loader-crt-results.json) and [Chromium-worker evidence](../evidence/wine-loader-crt-browser-results.json) verify real guest `calloc`, `sprintf`, `strlen`, `_write` and `free`: zeroed allocation, exact formatting, CRLF-translated output and cleanup. The file phase also executes `_open`, `_filelength`, `_lseek`, `_read` and `_close`, including binary writes, EOF, reopen, seeking relative to EOF and handle cleanup. Synchronous `NtCreateFile`/`NtOpenFile`, `FileStandardInformation`, `FilePositionInformation` and `FileEndOfFileInformation` operate on bounded process-local files. Async I/O, directory handles, security descriptors, deletion and other information classes remain unsupported. The shared probe has no Node imports. Its launcher verifies every DLL/NLS input and serves them only through intercepted local routes; no installed binaries or NLS files are copied into the public harness.

The native `NtProtectVirtualMemory` provider supports no-access, read-only and read-write protections on committed private VM pages and fully mapped, non-executable PE pages. Page rounding, first-page old protection and access checks are shared with the memory manager. It rejects executable protections, code changes, image gaps, immutable section snapshots and output parameters placed on newly protected pages. Wine's kernel32 can therefore temporarily update its read-only export-table slot and restore it. Writable PE code now invalidates overlapping JIT blocks through the ordinary memory path. Changing executable protections, private executable allocation and live export-table mutation remain separate work.

Guest kernelbase dynamic TLS checks allocate 65 slots (including expansion), set/read/free values and verify reuse clears the value. `NtSetInformationThread(ThreadZeroTlsCell)` clears the requested cell in the sole guest thread. The host does not implement `TlsAlloc` itself; Wine uses its own bitmap and heap code. Multiple guest threads and static-TLS/Wine loader ownership are still unresolved.

With the real `c_20127.nls` ASCII table included in the optional input manifest, C-locale and conservative processor-feature queries complete. The synchronous NT file boundary supplies `FileFsDeviceInformation` for existing runtime handles, bounded byte reads/writes and close. Standard output/error are real byte-output pipes; invalid stdin remains an invalid handle that Wine handles itself. File creation, asynchronous I/O, events and general native file-information queries remain unfinished. Passing CRT exports is distinct from running an application through Wine's full loader and shutdown lifecycle.

## Unchanged application startup diagnostic

```sh
npm run fetch:targets -- humus-dynamic-branching-d3d9-x86
npm run probe:wine-target -- humus-dynamic-branching-d3d9-x86 /path/to/i386-windows /path/to/wine/nls
npm run probe:wine-target -- humus-dynamic-branching-d3d9-x86 /path/to/i386-windows /path/to/wine/nls --browser
```

This diagnostic verifies the catalog archive and EXE hashes, uses the same
verified Wine/NLS inputs as the CRT probe, initializes the DLL graph, then calls
the original application's native entry point. CPU blocks compile to Wasm
during execution, with a ten-million-dispatch diagnostic budget and a 60-second browser-worker deadline. The unchanged Humus Dynamic Branching binary now passes Wine
registration and DLL attach and reaches its own startup code. It also completes its native timing calibration and enumerates the virtual display. Both engines now pass `LOCK XADD`, legacy F3 bit scans and variable rotates in the real Wine heap, create the application window and call `Direct3DCreate9(31)`. They stop at the explicit unimplemented `IDirect3D9.GetDeviceCaps` boundary (EXE block offset `0x2c01`) after more than six million guest instructions. The probe uses the real WebGPU renderer interface and records zero presented frames at this boundary. This does not yet run the demo's graphics. The [Node report](../evidence/wine-target-startup.json)
and [Chromium-worker report](../evidence/wine-target-startup-browser.json) retain
the first actual failure, module-relative address, registers, executed instruction
count and recent API calls.

For diagnosis only, unresolved imports in selected host boundary DLLs receive
explicit trap thunks. Calling one stops execution with its DLL/export name;
none returns fabricated success. The normal upload harness still rejects
unresolved imports before execution. Broader
Win32 services and graphics must work before this target can become a public
passing example. Local inputs stay behind intercepted loopback test routes;
installed Wine DLLs, NLS data and upstream assets are not published by this probe.

## Original Hamsterball and packed native BASS

The original Hamsterball EXE is recovered byte-for-byte from retained PE sections
(SHA-256 `3379e9041c7ab83abd07da1bcf974529280aeff36b3c52e7a3d3bbb93e2da94d`),
with the existing asset directory and native BASS DLL. No Theseus-generated
application Rust/Wasm is loaded. The local-folder target probe supplies the
same hash-checked Wine closure, including native `msacm32.dll` and `ucrtbase.dll`,
and the already published source-built Wine formatting helper so native error
messages can execute. Installed DLLs remain local diagnostic inputs.

Both Node and the Chromium worker pass source bootstrap, callback installation
and packed BASS translation. WinMM mixer and multimedia time exports resolve,
as do the native ACM/UCRT exports and virtual foreground-window queries. The
OLE32 exports now resolve, including `CoCreateInstance`. Extended-precision
logarithms, trigonometry and `FXAM` now execute, followed by scalar SSE moves and
signed-int32-to-double conversion. Scalar SSE arithmetic, square roots,
conversions, comparisons and MXCSR now execute, as do 16/32-bit `SHLD`/`SHRD`
and x87 `FISTTP` conversions. User32 character calls now execute native Wine
KernelBase/NLS code, and legacy registry create/open aliases share the existing
key store. WinMM now loads native DriverProc exports and manages real instances,
messages and hidden descriptor sessions; ACM discovery and packed BASS attachment
complete. The game reaches its original EXE entry. The fixed-address shared-user-data
clock mapping now lets native Kernel32 GetTickCount run. Both Node and Chromium
pass predefined cursor loading, including IDC_HAND, and x87 integer-operand
arithmetic/comparisons, COM GUID conversion, window lookup and 24-bit icon
decoding. Native window metadata passes through the original game window
procedure, and both probes create the 800×600 Hamsterball window with its native
icon. Both next stop at `SetWindowPos`, after 8,800,785 guest instructions.
No game frame renders yet. Native ACM conversion and BASS playback remain
unverified. The next work is window positioning and remaining
audio/Win32 services, followed by
broader D3D8 resources and input. Evidence: `evidence/hamsterball-startup.json` and
`evidence/hamsterball-startup-browser.json`.

The virtual WinMM mixer exposes one stereo PCM destination and one wave source,
each with uniform volume and mute controls. These controls scale the actual
`PlaySound` PCM samples sent to the browser driver. `npm run test:winmm` executes
a repository-owned PE32 fixture in an isolated Chromium worker and verifies exact
scaled and muted samples, ANSI/Unicode structure layouts and clock queries. It
does not test physical speakers or implement capture, mixer notifications,
multimedia callback timers, or a general waveOut/DirectSound driver.

The separate native character fixture verifies all eight case APIs, including
CP1252, surrogate pairs and counted UTF-16 buffers, then exits through real Wine
`ExitProcess`, the shared shutdown callback and `NtTerminateProcess`. Both
`evidence/characters-startup.json` and `evidence/characters-startup-browser.json`
record exit code zero. These conversions require the supplied Wine/NLS closure;
the normal upload harness does not yet bundle it.

The ordinary runtime also supports packaged installable-driver DLLs without the
optional Wine base closure. `npm run test:drivers` verifies the native client and
DriverProc ABI in Chromium; fixture scope and limitations are in
[the driver fixture](../tests/fixtures/drivers/README.md). Native ACM discovery
uses this same bridge; it does not substitute successful codec responses.

The shared-data mapping has a separate 4 KiB backing view and leaves the linear
application arena at 64 MiB. Its clock fields share the runtime's monotonic
performance counter and NT wall-clock source. Processor-feature bytes use the
same conservative virtual CPU profile. The
[fixture documentation](../tests/fixtures/shared-data/README.md) identifies the
supported fields, memory-access boundary and both ordinary/native-Wine browser
checks; other shared-data fields and raw host-buffer consumers remain unfinished.

Predefined cursors now connect to actual browser cursor styles. Native class
cursors and parent overrides execute through WM_SETCURSOR; SetCursor, GetCursor
and signed ShowCursor counts share process-local state. The
[cursor fixture](../tests/fixtures/cursors/README.md) verifies normal EXE upload,
real mouse/keyboard routing, visible CSS cursor changes and clean exit. Custom
cursor resources and additional system cursor assets remain unfinished.
