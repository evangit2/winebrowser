# Exact x87 remainder execution

`FPREM` truncates the quotient toward zero. `FPREM1` rounds it to the nearest
integer, with ties to even. Both leave the divisor at ST(1) and replace ST(0)
with the exact extended-precision remainder, independent of precision and
rounding control. The result never passes through binary64.

The implementation unpacks the guest's ext80 significands and exponents and
performs exact integer division on dyadic values. If the exponent difference
is at least 64, a permitted 32-bit partial reduction sets C2; the guest repeats
the instruction until C2 clears. A completed reduction maps the quotient's
three low magnitude bits to C0, C3 and C1. Signed zero, denormal operands,
infinite divisors, invalid infinite dividends/zero divisors, NaNs, unsupported
encodings and empty-stack faults follow the existing x87 exception boundary.
Unmasked exceptions stop before replacing the operands.

`tests/fixtures/x87-remainder-vectors.json` contains 422 independent cases.
Python's `fractions.Fraction`, `int()` and ties-to-even `round()` provide the
finite mathematical oracle. An independently compiled x86 x87 program supplies
exceptional encodings and optionally audits finite results. Rosetta 2 disagreed
with seven large-quotient FPREM1 cases; those finite results use the exact
rational oracle. This is not a claim that Rosetta is physical Intel hardware.

Unit tests check byte results, flags, partial-loop termination, unchanged ST(1),
stack TOP and integer flags across three precision settings and four rounding
modes. The authored unchanged `remainder.exe` runs the same cases through real
guest instructions in the browser, reports `X87 REMAINDER PASS` and exits zero.

```sh
python3 scripts/generate-x87-remainder-vectors.py # requires x86 host or Rosetta
python3 scripts/generate-x87-remainder-vectors.py --check-native # x86 host audit
sh scripts/build-x87-remainder.sh
node scripts/test-x87-remainder-browser.mjs
```

The byte-table `XLAT` instruction also compiles to Wasm. It checks the byte load,
preserves upper EAX/other registers/flags, uses unsigned AL, supports 16-bit
offset wrapping and the current FS base, and records the faulting instruction.
Unsupported segment overrides and LOCK prefixes still fail explicitly.

Instruction semantics follow Intel's
[Software Developer's Manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html),
Volume 2's FPREM/FPREM1 and XLAT entries.
