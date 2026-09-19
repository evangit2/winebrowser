#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:-"$source_dir/d3d9-shader-cube.exe"}
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/d3d9-shader-cube-build.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

CC=${CC:-i686-w64-mingw32-gcc}
STRIP=${STRIP:-i686-w64-mingw32-strip}
for tool in "$CC" "$STRIP" python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing build tool: $tool" >&2; exit 1; }
done

python3 "$source_dir/assemble_shaders.py" "$tmp_dir/shaders.h" \
    "$source_dir/shaders/cube.vs.asm" "$source_dir/shaders/cube.ps.asm"
SOURCE_DATE_EPOCH=0 "$CC" -m32 -O1 -mfpmath=387 -mno-sse -mno-sse2 \
    -ffreestanding -fno-builtin -fno-tree-loop-distribute-patterns \
    -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables \
    -fno-ident -Wall -Wextra -Werror -nostdlib -I "$tmp_dir" \
    -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
    -Wl,--nxcompat -Wl,--image-base,0x400000 -Wl,--entry,_mainCRTStartup \
    -Wl,--subsystem,windows -o "$tmp_dir/d3d9-shader-cube.exe" \
    "$source_dir/main.c" -ld3d9 -luser32 -lkernel32
"$STRIP" --strip-all "$tmp_dir/d3d9-shader-cube.exe"

python3 - "$tmp_dir/d3d9-shader-cube.exe" "$output" <<'PY'
from pathlib import Path
import sys
source, output = map(Path, sys.argv[1:])
data = bytearray(source.read_bytes())
pe = int.from_bytes(data[0x3c:0x40], 'little')
data[pe + 8:pe + 12] = bytes(4)
data[pe + 88:pe + 92] = bytes(4)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_bytes(data)
PY
echo "built $output"
