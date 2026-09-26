# Native shared-user-data fixture

This repository-owned PE32 reads Windows' fixed `0x7ffe0000` address directly.
It compares high/low/high TickCount reads against GetTickCount64, GetTickCount and
WinMM timeGetTime, checks interrupt-time units, UTC bias, FILETIME, the virtual
QPC frequency and every processor-feature byte. It ends through ExitProcess.

Build with `npm run build:shared-data`. `npm test` also verifies exact clock bytes
with injected 64-bit times, 32-bit rollover, backward source samples, scalar,
SIMD, x87 and REP MOVS reads, and denied writes/gaps/cross-boundary accesses.
`npm run test:shared-data` runs the PE in the ordinary browser runtime; evidence
is `evidence/shared-data-browser-results.json`.

The optional full Wine target probe runs this same EXE with real Kernel32 clock
exports and native process shutdown:

```sh
node scripts/probe-wine-target.mjs tests/fixtures/shared-data /path/to/i386-windows /path/to/nls --report evidence/shared-data-native-startup.json
node scripts/probe-wine-target.mjs tests/fixtures/shared-data /path/to/i386-windows /path/to/nls --browser --report evidence/shared-data-native-startup-browser.json
```

The external mapping uses one 4 KiB backing array while the application arena
remains 64 MiB. Readable fields are TickCountLowDeprecated/Multiplier,
InterruptTime, SystemTime, UTC TimeZoneBias, ProcessorFeatures, QpcFrequency,
and TickCount plus its padding. Other shared-data fields fail explicitly.
This is not a general sparse allocator or full KUSER_SHARED_DATA implementation.
CPU scalar, SIMD and x87 reads and the memory readBytes/string helpers understand
external views. Host services indexing the raw linear TypedArray retain a
separate linear-range check; passing them an external source buffer is still
unsupported, and cannot silently return an empty slice.

Primary layout/units reference: Microsoft's
[KUSER_SHARED_DATA](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-kuser_shared_data).
Native consumers and update ordering are verified against Wine revision
`db11d0fe6a169c457e23d007e20404643d067aa8`, in `include/ddk/wdm.h`,
`dlls/kernel32/sync.c`, `dlls/kernelbase/sync.c`, and `server/fd.c`.
