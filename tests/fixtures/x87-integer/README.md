# Native x87 integer arithmetic fixture

This freestanding PE32 contains FIADD, FIMUL, FISUB, FISUBR, FIDIV, FIDIVR,
FICOM and FICOMP for both signed int16 and int32 memory operands. Inline assembly
checks native result/status values, comparison pop counts, all four rounding
modes for 1/3, and ext80 bytes/C1. The application is translated from its original
x86 bytes in Node and Chromium; no application-specific Wasm is supplied.

Rebuild with `npm run build:x87-integer`. `npm test` also verifies signed extrema,
exact conversion before precision rounding, ext80 low-bit cancellation,
24/53/64-bit precision, all rounding modes for both signs, inexact/overflow and C1,
NaN comparison/pop behavior, unmasked divide-by-zero, preserved integer flags,
and memory-fault atomicity. Expected rational outputs are derived with integer
arithmetic independently of SoftFloat.

`npm run test:x87-integer` records native browser results and the binary hash in
`evidence/x87-integer-browser-results.json`. This instruction family reuses the
existing SoftFloat ext80 core; a binary-rational magnitude comparison supplies
C1 only when the result is inexact. General guest exception delivery and the
remaining x87/SIMD instruction families remain unfinished.

Primary instruction reference: Intel's
[Software Developer's Manual, Volume 2A](https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-2a-manual.pdf),
under FADD/FIADD, FMUL/FIMUL, FSUB/FISUB, FSUBR/FISUBR, FDIV/FIDIV,
FDIVR/FIDIVR and FICOM/FICOMP.
