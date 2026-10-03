#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for variant in ddraw1 ddraw7 d3d7; do
    flags=''
    if [ "$variant" = ddraw1 ]; then flags='-DTEST_DDRAW1'; fi
    if [ "$variant" = d3d7 ]; then flags='-DTEST_D3D7'; fi
    SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin \
      -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
      -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp \
      -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat -Wl,--entry,_mainCRTStartup \
      -Wl,--subsystem,windows $flags tests/fixtures/directdraw/main.c \
      -o "tests/fixtures/directdraw/$variant.exe" -lddraw -ldxguid -luser32 -lkernel32
    i686-w64-mingw32-strip --strip-all "tests/fixtures/directdraw/$variant.exe"
done
