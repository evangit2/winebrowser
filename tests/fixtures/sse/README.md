# Native scalar SSE fixture

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
and callbacks restore MXCSR on return or failure. Packed floating-point
instructions, AVX, x64 integer conversions and guest #XM delivery remain
unsupported. See [numerical scope](../../../docs/simd-floating-point.md).
