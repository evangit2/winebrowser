#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$repo_dir/demos/d3d9-shader-cube"
output_dir="$repo_dir/public/demos/d3d9-shader-cube"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-d3d9-shader-cube.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

OBJDUMP=${OBJDUMP:-i686-w64-mingw32-objdump}
for tool in "$OBJDUMP" python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing build tool: $tool" >&2; exit 1; }
done

"$source_dir/build.sh" "$tmp_dir/d3d9-shader-cube.exe"
"$OBJDUMP" -f "$tmp_dir/d3d9-shader-cube.exe" > "$tmp_dir/format.txt"
"$OBJDUMP" -p "$tmp_dir/d3d9-shader-cube.exe" > "$tmp_dir/headers.txt"
"$OBJDUMP" -d "$tmp_dir/d3d9-shader-cube.exe" > "$tmp_dir/code.txt"

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
imports = {name.lower() for name in re.findall(
    r'DLL Name: (\S+)', (temporary / 'headers.txt').read_text())}
if imports != {'d3d9.dll', 'kernel32.dll', 'user32.dll'}:
    raise SystemExit(f'unexpected imported DLLs: {sorted(imports)}')
code = (temporary / 'code.txt').read_text()
if not re.search(r'\bf(?:ld|st|add|sub|mul|div)', code):
    raise SystemExit('demo contains no x87 arithmetic')
if re.search(r'\b(?:add|sub|mul|div)ss\b', code):
    raise SystemExit('demo unexpectedly contains scalar SSE arithmetic')

exe = temporary / 'd3d9-shader-cube.exe'
if destination.exists():
    shutil.rmtree(destination)
destination.mkdir(parents=True)
shutil.copyfile(exe, destination / exe.name)
for path in sorted(source.rglob('*')):
    if path.is_file() and path.name != 'd3d9-shader-cube.exe' and '__pycache__' not in path.parts:
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
digest = hashlib.sha256(exe.read_bytes()).hexdigest()
(destination / 'SHA256SUMS').write_text(f'{digest}  d3d9-shader-cube.exe\n')

archive = destination.parent / 'd3d9-shader-cube.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
    for path in sorted(destination.rglob('*')):
        if not path.is_file():
            continue
        relative = path.relative_to(destination)
        info = zipfile.ZipInfo(f'd3d9-shader-cube/{relative.as_posix()}', (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        mode = 0o100755 if relative.as_posix() in ('build.sh', 'assemble_shaders.py') else 0o100644
        info.external_attr = (mode & 0xffff) << 16
        package.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED,
                         compresslevel=9)
print(f'PE32: {digest}  {exe.name}')
print(f'ZIP:  {hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}')
PY

python3 "$repo_dir/scripts/update-demo-hashes.py" d3d9-shader-cube
