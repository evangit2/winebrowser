# x86 string comparisons

`CMPSB`, `CMPSW`, and `CMPSD` now execute through the existing x86-to-Wasm string
instruction path. They compare DS:[ESI] minus ES:[EDI], set the six arithmetic
flags, advance both indices according to DF, and leave EAX unchanged. FS can
replace the source segment with the current guest TEB; the destination remains
flat ES memory. The decoder selects exact string encodings so SSE instructions
with the same mnemonic cannot enter this path.

Unprefixed comparisons perform one iteration without changing ECX. REPE stops
after a mismatch and REPNE after a match, or when ECX reaches zero. Entry ZF does
not suppress the first comparison. Zero count touches neither memory nor flags.
Repeats yield after at most 1,024 iterations and retain their remaining count.

The shared CMPS/SCAS path also corrects fault flags: completed iterations retain
their index/count progress, but a repeated comparison restores its pre-instruction
arithmetic flags if a later memory access faults. The saved flags travel with the
guest thread context across scheduler chunks. Faulting source/destination reads
never perform the faulting comparison or advance its indices. This internal fault
state does not implement Windows SEH or guest exception delivery.

`tests/cpu-cmps.test.js` covers every byte-value pair, word/dword edge values, all
arithmetic flags against an independent BigInt model, both repeat modes and
directions, count exhaustion, zero count, FS changes, source/destination faults,
and faults after a chunk and another guest context. Existing MOVS/STOS/SCAS and
thread-context regressions remain part of the unit suite.

`npm run build:cmps` builds a freestanding native PE32 fixture.
`npm run test:cmps` uploads its EXE and ZIP into Chrome and checks real inline
assembly comparisons, unsigned borrow/signed overflow/parity, unchanged count for
unprefixed forms, early stopping, invalid pointers with zero count, and an
8,192-byte repeated comparison. Results: `evidence/cmps-browser-results.json`.

Semantics follow the CMPS, REPE/REPZ, and REPNE/REPNZ entries in the
[Intel instruction reference](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf).
16-bit address size, GS and other segment bases, LODS and port strings remain
unsupported. This change adds guest instruction coverage, not a game-specific
PNG decoder or pretranslated application.
