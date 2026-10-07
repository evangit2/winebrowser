# Native packed SSE/SSE2 matrix

MIT-licensed `client.c` executes real x86 SSE/SSE2 instructions, writes each
instruction's four raw result words and MXCSR, and exits zero. It does not
calculate floating-point reference answers in C or JavaScript. The matrix has
8,400 records: 75 operations, register/memory forms, eight operand pairs and
seven controls covering all rounding modes, DAZ and FTZ. Data includes signed
zeros, denormals, NaNs, infinities and conversion/overflow boundaries.

`native-oracle.bin` is independent native output. The same C source builds a
native x86_64 reference with `WB_SSE_ORACLE`; CI executes it on Linux x86_64 and
requires byte identity with the retained answers. The Windows i386 version
also matches under Wine 11 on macOS/Rosetta. The source/data hashes and
reference provenance are in `native-oracle.json`.

```sh
npm run build:packed-sse
npm run test:packed-sse-oracle
npm run test:packed-sse
```

The browser test uploads the PE32 through the normal UI and compares its actual
output file. `WINEBROWSER_TEST_URL` selects a Pages host and
`PACKED_SSE_EVIDENCE` selects the metadata report. Separate unit tests check
alignment/range failures, unmasked-exception destination preservation, aliasing,
64-bit shift counts and sign-bit extraction. Complete SSE-family CPUID bits,
MMX, AVX and guest SIMD exception delivery remain unsupported.
