#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
driver_dir=tests/fixtures/drivers
driver_cflags='-m32 -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident -Wall -Wextra -Werror -Wno-cast-function-type'
driver_ldflags='-nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase'
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $driver_cflags $driver_ldflags -shared \
  -Wl,--kill-at -Wl,--entry,_DllMain@12 -Wl,--image-base,0x10000000 \
  "$driver_dir/driver.c" -o "$driver_dir/codec.dll" -lkernel32 -lwinmm
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $driver_cflags $driver_ldflags \
  -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  "$driver_dir/client.c" -o "$driver_dir/client.exe" -lwinmm -ladvapi32 -lkernel32
i686-w64-mingw32-strip --strip-all "$driver_dir/client.exe" "$driver_dir/codec.dll"
