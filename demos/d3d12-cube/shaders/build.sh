#!/bin/sh
set -eu

shader_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$shader_dir/../../.." && pwd)
cache_dir="$repo_dir/.cache/d3d12-cube-shaders"
cc=${MINGW_CC:-x86_64-w64-mingw32-gcc}
wine=${WINE:-/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine}
compiler_dll=${WINE_D3DCOMPILER:-$(dirname "$wine")/../lib/wine/x86_64-windows/d3dcompiler_47.dll}

command -v "$cc" >/dev/null 2>&1 || { echo "missing MinGW compiler: $cc" >&2; exit 1; }
test -x "$wine" || { echo "missing Wine executable: $wine" >&2; exit 1; }
test -f "$compiler_dll" || { echo "missing Wine d3dcompiler: $compiler_dll" >&2; exit 1; }
python3 - "$compiler_dll" <<'PY'
from pathlib import Path
import hashlib
import sys
expected = '954fbced88b9dd526be604bcd73d7985b854bc327e8727e01c698d4d463289ff'
actual = hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit(f'Wine d3dcompiler_47.dll is not the pinned build: {actual}')
PY
mkdir -p "$cache_dir"
"$cc" -O2 -Wall -Wextra -Werror "$shader_dir/compile-dxbc.c" \
    -o "$cache_dir/compile-dxbc.exe" -ld3dcompiler

MVK_CONFIG_LOG_LEVEL=0 WINEDEBUG=-all "$wine" "$cache_dir/compile-dxbc.exe" \
    "Z:$shader_dir/cube.vs.hlsl" main vs_5_0 "Z:$shader_dir/cube.vs.dxbc"
MVK_CONFIG_LOG_LEVEL=0 WINEDEBUG=-all "$wine" "$cache_dir/compile-dxbc.exe" \
    "Z:$shader_dir/cube.ps.hlsl" main ps_5_0 "Z:$shader_dir/cube.ps.dxbc"

python3 - "$shader_dir" <<'PY'
from pathlib import Path
import hashlib
import json
import sys

root = Path(sys.argv[1])
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
