#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for mode in metadata metadata-native; do
  native_flag=""
  if [ "$mode" = metadata-native ]; then native_flag="-DNATIVE_TEST"; fi
  SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
    -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
    -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
    -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
    $native_flag tests/fixtures/file-metadata/metadata.c -o "tests/fixtures/file-metadata/$mode.exe" -lkernel32
  i686-w64-mingw32-strip --strip-all "tests/fixtures/file-metadata/$mode.exe"
done
python3 - <<'PY'
from pathlib import Path
for name in ('metadata', 'metadata-native'):
    path = Path(f'tests/fixtures/file-metadata/{name}.exe')
    data = bytearray(path.read_bytes())
    pe = int.from_bytes(data[0x3c:0x40], 'little')
    data[pe + 8:pe + 12] = bytes(4)
    data[pe + 88:pe + 92] = bytes(4)
    path.write_bytes(data)
PY
