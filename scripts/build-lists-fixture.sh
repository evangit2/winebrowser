#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/lists/lists.c -o tests/fixtures/lists/lists.exe -lkernel32 -luser32 -ladvapi32 -lgdi32 -lcomctl32
i686-w64-mingw32-strip --strip-all tests/fixtures/lists/lists.exe
python3 - <<'PY'
from pathlib import Path
path = Path('tests/fixtures/lists/lists.exe')
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
PY
