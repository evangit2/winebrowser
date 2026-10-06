#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -fno-asynchronous-unwind-tables -fno-unwind-tables -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 tests/fixtures/gdi-screen/client.c -o tests/fixtures/gdi-screen/gdi-screen.exe -lkernel32 -luser32 -lgdi32
i686-w64-mingw32-strip --strip-all tests/fixtures/gdi-screen/gdi-screen.exe
