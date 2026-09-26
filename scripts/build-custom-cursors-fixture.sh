#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 tests/fixtures/custom-cursors/generate.py
cursor_build_dir=$(mktemp -d)
trap 'rm -rf "$cursor_build_dir"' EXIT
i686-w64-mingw32-windres -I tests/fixtures/custom-cursors -i tests/fixtures/custom-cursors/cursors.rc -O coff -o "$cursor_build_dir/cursors.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/custom-cursors/main.c "$cursor_build_dir/cursors.o" -o tests/fixtures/custom-cursors/cursors.exe -lkernel32 -luser32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -shared -nostdlib -Wl,--entry,0 -Wl,--no-insert-timestamp \
  "$cursor_build_dir/cursors.o" -o tests/fixtures/custom-cursors/cursors.dll
for file in tests/fixtures/custom-cursors/cursors.exe tests/fixtures/custom-cursors/cursors.dll; do
  i686-w64-mingw32-strip --strip-all "$file"
done
python3 - <<'PY'
from pathlib import Path
for p in [Path('tests/fixtures/custom-cursors/cursors.exe'),Path('tests/fixtures/custom-cursors/cursors.dll')]:
    b=bytearray(p.read_bytes());pe=int.from_bytes(b[0x3c:0x40],'little');b[pe+88:pe+92]=bytes(4);p.write_bytes(b)
PY
