#!/bin/sh
set -eu
cd "$(dirname "$0")"
gui_settings_build_dir=$(mktemp -d)
trap 'rm -rf "$gui_settings_build_dir"' EXIT
i686-w64-mingw32-windres -i settings.rc -O coff -o "$gui_settings_build_dir/settings.o"
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-gcc -m32 -mno-sse -O1 -ffreestanding -fno-builtin \
  -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
  -Wl,--dynamicbase -Wl,--entry,_start -Wl,--subsystem,console -Wl,--image-base,0x400000 \
  main.c "$gui_settings_build_dir/settings.o" -o gui-controls.exe -lkernel32 -luser32 -ladvapi32 -lgdi32 -lcomctl32 -lcomdlg32 -lgcc
i686-w64-mingw32-strip --strip-all gui-controls.exe
python3 - <<'PY'
from pathlib import Path
path = Path('gui-controls.exe')
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
PY
