# Extended-precision transcendental execution

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
The implementation does not yet cover the remaining x87 transcendental,
environment-save/restore or exception-delivery instructions.

## Sine, cosine and classification

`FSIN`, `FCOS` and `FSINCOS` share a bounded integer implementation. Machin's
identity supplies pi intervals; reduction to a quadrant and alternating Taylor
series supply sine/cosine intervals. Bounds are refined until result bytes,
exception bits and rounding direction agree. Tiny arguments use analytic
bounds that preserve directed rounding even for the smallest ext80 subnormal.
Both signs of zero are preserved. Finite inputs with magnitude at least 2^63
set C2 and leave the operand and stack unchanged. Infinities, unsupported
formats, NaNs, denormals and FSINCOS stack-capacity checks are handled separately.
FSINCOS leaves cosine at ST(0) and sine at ST(1).

These results target mathematical sine and cosine. They do not reproduce the
finite-pi argument-reduction errors of a particular Intel processor, which can
be substantial for large arguments, as Intel explains in its
[x87 comparison](https://www.intel.com/content/www/us/en/developer/articles/technical/the-difference-between-x87-instructions-and-mathematical-functions.html).
Programs depending on those exact hardware approximation errors are not verified.

`FXAM` reads the raw ST(0) value and tag to set the normal, zero, denormal,
infinity, NaN, unsupported or empty classification, plus the sign in C1. It
does not modify the operand or raise a floating-point exception, including when
the slot is empty or contains a signaling NaN.

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

`scripts/generate-x87-trig-vectors.py` independently uses Decimal arithmetic
and Chudnovsky pi to generate 224 sine/cosine cases across all rounding modes.
It increases precision for tiny inputs and includes nearby ext80 encodings of
pi multiples, large in-range arguments and deterministic random values. The
native `trigonometry.exe` fixture executes all three opcodes and checks exact
bytes, C1/C2, exceptions and stack order. Rebuild with `npm run build:x87-trig`
and run the isolated Chromium check with `npm run test:x87-trig`; its result is
in `evidence/x87-trig-browser-results.json`. Unit tests add range rejection,
precision-control independence, special values, stack faults and FXAM classes.

Instruction and exception semantics follow Intel's
[Software Developer's Manual](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf#page=1111),
Volume 2A, FYL2X, and Volume 1's x87 rounding/precision and transcendental-accuracy
discussion. Interval bounds and the Decimal oracle are repository-owned code.

## FSCALE

`FSCALE` multiplies `ST(0)` by `2^trunc(ST(1))`, truncating the scale toward
zero. Alignment is exact and exponent-only, so the implementation shifts the
operand's unbounded significand by the truncated scale and feeds the result
through the same dyadic rounding used by the other instructions. Precision
control does not apply; rounding control does, including the C1 direction and
the shared #O/#U/#P accounting. The scale count is saturated at 2^15 because a
larger count has already overflowed or underflowed every finite operand, which
reproduces the instruction's own bounded exponent add for `|scale| >= 2^16`.

Special cases follow the documented FSCALE table: unsigned zeros and infinities
per `ST(1)` class, quieted NaNs with SoftFloat `propagateNaNExtF80UI`
precedence, and the indefinite result for unsupported encodings or a
zero-times-infinite product.

`scripts/generate-x87-scale-vectors.py` is an independent oracle that forms the
exact rational product, truncates `ST(1)` with Python integer arithmetic and
rounds with its own extended-format routine. Its 161 vectors cover both scale
directions, fractional and subnormal scales, gradual underflow, overflow,
directed rounding, ordinary and signaling NaNs, unsupported encodings and exact
low-bit preservation. The native `tests/fixtures/x87/scale.exe` executes those
vectors through real x87 opcodes and compares bytes, exception bits, C1 and the
stack top. Rebuild with `npm run build:x87-scale`; `npm run test:x87-scale`
runs the isolated Chromium check and writes
`evidence/x87-scale-browser-results.json`.
