#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
dialog_fonts_build_dir=$(mktemp -d)
trap 'rm -rf "$dialog_fonts_build_dir"' EXIT
i686-w64-mingw32-windres -i tests/fixtures/dialog-fonts/resources.rc -O coff -o "$dialog_fonts_build_dir/resources.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -fno-asynchronous-unwind-tables -fno-unwind-tables -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 tests/fixtures/dialog-fonts/client.c "$dialog_fonts_build_dir/resources.o" -o tests/fixtures/dialog-fonts/dialog-fonts.exe -lkernel32 -luser32 -lgdi32
i686-w64-mingw32-strip --strip-all tests/fixtures/dialog-fonts/dialog-fonts.exe
python3 - <<'PY'
from pathlib import Path
path = Path('tests/fixtures/dialog-fonts/dialog-fonts.exe')
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
PY
