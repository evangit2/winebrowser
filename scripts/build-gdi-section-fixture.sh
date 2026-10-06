#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export SOURCE_DATE_EPOCH=1
i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -fno-asynchronous-unwind-tables -fno-unwind-tables -Wall -Wextra -Werror -nostdlib -shared -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--kill-at -Wl,--entry,_DllMain@12 tests/fixtures/gdi-section/producer.c -o tests/fixtures/gdi-section/bitmap-producer.dll -lmsvcrt
i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -fno-asynchronous-unwind-tables -fno-unwind-tables -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 tests/fixtures/gdi-section/client.c -o tests/fixtures/gdi-section/gdi-section.exe -lkernel32 -luser32 -lgdi32 -lmsvcrt
i686-w64-mingw32-strip --strip-all tests/fixtures/gdi-section/gdi-section.exe tests/fixtures/gdi-section/bitmap-producer.dll
