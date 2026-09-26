#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for version in 8 9; do
    flags=''
    if [ "$version" = 8 ]; then flags='-DTEST_D3D8'; fi
    SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin \
      -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
      -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp \
      -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat -Wl,--entry,_mainCRTStartup \
      -Wl,--subsystem,windows $flags tests/fixtures/lighting/main.c \
      -o "tests/fixtures/lighting/d3d$version.exe" "-ld3d$version" -luser32 -lkernel32
    i686-w64-mingw32-strip --strip-all "tests/fixtures/lighting/d3d$version.exe"
done
python3 - <<'PY'
from pathlib import Path
for p in Path('tests/fixtures/lighting').glob('*.exe'):
    b=bytearray(p.read_bytes());pe=int.from_bytes(b[0x3c:0x40],'little');b[pe+88:pe+92]=bytes(4);p.write_bytes(b)
PY
