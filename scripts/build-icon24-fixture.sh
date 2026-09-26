#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 tests/fixtures/icon24/generate.py
icon24_build_dir=$(mktemp -d)
trap 'rm -rf "$icon24_build_dir"' EXIT
i686-w64-mingw32-windres -I tests/fixtures/icon24 -i tests/fixtures/icon24/icon24.rc -O coff -o "$icon24_build_dir/icon.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/icon24/icon24.c "$icon24_build_dir/icon.o" -o tests/fixtures/icon24/icon24.exe -lkernel32 -luser32
i686-w64-mingw32-strip --strip-all tests/fixtures/icon24/icon24.exe
python3 - <<'PY'
from pathlib import Path
path = Path('tests/fixtures/icon24/icon24.exe')
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
PY
