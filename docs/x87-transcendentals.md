# Extended-precision logarithm execution

`FYL2X` computes `ST(1) * log2(ST(0))`, writes ST(1), then pops the x87 stack.
The runtime performs this operation directly on the guest's 80-bit encodings.
It does not narrow operands to JavaScript `Number`, so inputs outside binary64's
range and low significand bits near one survive. The result has 64 significand
bits regardless of the x87 precision-control setting; rounding-control modes
remain effective.

The implementation in `src/x87-transcendentals.js` separates the integral binary
exponent from a significand in [1, 2). It computes the significand logarithm with
the positive atanh series, using outward-rounded BigInt intervals for every
operation and an explicit bound on the omitted tail. Division by an independently
bounded ln(2) yields log2 bounds. Multiplication by ST(1) remains exact integer
arithmetic before the final extended-format rounding. Powers of two take an
exact integer-logarithm path.

Computation begins with 192 fractional bits. If both interval endpoints do not
produce the same result bytes, exception flags and C1 rounding direction,
precision doubles up to 6,144 bits. An unresolved interval fails explicitly.
The integer rounding code handles signed results, gradual underflow, directed
rounding and overflow across the complete extended exponent range.

Special cases include signed zeros, infinities, NaNs, invalid encodings,
denormal operands and stack faults. An unmasked exception stops execution before
the destination is replaced or popped, consistent with the runtime's existing
explicit exception boundary. Delivery to a Windows guest SEH handler remains
unimplemented. This is not a claim of bit-for-bit agreement with every physical
x87 implementation's transcendental approximation or NaN-payload selection.
Other transcendental instructions, including the current BASS startup stop at
`FSIN`, remain unfinished.

## Verification

`scripts/generate-x87-log-vectors.py` is an independent oracle using Python
Decimal logarithms at 320 decimal digits. It generates 204 vectors covering all
four rounding modes, the nearest representable numbers above/below one,
extended exponent ranges, subnormal inputs/results, exact powers of two,
overflow and deterministic random inputs. It does not call the runtime's
algorithm. JavaScript tests also check exceptional inputs, precision-control
independence, unchanged integer flags and unmasked/stack-fault behavior.

The native `tests/fixtures/x87/logarithm.exe` executes actual x87 opcodes over
the same oracle data and compares result bytes, exception flags, C1 and stack
top. `npm run build:x87-log` rebuilds the fixture with normalized PE headers;
`npm run test:x87-log` runs it in an isolated Chromium worker and writes
`evidence/x87-log-browser-results.json`. `npm test` runs it through the Node
runtime as well. These are correctness checks, not application benchmarks.

Instruction and exception semantics follow Intel's
[Software Developer's Manual](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf#page=1111),
Volume 2A, FYL2X, and Volume 1's x87 rounding/precision and transcendental-accuracy
discussion. Interval bounds and the Decimal oracle are repository-owned code.
