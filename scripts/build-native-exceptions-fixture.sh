#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console \
  tests/fixtures/native-exceptions/client.c -o tests/fixtures/native-exceptions/native-exceptions.exe -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/native-exceptions/native-exceptions.exe
