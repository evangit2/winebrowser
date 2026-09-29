#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$repo_dir/demos/d3d12-terrain"
output_dir="$repo_dir/public/demos/d3d12-terrain"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-d3d12-terrain.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

OBJDUMP=${OBJDUMP:-i686-w64-mingw32-objdump}
for tool in "$OBJDUMP" python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing build tool: $tool" >&2; exit 1; }
done

"$source_dir/build.sh" "$tmp_dir/d3d12-terrain.exe"
"$OBJDUMP" -f "$tmp_dir/d3d12-terrain.exe" > "$tmp_dir/format.txt"
"$OBJDUMP" -p "$tmp_dir/d3d12-terrain.exe" > "$tmp_dir/headers.txt"
"$OBJDUMP" -d "$tmp_dir/d3d12-terrain.exe" > "$tmp_dir/disassembly.txt"

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
headers = (temporary / 'headers.txt').read_text()
imports = {name.lower() for name in re.findall(r'DLL Name: (\S+)', headers)}
expected = {'d3d12.dll', 'dxgi.dll', 'kernel32.dll', 'user32.dll'}
if imports != expected:
    raise SystemExit(f'unexpected imported DLLs: {sorted(imports)}')
main = (source / 'main.c').read_text()
# The mesh must be large and indexed through a constant buffer, which is what
# distinguishes this target from the cube samples.
for required in (
    'DXGI_FORMAT_R32_UINT',
    'CreateConstantBufferView',
    'D3D12_DESCRIPTOR_RANGE_TYPE_CBV',
    'SetDescriptorHeaps',
    'SetGraphicsRootDescriptorTable',
    'DrawIndexedInstanced',
):
    if required not in main:
        raise SystemExit(f'terrain demo is missing {required}')
# Tens of thousands of triangles, generated rather than hard-coded.
if '32768' not in main and 'INDEX_COUNT' not in main:
    raise SystemExit('terrain does not build a large indexed mesh')
if 'terrain_height' not in main or 'value_noise' not in main:
    raise SystemExit('terrain height field is not generated in guest code')
# The mesh is uploaded once; only the constant buffer is rewritten per frame.
loop = main.index('while (running)')
if 'ID3D12Resource_Map(vertices' in main[loop:]:
    raise SystemExit('vertex buffer is re-uploaded inside the frame loop')
if 'copy_bytes(mapped_constants' not in main[loop:]:
    raise SystemExit('the frame loop does not update the constant buffer')
# Three attributes are read, so the input layout must declare all three.
for semantic in ('"POSITION"', '"NORMAL"', '"COLOR"'):
    if semantic not in main:
        raise SystemExit(f'terrain input layout is missing {semantic}')

exe = temporary / 'd3d12-terrain.exe'
data = exe.read_bytes()
destination.mkdir(parents=True, exist_ok=True)
for old in destination.rglob('*'):
    if old.is_file(): old.unlink()
shutil.copyfile(exe, destination / exe.name)
for name in ('README.md', 'LICENSE', 'main.c', 'build.sh'):
    shutil.copyfile(source / name, destination / name)
(destination / 'build.sh').chmod(0o755)
shader_destination = destination / 'shaders'
shader_destination.mkdir(parents=True, exist_ok=True)
for path in sorted((source / 'shaders').iterdir()):
    if path.is_file():
        shutil.copyfile(path, shader_destination / path.name)
        if path.name == 'build.sh':
            (shader_destination / path.name).chmod(0o755)
digest = hashlib.sha256(data).hexdigest()
(destination / 'SHA256SUMS').write_text(f'{digest}  {exe.name}\n')

archive = destination.parent / 'd3d12-terrain.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
    for path in sorted(p for p in destination.rglob('*') if p.is_file()):
        relative = path.relative_to(destination)
        info = zipfile.ZipInfo(f'd3d12-terrain/{relative.as_posix()}', (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        executable = relative.as_posix() in ('build.sh', 'shaders/build.sh')
        info.external_attr = ((0o100755 if executable else 0o100644) & 0xffff) << 16
        package.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
print(f'PE32: {digest}  {exe.name}')
print(f'ZIP:  {hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}')
PY

python3 "$repo_dir/scripts/update-demo-hashes.py" d3d12-terrain
