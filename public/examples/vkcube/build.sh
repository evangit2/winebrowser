#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:-"$source_dir/vkcube.exe"}
headers=${VULKAN_HEADERS:-"$source_dir/../../.cache/vulkan-headers/include"}
CC=${CC:-i686-w64-mingw32-gcc}
mkdir -p "$(dirname -- "$output")"
SOURCE_DATE_EPOCH=0 "$CC" -O1 -mfpmath=387 -mno-sse -mno-sse2 \
    -ffreestanding -fno-builtin -fno-tree-loop-distribute-patterns \
    -fno-stack-protector -fno-asynchronous-unwind-tables -fno-ident \
    -DWIN32 -DNDEBUG -D__USE_MINGW_ANSI_STDIO=0 -DVK_USE_PLATFORM_WIN32_KHR -I "$headers" -nostartfiles \
    -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
    -Wl,--nxcompat -Wl,--image-base,0x400000 -Wl,--entry,_mainCRTStartup \
    -Wl,--subsystem,windows -o "$output" \
    "$source_dir/upstream/cube.c" "$source_dir/startup.c" \
    -lshell32 -luser32 -lgdi32 -lkernel32 
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-strip --strip-all "$output"
python3 - "$output" <<'PYCODE'
from pathlib import Path
import sys
path = Path(sys.argv[1])
data = bytearray(path.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
path.write_bytes(data)
PYCODE
