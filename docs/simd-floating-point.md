# SSE floating-point execution

The PE32 translator executes legacy ADDSS/SD, SUBSS/SD, MULSS/SD, DIVSS/SD,
SQRTSS/SD, CVTSI2SS/SD (int32), CVT(T)SS/SD2SI (int32), CVTSS2SD, CVTSD2SS,
COMISS/SD and UCOMISS/SD. Register and memory forms use the same path, read
exactly the scalar operand width, and preserve the untouched XMM lanes.
ADDPS/PD, SUBPS/PD, MULPS/PD, DIVPS/PD and SQRTPS/PD execute all four binary32
or two binary64 lanes. Packed memory operands read a checked, aligned 16-byte
range. Packed square root uses only the source vector.
MOVAPD and MOVUPD copy all 128 bits; memory MOVAPD requires 16-byte alignment.

`src/simd-float.js` calls the pinned generic SoftFloat Wasm module's direct
binary32/binary64 ABI. It does not narrow ext80 intermediates or perform
arithmetic through JavaScript numbers. Int32-to-binary64 is exact and retains
the existing cheaper path. The module loads only when a translated block needs
floating arithmetic; the existing x87 initialization shares its Wasm instance,
but scratch storage and control state are separate.

Each guest CPU starts with MXCSR `0x1f80`. LDMXCSR and STMXCSR use checked
four-byte memory operations; reserved high bits fault. The four rounding modes,
sticky IEEE exception flags, denormal input status, DAZ and FTZ are represented.
DAZ preserves input signs; FTZ produces signed zero and underflow/precision
flags when underflow is masked. Exact tiny results report underflow when that
exception is unmasked. Integer conversion does not report denormal-operand
exceptions. Invalid operands, NaNs and zero-divide take priority over denormal
operands. Unmasked pre-computation exceptions suppress post-computation flags.
Packed instructions accumulate exceptions across every lane before committing
the result. An unmasked pre-computation exception in any lane suppresses new
post-computation flags for the whole instruction, while existing sticky flags
remain set. An unmasked exception preserves the destination and EFLAGS and stops with an
explicit diagnostic; delivering a guest #XM/SEH handler is not implemented.

Guest callbacks snapshot and restore all eight XMM registers and MXCSR, including
exceptional returns. x87 control/status remains independent. Packed comparisons,
min/max, conversions, AVX, MXCSR environment save/restore instructions, x64 integer
conversions, and full CPU/SIMD compatibility remain unfinished.

## Verification

- `npm run test:softfloat`: direct IEEE rounding, conversions, NaNs, flags and
  ABI validation, plus the existing ext80 adapter checks.
- `npm test`: actual x86 instruction decoding/emission, register/memory forms,
  upper-lane and integer-flag preservation, all rounding modes, DAZ/FTZ,
  exception priority, unmasked fault atomicity and callback restoration.
- `npm run test:scalar-sse`: the repository-owned native Windows executable runs
  through the normal translator in an isolated Chromium worker. Its expected
  encodings are constants and a failure returns the C source line. Evidence is
  `evidence/scalar-sse-browser-results.json`.
- `npm run test:packed-sse`: native Windows EXE and ZIP uploads execute ten packed
  opcodes and a four-vertex 3D normalization/transform pipeline through the actual
  browser application. It also verifies rounding, DAZ/FTZ and mixed-lane flags.
  Set `WINEBROWSER_TEST_URL` to test a static or deployed site. Evidence is
  `evidence/packed-sse-browser-results.json`.
- Linux x86_64 unit tests compile `tests/fixtures/sse/packed-oracle.c` and compare
  3,600 packed cases against native SSE instructions, including all six unmasked
  exceptions, lane permutations, NaNs, signed zeros and denormals. On macOS,
  `WINEBROWSER_SSE_ORACLE=rosetta` checks 1,680 masked cases independently; Rosetta
  does not deliver unmasked SIMD traps, so Linux hardware CI checks those.

This verifies a defined instruction subset. It does not establish arbitrary
Windows program compatibility, native speed, or complete DirectX support.

## Primary references

- [Intel Software Developer's Manual](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf),
  volume 1 sections 4.9.2, 10.2.3 and 11.5; volume 2 scalar and packed SSE instruction entries.
- [Berkeley SoftFloat interface](https://www.jhauser.us/arithmetic/SoftFloat-3/doc/SoftFloat.html),
  direct binary32/binary64 operations and explicit integer-conversion rounding.
