#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .scratch/host-subclass-build
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib -shared \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
  -Wl,--entry,_DllMain@12 -Wl,--out-implib,.scratch/host-subclass-build/hook.a \
  tests/fixtures/host-subclass/hook.c -o tests/fixtures/host-subclass/hook.dll -lkernel32 -luser32 -lgdi32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-ident -Wall -Wextra -Werror -nostdlib \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
  -Wl,--entry,_start -Wl,--subsystem,console \
  tests/fixtures/host-subclass/client.c .scratch/host-subclass-build/hook.a \
  -o tests/fixtures/host-subclass/host-subclass.exe -lkernel32 -luser32 -lgdi32
i686-w64-mingw32-strip --strip-all tests/fixtures/host-subclass/hook.dll tests/fixtures/host-subclass/host-subclass.exe
