#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
accelerator_build_dir=$(mktemp -d)
trap 'rm -rf "$accelerator_build_dir"' EXIT
i686-w64-mingw32-windres -i tests/fixtures/accelerator-resources/resources.rc -O coff -o "$accelerator_build_dir/resources.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -fno-asynchronous-unwind-tables -fno-unwind-tables -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 tests/fixtures/accelerator-resources/client.c "$accelerator_build_dir/resources.o" -o tests/fixtures/accelerator-resources/accelerator-resources.exe -lkernel32 -luser32
i686-w64-mingw32-strip --strip-all tests/fixtures/accelerator-resources/accelerator-resources.exe
python3 - <<'PY'
from pathlib import Path
path = Path('tests/fixtures/accelerator-resources/accelerator-resources.exe')
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
PY
