#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  tests/fixtures/installer-apis/installer-apis.c -o tests/fixtures/installer-apis/installer-apis.exe \
  -lkernel32 -luser32 -lgdi32 -lshell32 -llz32 -lcomctl32 -luuid
i686-w64-mingw32-strip --strip-all tests/fixtures/installer-apis/installer-apis.exe
