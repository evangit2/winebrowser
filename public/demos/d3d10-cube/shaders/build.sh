#!/bin/sh
set -eu

shader_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$shader_dir/../../.." && pwd)
cache_dir="$repo_dir/.cache/d3d10-cube-shaders"
cc=${MINGW_CC:-i686-w64-mingw32-gcc}
wine=${WINE:-/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine}
compiler_dll=${WINE_D3DCOMPILER:-$(dirname "$wine")/../lib/wine/i386-windows/d3dcompiler_47.dll}

command -v "$cc" >/dev/null 2>&1 || { echo "missing MinGW compiler: $cc" >&2; exit 1; }
test -x "$wine" || { echo "missing Wine executable: $wine" >&2; exit 1; }
test -f "$compiler_dll" || { echo "missing Wine d3dcompiler: $compiler_dll" >&2; exit 1; }
mkdir -p "$cache_dir"
"$cc" -O2 -Wall -Wextra -Werror "$shader_dir/compile-dxbc.c" \
    -o "$cache_dir/compile-dxbc.exe" -ld3dcompiler

# Direct3D 10 compiles against the SM4 profiles, which is what the frontend
# accepts; the container and instruction set match the SM5 the D3D12 fixture
# uses, only the target model differs.
MVK_CONFIG_LOG_LEVEL=0 WINEDEBUG=-all "$wine" "$cache_dir/compile-dxbc.exe" \
    "Z:$shader_dir/cube.vs.hlsl" main vs_4_0 "Z:$shader_dir/cube.vs.dxbc"
MVK_CONFIG_LOG_LEVEL=0 WINEDEBUG=-all "$wine" "$cache_dir/compile-dxbc.exe" \
    "Z:$shader_dir/cube.ps.hlsl" main ps_4_0 "Z:$shader_dir/cube.ps.dxbc"

python3 - "$shader_dir" <<'PY'
from pathlib import Path
import hashlib
import json
import struct
import sys

root = Path(sys.argv[1])
for name in ('cube.vs.dxbc', 'cube.ps.dxbc'):
    data = (root / name).read_bytes()
    count = struct.unpack_from('<I', data, 28)[0]
    for i in range(count):
        offset = struct.unpack_from('<I', data, 32 + i * 4)[0]
        if data[offset:offset + 4] in (b'SHDR', b'SHEX'):
            version = struct.unpack_from('<I', data, offset + 8)[0]
            major, minor = (version >> 4) & 0xf, version & 0xf
            if (major, minor) != (4, 0):
                raise SystemExit(f'{name} is SM{major}.{minor}, not SM4.0')
            break
    else:
        raise SystemExit(f'{name} has no program chunk')

files = ['cube.vs.hlsl', 'cube.ps.hlsl', 'cube.vs.dxbc', 'cube.ps.dxbc',
         'compile-dxbc.c', 'build.sh', 'LICENSE', 'README.md']
manifest = {name: {'bytes': (root / name).stat().st_size,
                   'sha256': hashlib.sha256((root / name).read_bytes()).hexdigest()}
            for name in files}
(root / 'manifest.json').write_text(json.dumps({'format': 1, 'files': manifest},
                                               indent=2, sort_keys=True) + '\n')
print(json.dumps({name: manifest[name] for name in ('cube.vs.dxbc', 'cube.ps.dxbc')},
                 sort_keys=True))
PY
