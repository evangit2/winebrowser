#!/bin/sh
set -eu
export SOURCE_DATE_EPOCH=0
cd "$(dirname "$0")/.."
for mode in native host; do
  guest_drive_flags=''
  guest_drive_libraries='-luser32 -lgdi32 -lcomdlg32'
  guest_drive_output=guest-drive.exe
  if [ "$mode" = host ]; then
    guest_drive_flags=-DVOLUME_HOST
    guest_drive_libraries=''
    guest_drive_output=guest-drive-host.exe
  fi
  i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
    -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
    -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
    -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,windows $guest_drive_flags \
    tests/fixtures/guest-drive/client.c -o "tests/fixtures/guest-drive/$guest_drive_output" \
    -lkernel32 $guest_drive_libraries
  i686-w64-mingw32-strip --strip-all "tests/fixtures/guest-drive/$guest_drive_output"
done
