# Native scalar SSE fixture

This repository-owned PE32 program uses explicit native `MOVSD`, `MOVSS` and
signed-int32 `CVTSI2SD` instructions. It checks register upper-lane preservation,
zeroed upper lanes on memory loads, unaligned scalar transfers, store bounds,
and exact conversion values including both signed-int32 extrema and 16,777,217.
Expected floating-point encodings are constants, not results of a second guest
conversion. A nonzero exit code identifies the failing C source line.

Build with `npm run build:scalar-sse` using MinGW i686. The script strips symbols
and normalizes PE timestamps/checksums. `npm test` runs it through the normal
runtime in Node; `npm run test:scalar-sse` runs it in an isolated Chromium worker
and saves `evidence/scalar-sse-browser-results.json`. The unit tests also verify
memory-fault atomicity, integer flag preservation and the distinction between
scalar SSE `MOVSD` and `REP MOVSD` string copying.

These tests cover data movement and an exact integer conversion. They do not
claim support for SSE floating-point arithmetic, MXCSR, packed floating-point
instructions, AVX or x64 integer conversions.
