#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
crate_dir="$repo_dir/runtime/shaders/naga"
target_dir="$repo_dir/.cache/shader-wgsl-target"
output_dir="$repo_dir/public/shaders/naga"
stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-shader-wgsl.XXXXXX")
trap 'rm -rf "$stage_dir"' EXIT HUP INT TERM

CARGO=${CARGO:-cargo}
WASM_BINDGEN=${WASM_BINDGEN:-wasm-bindgen}
if ! command -v "$CARGO" >/dev/null 2>&1; then
    CARGO="${CARGO_HOME:-$HOME/.cargo}/bin/cargo"
fi
if ! command -v "$WASM_BINDGEN" >/dev/null 2>&1; then
    WASM_BINDGEN="${CARGO_HOME:-$HOME/.cargo}/bin/wasm-bindgen"
fi
for tool in "$CARGO" "$WASM_BINDGEN" python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing build tool: $tool" >&2; exit 1; }
done

RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C link-arg=--max-memory=134217728" \
    CARGO_TARGET_DIR="$target_dir" "$CARGO" build --locked --release \
    --target wasm32-unknown-unknown --manifest-path "$crate_dir/Cargo.toml"
"$WASM_BINDGEN" --target web --out-name winebrowser_shader_wgsl \
    --out-dir "$stage_dir" \
    "$target_dir/wasm32-unknown-unknown/release/winebrowser_shader_wgsl.wasm"

python3 - "$CARGO" "$crate_dir" "$stage_dir" <<'PY'
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys

cargo, crate, stage = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
metadata = json.loads(subprocess.check_output([
    cargo, 'metadata', '--locked', '--format-version', '1', '--manifest-path', str(crate / 'Cargo.toml'),
]))
packages = sorted((p for p in metadata['packages'] if p['name'] != 'winebrowser-shader-wgsl'),
                  key=lambda p: (p['name'], p['version']))
upstream_naga = next(p for p in packages if p['name'] == 'naga' and p['version'] == '30.0.1')
apache_text = Path(upstream_naga['manifest_path']).parent / 'LICENSE.APACHE'
licenses = stage / 'licenses'
licenses.mkdir()
notices = ['# Third-party notices', '',
           'This directory retains the license files distributed with every resolved',
           'Rust dependency in `source/Cargo.lock`. The library wrapper itself uses',
           'the MIT license in `source/LICENSE`.', '']
for package in packages:
    source = Path(package['manifest_path']).parent
    names = []
    for path in sorted(source.iterdir()):
        if path.is_file() and (path.name.upper().startswith('LICENSE') or path.name.upper().startswith('COPYING')):
            name = f"{package['name']}-{package['version']}-{path.name}"
            shutil.copyfile(path, licenses / name)
            names.append(f'[text](licenses/{name})')
    # The spirv crate declares Apache-2.0 but omits a license file from its
    # crates.io package. Retain the same canonical Apache text from Naga.
    if not names and package['license'] == 'Apache-2.0':
        name = f"{package['name']}-{package['version']}-LICENSE.APACHE"
        shutil.copyfile(apache_text, licenses / name)
        names.append(f'[Apache-2.0 text](licenses/{name})')
    if not names:
        raise SystemExit(f"No retained license text for {package['name']} {package['version']}")
    notices.append(f"- {package['name']} {package['version']} — {package['license'] or 'see text'}; "
                   + ', '.join(names))
(stage / 'THIRD_PARTY_NOTICES.md').write_text('\n'.join(notices) + '\n')

source_out = stage / 'source'
(source_out / 'src').mkdir(parents=True)
for name in ('Cargo.toml', 'Cargo.lock', 'LICENSE', 'README.md'):
    shutil.copyfile(crate / name, source_out / name)
shutil.copyfile(crate / 'src/lib.rs', source_out / 'src/lib.rs')
shutil.copyfile(crate / 'src/draw_parameters.rs', source_out / 'src/draw_parameters.rs')
shutil.copyfile(crate.parents[2] / 'scripts/build-shader-wgsl.sh', source_out / 'build-shader-wgsl.sh')
(stage / 'README.md').write_text(
    '# WineBrowser SPIR-V to WGSL Wasm\n\n'
    'Import `winebrowser_shader_wgsl.js`, await its default initializer, then call '
    '`spirv_to_wgsl(Uint8Array)` for a validated WGSL string. Invalid input throws. '
    'The original wrapper source, lockfile, build instructions and dependency '
    'licenses are retained in this directory.\n\n'
    'Draw-parameter builtins use a 16-byte signed integer uniform at group 3, '
    'binding 0: `[baseVertex, baseInstance, 0, 0]`. The caller must bind the '
    'actual offsets for each draw. The Wasm memory is capped at 128 MiB.\n')

artifacts = {}
for name in ('winebrowser_shader_wgsl.js', 'winebrowser_shader_wgsl_bg.wasm'):
    data = (stage / name).read_bytes()
    artifacts[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
(stage / 'manifest.json').write_text(json.dumps({
    'format': 1,
    'package': 'winebrowser-shader-wgsl',
    'nagaVersion': '30.0.1',
    'wasmBindgenVersion': '0.2.121',
    'api': 'default init(); spirv_to_wgsl(Uint8Array): string',
    'drawParameters': {'group': 3, 'binding': 0, 'layout': 'i32[4]: baseVertex, baseInstance, reserved, reserved'},
    'maximumWasmMemoryBytes': 134217728,
    'artifacts': artifacts,
}, indent=2, sort_keys=True) + '\n')
print(json.dumps(artifacts, sort_keys=True))
PY

rm -rf "$output_dir"
mkdir -p "$(dirname "$output_dir")"
mv "$stage_dir" "$output_dir"
# The exit trap may safely run after stage_dir was moved.
