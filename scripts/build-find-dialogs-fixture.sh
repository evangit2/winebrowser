#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
find_dialogs_build_dir=$(mktemp -d)
trap 'rm -rf "$find_dialogs_build_dir"' EXIT
i686-w64-mingw32-windres -i tests/fixtures/find-dialogs/resources.rc -O coff -o "$find_dialogs_build_dir/resources.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib -shared \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_DllMain@12 -Wl,--kill-at \
  tests/fixtures/find-dialogs/library.c "$find_dialogs_build_dir/resources.o" -o tests/fixtures/find-dialogs/find-resources.dll -lkernel32 -luser32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/find-dialogs/client.c -o tests/fixtures/find-dialogs/find-dialogs.exe -lkernel32 -luser32 -lcomdlg32
i686-w64-mingw32-strip --strip-all tests/fixtures/find-dialogs/find-dialogs.exe tests/fixtures/find-dialogs/find-resources.dll
python3 - <<'PY'
from pathlib import Path
for name in ('find-dialogs.exe', 'find-resources.dll'):
    path = Path('tests/fixtures/find-dialogs') / name
    data = bytearray(path.read_bytes())
    pe = int.from_bytes(data[0x3c:0x40], 'little')
    data[pe + 8:pe + 12] = bytes(4)
    data[pe + 88:pe + 92] = bytes(4)
    path.write_bytes(data)
PY
