# Integer arithmetic fixture

`npm run build:wide-math` builds a freestanding PE32 executable from `wide-math.c`.
Inline assembly checks byte, word and dword MUL/IMUL/DIV/IDIV outputs, carry and
overflow, signed quotient/remainder, register preservation, and AH source aliasing.
`npm run test:wide-math` uploads the EXE and ZIP through the ordinary browser UI.
See [scope and fault tests](../../../docs/wide-integer-arithmetic.md).
