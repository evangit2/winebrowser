# Native SSE fixtures

This repository-owned PE32 program uses explicit native `MOVSD`, `MOVSS` and
signed-int32 `CVTSI2SD` instructions. It checks register upper-lane preservation,
zeroed upper lanes on memory loads, unaligned scalar transfers, store bounds,
and exact conversion values including both signed-int32 extrema and 16,777,217.
It also exercises binary32/binary64 add/subtract/multiply/divide/square root,
float-width and integer conversions, COMI/UCOMI condition flags, all four MXCSR
rounding modes, sticky status flags, DAZ and FTZ.
Expected floating-point encodings are constants, not results of a second guest
conversion. A nonzero exit code identifies the failing C source line.

Build with `npm run build:scalar-sse` using MinGW i686. The script strips symbols
and normalizes PE timestamps/checksums. `npm test` runs it through the normal
runtime in Node; `npm run test:scalar-sse` runs it in an isolated Chromium worker
and saves `evidence/scalar-sse-browser-results.json`. The unit tests also verify
memory-fault atomicity, integer flag preservation and the distinction between
scalar SSE `MOVSD` and `REP MOVSD` string copying.

CPU tests additionally verify unmasked exceptions preserve destinations and
EFLAGS, reserved MXCSR bits fail, checked memory access precedes state changes,
and callbacks restore MXCSR on return or failure. AVX, x64 integer conversions and guest #XM delivery remain
unsupported. See [numerical scope](../../../docs/simd-floating-point.md).

## Packed arithmetic

`packed.c` / `packed.exe` use explicit ADDPS/PD, SUBPS/PD, MULPS/PD, DIVPS/PD
and SQRTPS/PD in register and aligned memory forms. A four-vertex 3D pipeline
calculates lengths, normalizes coordinates, scales them and applies translation.
Expected lane encodings are constants. The fixture also checks all four rounding
modes, DAZ, signed FTZ outputs, NaNs and mixed-lane exception flags.

Build with `npm run build:packed-sse`; the deterministic MinGW script needs only
Kernel32 imports. `npm test` runs the PE32 binary through the normal runtime.
`npm run test:packed-sse` tests actual EXE and ZIP uploads in Chromium, including
static/deployed hosting via `WINEBROWSER_TEST_URL`.

`packed-oracle.c` is an independent x86 native reference compiled by the Linux
x86_64 unit tests. Its SIGFPE handler reads MXCSR and the unchanged destination
from the kernel's saved CPU context. Tests compare 3,600 instruction/control/
operand combinations, including unmasked exceptions across different lanes.
The runtime currently stops with a diagnostic on unmasked exceptions; it does
not deliver guest #XM handlers. macOS can compare the 1,680 masked cases under
Rosetta with `WINEBROWSER_SSE_ORACLE=rosetta node --test tests/cpu-packed-sse.test.js`;
unmasked trap verification requires Linux x86 hardware.
