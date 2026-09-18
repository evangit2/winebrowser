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

Exactly one main EXE and one ntdll are required; bases, image ranges, and case-insensitive basenames must be distinct. The main base must equal `PEB.ImageBaseAddress`. The ntdll flag must identify the validated image range containing the bridge function address; the PE ntdll link does not expose Wine's generated `__wine_spec_nt_header` symbol to this object. Every image must be i386 PE32 and NX-compatible. This first gate rejects static TLS directories because Wine's TLS slot table has not been unified with the host's. The host must list already-attached modules in their actual attach order; those entries are linked into Wine's initialization-order list and marked attached. `STATUS_INVALID_PARAMETER` and `STATUS_OBJECT_NAME_COLLISION` reject malformed or duplicate batches before publication; `STATUS_INVALID_DEVICE_STATE` rejects a second bootstrap or an existing loader owner. An allocation failure removes only new Wine metadata, including all three list links and the address index, and restores `PEB.LdrData` and `PEB.LoaderLock`. Image mappings, the heap, parameters, and NLS remain host-owned. A guest exception inside `version_init()` still requires the host's enclosing ntdll-image/process rollback; the export cannot turn a fault into an NTSTATUS. The host must serialize this call with module operations and validate guest descriptors and mapped ranges before invoking it.

Wine owns **dynamic** `TlsAlloc` state in this gate. The bootstrap requires `PEB.TlsBitmap` (`+0x40`) and `PEB.TlsExpansionBitmap` (`+0x150`) to be null, both backing bit arrays (`+0x44`, `+0x154`) to be zero, and no existing TEB expansion slots or ordinary TEB TLS slot values. It initializes both `RTL_BITMAP`s only after every metadata allocation succeeds, then reserves slot 0 and `NTDLL_TLS_ERRNO` (slot 16), matching Wine's `loader_init()`. The host's static TLS vector remains separate and static TLS PE directories are still rejected. An allocation failure leaves all dynamic TLS fields untouched; an exception during bitmap setup or `version_init()` requires the enclosing host rollback to restore the PEB, TEB, and ntdll image, including the bitmap globals.

During bridge mode, `LdrGetDllHandleEx` resolves only an already registered basename with `LDR_GET_DLL_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT`; `LdrGetDllHandle` uses that path. It returns the same mapped base without a file open, reference increment, or attach. Requests involving a load path, full path, pinning, or refcount mutation return `STATUS_NOT_SUPPORTED`. `LdrLoadDll`, internal `load_dll`, `LdrUnloadDll`, `LdrAddRefDll`, and `LdrGetProcedureAddress` return `STATUS_NOT_SUPPORTED`. Even an apparently read-only procedure lookup can follow a forwarded export and load a DLL or change references, so this first gate rejects every such lookup until a host resolver callback can own the full transaction. `loader_init`, `LdrShutdownProcess`, and `LdrShutdownThread` call Wine's `RtlRaiseStatus(STATUS_NOT_SUPPORTED)` before changing loader, attach, or TLS state. These void entry points therefore fail through the guest exception boundary; the diagnostic host may report an unsupported guest exception, and the caller must roll back the attempted operation. They cannot report an NTSTATUS return. None of these calls is silently treated as success. Source-level callbacks must eventually make JS mapping, Wine loader records, TLS, attach/detach, and reference counts one transaction.

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

The [Node evidence](../evidence/wine-loader-results.json) and [Chromium worker evidence](../evidence/wine-loader-browser-results.json) passed six checks on the earlier patch revision: invalid/duplicate batches, explicit allocation-failure rollback, retry and second-bootstrap rejection, real `RtlGetVersion` (Wine's default Windows 10 build 19045), case-insensitive module lookup, rejected ownership changes, native NT page protection, and process/thread lifecycle guards. The allocation failure is diagnostic injection at the fourth `RtlAllocateHeap` call; it tests cleanup after the first module has entered Wine's indexes. The original process heap and host module graph remained unchanged, no additional DLL entry point executed, and the independent fixture DLL remained callable. The new internal guards require a fresh probe against the current manifest before those results can be attributed to this revision.

`SystemWineVersionInformation` describes Wine's Unix host, which this runtime does not have. The NT provider returns `STATUS_INVALID_INFO_CLASS` without fabricating host metadata. Wine's unchanged `version_init()` handles that absence and selects its own Windows version defaults. These checks establish loader metadata bootstrap only. They do not establish general CRT startup, static TLS, exceptions, graphics, or application compatibility.

The lifecycle guard test deliberately stops at the exported `RtlRaiseStatus` boundary and verifies `STATUS_NOT_SUPPORTED` for process shutdown, thread shutdown and a second process/thread loader entry. This verifies the guards without claiming structured-exception dispatch works.

## CRT diagnostic and NT services

```sh
npm run probe:wine-loader-crt -- /path/to/i386-windows /path/to/wine/nls
```

This separate diagnostic maps the pinned whole msvcrt/kernel32/kernelbase closure with the generic rebuilt ntdll, registers that complete graph before DLL attach, and then attempts normal guest initialization. It does not run an application entry point. [Its evidence](../evidence/wine-loader-crt-results.json) retains the latest failing guest state and explicitly distinguishes successful setup phases from application support.

The native `NtProtectVirtualMemory` provider supports no-access, read-only and read-write protections on committed private VM pages and fully mapped, non-executable PE pages. Page rounding, first-page old protection and access checks are shared with the memory manager. It rejects executable protections, code changes, image gaps, immutable section snapshots and output parameters placed on newly protected pages. Wine's kernel32 can therefore temporarily update its read-only export-table slot and restore it. Writable code, JIT cache invalidation and live host export-table refresh remain separate work.

Guest kernelbase dynamic TLS checks allocate 65 slots (including expansion), set/read/free values and verify reuse clears the value. `NtSetInformationThread(ThreadZeroTlsCell)` clears the requested cell in the sole guest thread. The host does not implement `TlsAlloc` itself; Wine uses its own bitmap and heap code. Multiple guest threads and static-TLS/Wine loader ownership are still unresolved.

With the real `c_20127.nls` ASCII table included in the optional input manifest, the CRT diagnostic passes the former C-locale failure and reaches `NtWow64IsProcessorFeaturePresent(10)`. That query is currently unsupported. The runtime must advertise only CPU features it actually implements; returning an optimistic SSE2 flag would conceal missing instructions. This remains a blocked startup probe.
