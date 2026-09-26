# String comparison fixture

`npm run build:cmps` compiles the original freestanding `cmps.c` into PE32.
Its inline assembly exercises unprefixed/repeated byte, word and dword CMPS,
both directions, count/index changes, arithmetic flags, zero count and long
repeats. `npm run test:cmps` uploads EXE and ZIP variants through the browser UI.
See [scope and independent unit coverage](../../../docs/string-comparisons.md).
