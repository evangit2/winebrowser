#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$repo_dir/demos/d3d9-cube"
output_dir="$repo_dir/public/demos/d3d9-cube"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-d3d9-cube.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

CC=${CC:-i686-w64-mingw32-gcc}
STRIP=${STRIP:-i686-w64-mingw32-strip}
OBJDUMP=${OBJDUMP:-i686-w64-mingw32-objdump}

for tool in "$CC" "$STRIP" "$OBJDUMP" python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing build tool: $tool" >&2; exit 1; }
done

SOURCE_DATE_EPOCH=0 "$CC" -m32 -O1 -ffreestanding -fno-builtin \
    -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables \
    -fno-ident -Wall -Wextra -Werror -nostdlib -Wl,--no-insert-timestamp \
    -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat \
    -Wl,--image-base,0x400000 -Wl,--entry,_mainCRTStartup \
    -Wl,--subsystem,windows -o "$tmp_dir/d3d9-cube.exe" \
    "$source_dir/main.c" -ld3d9 -luser32 -lkernel32
"$STRIP" --strip-all "$tmp_dir/d3d9-cube.exe"
"$OBJDUMP" -f "$tmp_dir/d3d9-cube.exe" > "$tmp_dir/format.txt"
"$OBJDUMP" -p "$tmp_dir/d3d9-cube.exe" > "$tmp_dir/headers.txt"

python3 - "$tmp_dir" "$output_dir" "$source_dir" <<'PY'
from pathlib import Path
import hashlib
import re
import shutil
import sys
import zipfile

temporary, destination, source = map(Path, sys.argv[1:])
if 'file format pei-i386' not in (temporary / 'format.txt').read_text():
    raise SystemExit('demo is not a 32-bit PE executable')
imports = set(re.findall(r'DLL Name: (\S+)', (temporary / 'headers.txt').read_text()))
if {name.lower() for name in imports} != {'d3d9.dll', 'kernel32.dll', 'user32.dll'}:
    raise SystemExit(f'unexpected imported DLLs: {sorted(imports)}')

exe = temporary / 'd3d9-cube.exe'
data = bytearray(exe.read_bytes())
pe_offset = int.from_bytes(data[0x3c:0x40], 'little')
data[pe_offset + 8:pe_offset + 12] = bytes(4)  # COFF timestamp
data[pe_offset + 88:pe_offset + 92] = bytes(4)  # optional-header checksum
exe.write_bytes(data)

destination.mkdir(parents=True, exist_ok=True)
shutil.copyfile(exe, destination / exe.name)
for name in ('README.md', 'LICENSE'):
    shutil.copyfile(source / name, destination / name)
digest = hashlib.sha256(data).hexdigest()
(destination / 'SHA256SUMS').write_text(f'{digest}  d3d9-cube.exe\n')

archive = destination.parent / 'd3d9-cube.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
    for path in sorted(destination.iterdir()):
        info = zipfile.ZipInfo(f'd3d9-cube/{path.name}', (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (0o100644 & 0xffff) << 16
        package.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
print(f'PE32: {digest}  {exe.name}')
print(f'ZIP:  {hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}')
PY

python3 "$repo_dir/scripts/update-demo-hashes.py" d3d9-cube
