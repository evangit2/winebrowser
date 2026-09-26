# Native file mapping fixtures

`npm run build:sections` builds `sections.exe` and `sections-native.exe` from the
same freestanding source. Neither executable embeds translated guest code or Wine.
The fixture generates 65,573 deterministic bytes, maps whole/partial views, checks
all bytes and page tails, closes handles before using views, rejects collisions
and unaligned offsets, and unmaps through interior addresses. A supplied
`payload.bin` sidecar is mapped and checked by the same path.

`npm run test:sections` uses normal EXE, loose sidecar, and nested ZIP uploads.
`npm run test:sections-native -- <wine-dll-dir> <nls-dir> [--browser]` uses actual
Wine base DLLs plus additional NT create/map/query assertions. See
[implemented scope and limits](../../../docs/file-sections.md).
