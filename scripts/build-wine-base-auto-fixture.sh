#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp \
  -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat -Wl,--entry,_mainCRTStartup \
  -Wl,--subsystem,console tests/fixtures/wine-base-auto/main.c \
  -o tests/fixtures/wine-base-auto/native-base.exe -lkernel32 -lntdll
i686-w64-mingw32-strip --strip-all tests/fixtures/wine-base-auto/native-base.exe
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp \
  -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat -Wl,--entry,_mainCRTStartup \
  -Wl,--subsystem,console tests/fixtures/wine-base-auto/dynamic.c \
  -o tests/fixtures/wine-base-auto/dynamic-base.exe -lkernel32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -shared -m32 -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--entry,0 \
  tests/fixtures/wine-base-auto/helper.c -o tests/fixtures/wine-base-auto/helper.dll -lntdll
i686-w64-mingw32-strip --strip-all tests/fixtures/wine-base-auto/dynamic-base.exe tests/fixtures/wine-base-auto/helper.dll
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -shared -m32 -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--entry,0 \
  tests/fixtures/wine-base-auto/helper-crt.c -o tests/fixtures/wine-base-auto/helper-crt.dll -lmsvcrt
i686-w64-mingw32-strip --strip-all tests/fixtures/wine-base-auto/helper-crt.dll
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -DVERIFY_NATIVE_CRT -m32 -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp \
  -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat -Wl,--entry,_mainCRTStartup \
  -Wl,--subsystem,console tests/fixtures/wine-base-auto/dynamic.c \
  -o tests/fixtures/wine-base-auto/dynamic-crt.exe -lkernel32
i686-w64-mingw32-strip --strip-all tests/fixtures/wine-base-auto/dynamic-crt.exe
python3 - <<'PY' 
from pathlib import Path
for p in Path('tests/fixtures/wine-base-auto').iterdir():
    if p.suffix not in ['.exe','.dll']: continue
    b=bytearray(p.read_bytes());pe=int.from_bytes(b[0x3c:0x40],'little');b[pe+88:pe+92]=bytes(4);p.write_bytes(b)
PY
