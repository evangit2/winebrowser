#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_mainCRTStartup -Wl,--subsystem,console \
  -Wl,--image-base,0x400000 tests/fixtures/exec-memory/exec-memory.c \
  -o tests/fixtures/exec-memory/exec-memory.exe -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/exec-memory/exec-memory.exe
python3 - <<'PY'
from pathlib import Path
path = Path('tests/fixtures/exec-memory/exec-memory.exe')
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
print(f'built {path} ({len(data)} bytes)')
PY
