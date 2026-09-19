#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:-"$source_dir/d3d12-cube.exe"}
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/d3d12-cube-build.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

CC=${CC:-i686-w64-mingw32-gcc}
STRIP=${STRIP:-i686-w64-mingw32-strip}
for tool in "$CC" "$STRIP" python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing build tool: $tool" >&2; exit 1; }
done

python3 "$source_dir/generate_vertices.py" "$tmp_dir/vertices.h"
python3 - "$source_dir/shaders" "$tmp_dir/shaders.h" <<'PY'
from pathlib import Path
import sys

source, target = Path(sys.argv[1]), Path(sys.argv[2])
with target.open('w') as out:
    out.write('/* Generated from the cube DXBC files. */\n')
    for name, filename in [('cube_vs', 'cube.vs.dxbc'), ('cube_ps', 'cube.ps.dxbc')]:
        data = (source / filename).read_bytes()
        out.write(f'static const unsigned char {name}[] = {{\n')
        for start in range(0, len(data), 12):
            values = ', '.join(f'0x{byte:02x}' for byte in data[start:start + 12])
            out.write(f'    {values},\n')
        out.write('};\n')
PY

SOURCE_DATE_EPOCH=0 "$CC" -m32 -O1 -ffreestanding -fno-builtin \
    -fno-tree-loop-distribute-patterns -fno-stack-protector \
    -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
    -Wall -Wextra -Werror -nostdlib -I "$tmp_dir" \
    -Wl,--no-insert-timestamp -Wl,--enable-reloc-section \
    -Wl,--dynamicbase -Wl,--nxcompat -Wl,--image-base,0x400000 \
    -Wl,--entry,_mainCRTStartup -Wl,--subsystem,windows \
    -o "$tmp_dir/d3d12-cube.exe" "$source_dir/main.c" \
    -ld3d12 -ldxgi -luser32 -lkernel32 -luuid
"$STRIP" --strip-all "$tmp_dir/d3d12-cube.exe"

python3 - "$tmp_dir/d3d12-cube.exe" "$output" <<'PY'
from pathlib import Path
import sys

source, output = map(Path, sys.argv[1:])
data = bytearray(source.read_bytes())
pe_offset = int.from_bytes(data[0x3c:0x40], 'little')
data[pe_offset + 8:pe_offset + 12] = bytes(4)
data[pe_offset + 88:pe_offset + 92] = bytes(4)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_bytes(data)
PY
echo "built $output"
