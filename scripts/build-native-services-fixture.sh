#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
native_services_build=.scratch/native-services-build
mkdir -p "$native_services_build"
i686-w64-mingw32-windres tests/fixtures/native-services/native-services.rc -o "$native_services_build/version.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin -fno-stack-protector \
  -fno-ident -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console \
  tests/fixtures/native-services/native-services.c "$native_services_build/version.o" \
  -lkernel32 -luser32 -lshlwapi -lversion -ladvapi32 -lbcrypt \
  -o tests/fixtures/native-services/native-services.exe
i686-w64-mingw32-strip --strip-all tests/fixtures/native-services/native-services.exe
