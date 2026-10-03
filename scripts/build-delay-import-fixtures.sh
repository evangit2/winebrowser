#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
task_tmp=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-delay.XXXXXX")
trap 'rm -rf "$task_tmp"' EXIT HUP INT TERM
flags='-m32 -mno-sse -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase'
i686-w64-mingw32-dlltool --input-def tests/fixtures/delay-imports/delayed.def --dllname delayed.dll --output-delaylib "$task_tmp/libdelayed.a"
i686-w64-mingw32-dlltool --input-def tests/fixtures/delay-imports/optional.def --dllname absent-optional.dll --output-delaylib "$task_tmp/liboptional.a"
i686-w64-mingw32-dlltool --input-def tests/fixtures/delay-imports/crt.def --dllname msvcrt.dll --output-delaylib "$task_tmp/libcrt.a"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $flags -shared -Wl,--image-base,0x10000000 -Wl,--entry,_DllMain@12 tests/fixtures/delay-imports/delayed.c tests/fixtures/delay-imports/delayed.def -o tests/fixtures/delay-imports/delayed.dll
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $flags -Wl,--entry,_start -Wl,--subsystem,console tests/fixtures/delay-imports/delay-imports.c "$task_tmp/libdelayed.a" "$task_tmp/liboptional.a" "$task_tmp/libcrt.a" -lmingwex -lkernel32 -o tests/fixtures/delay-imports/delay-imports.exe
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $flags -DNATIVE_RESOLVER -Wl,--entry,_start -Wl,--subsystem,console tests/fixtures/delay-imports/delay-imports.c "$task_tmp/libdelayed.a" "$task_tmp/liboptional.a" "$task_tmp/libcrt.a" -lmingwex -lkernel32 -o tests/fixtures/delay-imports/delay-native.exe
i686-w64-mingw32-strip --strip-all tests/fixtures/delay-imports/delay-native.exe
i686-w64-mingw32-strip --strip-all tests/fixtures/delay-imports/delayed.dll tests/fixtures/delay-imports/delay-imports.exe
python3 - <<'PYCODE'
from pathlib import Path
import struct
for name in ['delay-imports.exe', 'delay-native.exe', 'delayed.dll']:
    path = Path('tests/fixtures/delay-imports') / name
    data = bytearray(path.read_bytes())
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    struct.pack_into('<I', data, pe + 8, 0)
    struct.pack_into('<I', data, pe + 88, 0)
    path.write_bytes(data)
PYCODE
