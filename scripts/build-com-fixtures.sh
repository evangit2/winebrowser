#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
com_fixture_dir=tests/fixtures/com
com_cflags='-m32 -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident -Wall -Wextra -Werror'
com_ldflags='-nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase'
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $com_cflags $com_ldflags -shared \
  -Wl,--kill-at -Wl,--entry,_DllMain@12 -Wl,--image-base,0x10000000 \
  "$com_fixture_dir/server.c" -o "$com_fixture_dir/counter.dll" -lkernel32 -luuid
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc $com_cflags $com_ldflags \
  -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  "$com_fixture_dir/client.c" -o "$com_fixture_dir/client.exe" -lole32 -ladvapi32 -lkernel32 -luuid
i686-w64-mingw32-strip --strip-all "$com_fixture_dir/client.exe" "$com_fixture_dir/counter.dll"
python3 - <<'PY'
from pathlib import Path
for name in ('client.exe', 'counter.dll'):
    path = Path('tests/fixtures/com') / name
    data = bytearray(path.read_bytes())
    pe = int.from_bytes(data[0x3c:0x40], 'little')
    data[pe + 8:pe + 12] = bytes(4)
    data[pe + 88:pe + 92] = bytes(4)
    path.write_bytes(data)
PY
