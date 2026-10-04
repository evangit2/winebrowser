#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
property_sheet_build_dir=$(mktemp -d)
trap 'rm -rf "$property_sheet_build_dir"' EXIT
i686-w64-mingw32-windres -i tests/fixtures/property-sheet/resources.rc -O coff -o "$property_sheet_build_dir/resources.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib -shared -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_DllMain@12 -Wl,--kill-at tests/fixtures/property-sheet/library.c "$property_sheet_build_dir/resources.o" -o tests/fixtures/property-sheet/settings-pages.dll -lkernel32 -luser32 -lcomctl32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -fno-asynchronous-unwind-tables -fno-unwind-tables -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 tests/fixtures/property-sheet/client.c -o tests/fixtures/property-sheet/property-sheet.exe -lkernel32 -luser32 -lcomctl32
i686-w64-mingw32-strip --strip-all tests/fixtures/property-sheet/property-sheet.exe tests/fixtures/property-sheet/settings-pages.dll
python3 - <<'PY'
from pathlib import Path
for name in ('property-sheet.exe', 'settings-pages.dll'):
    path = Path('tests/fixtures/property-sheet') / name
    data = bytearray(path.read_bytes())
    pe = int.from_bytes(data[0x3c:0x40], 'little')
    data[pe + 8:pe + 12] = bytes(4)
    data[pe + 88:pe + 92] = bytes(4)
    path.write_bytes(data)
PY
