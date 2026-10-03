#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console \
  tests/fixtures/lua/lua-client.c -lkernel32 -o tests/fixtures/lua/lua-client.exe
i686-w64-mingw32-strip --strip-all tests/fixtures/lua/lua-client.exe
python3 - <<'PYCODE'
from pathlib import Path
import struct
path = Path('tests/fixtures/lua/lua-client.exe')
data = bytearray(path.read_bytes())
pe = struct.unpack_from('<I', data, 0x3c)[0]
struct.pack_into('<I', data, pe + 8, 0)
struct.pack_into('<I', data, pe + 88, 0)
path.write_bytes(data)
PYCODE
