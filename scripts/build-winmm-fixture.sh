#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-ident -Wall -Wextra \
  -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
  -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/winmm/mixer.c -o tests/fixtures/winmm/mixer.exe -lwinmm -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/winmm/mixer.exe
# Some MinGW builds stamp headers again during stripping.
python3 - <<'PY'
from pathlib import Path
path = Path('tests/fixtures/winmm/mixer.exe')
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
PY
