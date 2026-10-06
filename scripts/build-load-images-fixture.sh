#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export SOURCE_DATE_EPOCH=1
python3 tests/fixtures/resource-bitmaps/generate.py
python3 tests/fixtures/load-images/generate.py
load_images_build_dir=$(mktemp -d)
trap 'rm -rf "$load_images_build_dir"' EXIT
i686-w64-mingw32-windres -I tests/fixtures/load-images -I tests/fixtures/resource-bitmaps -i tests/fixtures/load-images/resources.rc -O coff -o "$load_images_build_dir/resources.o"
i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -fno-asynchronous-unwind-tables -fno-unwind-tables -Wall -Wextra -Werror -nostdlib -shared -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--kill-at -Wl,--entry,_DllMain@12 tests/fixtures/resource-bitmaps/library.c "$load_images_build_dir/resources.o" -o tests/fixtures/load-images/bitmap-resources.dll -lkernel32
i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-ident -fno-asynchronous-unwind-tables -fno-unwind-tables -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 tests/fixtures/load-images/client.c "$load_images_build_dir/resources.o" -o tests/fixtures/load-images/load-images.exe -lkernel32 -luser32 -lgdi32
i686-w64-mingw32-strip --strip-all tests/fixtures/load-images/load-images.exe tests/fixtures/load-images/bitmap-resources.dll
