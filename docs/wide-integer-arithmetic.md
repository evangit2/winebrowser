# Implicit-register integer arithmetic

The CPU implements the 8-, 16-, and 32-bit one-operand forms of `MUL`, `IMUL`,
`DIV`, and `IDIV`, with register and memory sources. BigInt preserves the complete
product/dividend before narrowing. Multiplication writes AX, DX:AX, or EDX:EAX;
division writes quotient/remainder to AL/AH, AX/DX, or EAX/EDX. Byte operations
preserve upper EAX and all EDX; word operations preserve both upper halves.
Aliased source registers, including AH and DX, are read before output changes.

Unsigned and signed multiplication set CF/OF from overflow into the upper half
or failure to sign-extend the lower half. Signed division truncates toward zero
and its nonzero remainder has the dividend's sign. Zero divisors and out-of-range
quotients fail before changing registers or flags. Memory-source failures also
preserve state. Undefined arithmetic flags retain the runtime's previous values;
software must not rely on their values matching a physical processor.

`tests/cpu-wide-math.test.js` verifies fixed signed/unsigned vectors through real
instruction decoding, register and memory sources, narrow-register preservation,
source aliases, zero/overflow faults and unmapped operands. Existing 16-bit
multi-operand IMUL tests remain separate. `npm run build:wide-math` builds a native
PE32 fixture and `npm run test:wide-math` runs its EXE/ZIP inline-assembly vectors
in Chrome; results are in `evidence/wide-math-browser-results.json`.

Contracts follow the MUL, IMUL, DIV and IDIV entries in the
[Intel instruction reference](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf).
General Windows exception delivery and x64 execution remain unfinished; divide
errors currently stop the guest with a diagnostic rather than enter an SEH handler.
