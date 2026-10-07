#!/bin/sh
set -eu
export SOURCE_DATE_EPOCH=0
cd "$(dirname "$0")/.."
python3 scripts/generate-gdi-pixel-cases.py --check
i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console \
  tests/fixtures/gdi-pixel-colors/client.c -o tests/fixtures/gdi-pixel-colors/gdi-pixel-colors.exe -lkernel32 -luser32 -lgdi32
i686-w64-mingw32-strip --strip-all tests/fixtures/gdi-pixel-colors/gdi-pixel-colors.exe
