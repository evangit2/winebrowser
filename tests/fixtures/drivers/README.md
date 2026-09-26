# Native installable-driver fixture

The freestanding PE32 client loads a repository-owned DLL whose real `DriverProc`
records callback arguments in client memory. Both execute as x86 translated to
Wasm, with no precompiled application Wasm and no mocked driver callback results.

`npm run build:drivers` rebuilds both binaries with MinGW i686; `npm test` executes
the fixture and callback failure/reentrancy tests in Node. `npm run test:drivers`
runs the same native client in an isolated Chromium worker, recording binary
hashes and results in `evidence/drivers-browser-results.json`.

The client verifies independent instance IDs, custom message returns, exact
load/enable/open/close/disable/free order, close parameters, registry aliases,
ANSI entry, descriptor sessions, rejected load/open cleanup, a DLL without
DriverProc, stale handles, and final DLL detach/unmapping. Hidden sessions get a
null descriptor before the caller's descriptor; they close after the last
ordinary instance. The client retains a separate LoadLibrary reference while
checking its event buffer and then releases that reference too.

The implementation loads packaged native driver DLLs. It does not supply missing
codecs, kernel drivers, physical devices, capture or a general waveOut driver.
SYSTEM.INI aliases, opening during a driver's initialization/closure, and closing
an instance from inside its own active callback remain explicitly unsupported.
Registry lookup uses the process-local HKLM store. Paths/options have a 260-code
unit limit; at most 1,024 driver instances, including hidden sessions, may exist.

Primary references: Microsoft's [driver instances](https://learn.microsoft.com/en-us/windows/win32/multimedia/driver-instances)
and [DriverProc ABI](https://learn.microsoft.com/en-us/windows/win32/api/mmiscapi/nc-mmiscapi-driverproc),
and the native WinMM/ACM interaction in Wine's `dlls/winmm/driver.c` and
`dlls/msacm32/driver.c` at revision `db11d0fe6a169c457e23d007e20404643d067aa8`.
