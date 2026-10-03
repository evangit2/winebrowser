#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for process_fixture in parent child; do
  SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin -fno-stack-protector \
    -fno-ident -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
    -Wl,--dynamicbase -Wl,--entry,__start -Wl,--subsystem,console \
    "tests/fixtures/processes/$process_fixture.c" -lkernel32 -luser32 \
    -o "tests/fixtures/processes/$process_fixture.exe"
  i686-w64-mingw32-strip --strip-all "tests/fixtures/processes/$process_fixture.exe"
done
