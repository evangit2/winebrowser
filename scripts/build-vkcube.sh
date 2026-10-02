#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
if [ ! -f .cache/vulkan-headers/include/vulkan/vulkan.h ]; then
    mkdir -p .cache/vulkan-headers
    curl -fL --max-time 120 https://codeload.github.com/KhronosGroup/Vulkan-Headers/tar.gz/c46850864f4661461b0f6cb9922c058ffea4915e -o .cache/vulkan-headers.tar.gz
    python3 - <<'PY'
from pathlib import Path
import hashlib, json
expected = json.loads(Path('demos/vkcube/manifest.json').read_text())['headersArchiveSha256']
if hashlib.sha256(Path('.cache/vulkan-headers.tar.gz').read_bytes()).hexdigest() != expected:
    raise SystemExit('Vulkan-Headers archive hash mismatch')
PY
    tar -xzf .cache/vulkan-headers.tar.gz --strip-components=1 -C .cache/vulkan-headers
fi
python3 - <<'PY'
from pathlib import Path
import hashlib, json
root = Path('demos/vkcube')
for name, expected in json.loads((root / 'manifest.json').read_text())['files'].items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
        raise SystemExit('Upstream demo source changed: ' + name)
PY
sh demos/vkcube/build.sh public/examples/vkcube/vkcube.exe
