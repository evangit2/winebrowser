#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-ident -fno-optimize-sibling-calls -Wall -Wextra -Werror -nostdlib -shared \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_DllMain@12 -Wl,--kill-at \
  tests/fixtures/gdi-objects/library.c -o tests/fixtures/gdi-objects/native-fonts.dll -lkernel32 -lgdi32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/gdi-objects/client.c -o tests/fixtures/gdi-objects/gdi-objects.exe -lkernel32 -luser32 -lgdi32
i686-w64-mingw32-strip --strip-all tests/fixtures/gdi-objects/gdi-objects.exe tests/fixtures/gdi-objects/native-fonts.dll
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/gdi-objects/chooser.c -o tests/fixtures/gdi-objects/font-chooser.exe -lkernel32 -luser32 -lgdi32 -lcomdlg32
i686-w64-mingw32-strip --strip-all tests/fixtures/gdi-objects/font-chooser.exe
python3 - <<'PY'
from pathlib import Path
for name in ('gdi-objects.exe', 'native-fonts.dll', 'font-chooser.exe'):
    path = Path('tests/fixtures/gdi-objects') / name
    data = bytearray(path.read_bytes())
    pe = int.from_bytes(data[0x3c:0x40], 'little')
    # GNU strip rewrites the COFF timestamp; neither this nor a PE checksum is
    # needed by the native loader. Keep rebuilds independent of wall time.
    data[pe + 8:pe + 12] = bytes(4)
    data[pe + 88:pe + 92] = bytes(4)
    path.write_bytes(data)
PY
