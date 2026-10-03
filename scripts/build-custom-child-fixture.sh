#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .scratch/custom-child-build
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib -shared \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
  -Wl,--entry,_DllMain@12 -Wl,--out-implib,.scratch/custom-child-build/control.a \
  tests/fixtures/custom-child/control.c -o tests/fixtures/custom-child/control.dll -lkernel32 -luser32 -lgdi32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
  -Wl,--entry,_start -Wl,--subsystem,console \
  tests/fixtures/custom-child/client.c .scratch/custom-child-build/control.a \
  -o tests/fixtures/custom-child/custom-child.exe -lkernel32 -luser32 -lgdi32
i686-w64-mingw32-strip --strip-all tests/fixtures/custom-child/control.dll tests/fixtures/custom-child/custom-child.exe
