#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
fixture=tests/fixtures/vulkan-compute
headers=${VULKAN_HEADERS:-.cache/vulkan-headers/include}
mkdir -p .cache/vulkan-compute
glslangValidator -V "$fixture/increment.comp" -o "$fixture/increment.spv"
python3 - <<'PY'
from pathlib import Path
import struct
fixture = Path('tests/fixtures/vulkan-compute')
shader = (fixture / 'increment.spv').read_bytes()
words = struct.unpack('<' + 'I' * (len(shader) // 4), shader)
(fixture / 'shader.h').write_text('/* Generated from increment.spv. */\nstatic const unsigned int shader[] = {\n' + ''.join('  ' + ', '.join(hex(w) for w in words[i:i+8]) + ',\n' for i in range(0, len(words), 8)) + '};\n')
PY
node --input-type=module - <<'JS'
import { writeFile } from 'node:fs/promises';
import { VK_COMMANDS } from './src/vulkan-abi.js';
await writeFile('.cache/vulkan-compute/vulkan.def', 'LIBRARY vulkan-1.dll\nEXPORTS\n' + Object.entries(VK_COMMANDS).map(([name, widths]) => `${name}@${widths.reduce((a, b) => a + b, 0) * 4}`).join('\n') + '\n');
JS
i686-w64-mingw32-dlltool -k -d .cache/vulkan-compute/vulkan.def -l .cache/vulkan-compute/libvulkan-1.a
SOURCE_DATE_EPOCH=0 "${CC:-i686-w64-mingw32-gcc}" -Os -I "$headers" -nostartfiles \
    -Wl,--no-insert-timestamp -Wl,--entry,_mainCRTStartup -o "$fixture/compute.exe" \
    "$fixture/main.c" .cache/vulkan-compute/libvulkan-1.a -lkernel32
SOURCE_DATE_EPOCH=0 i686-w64-mingw32-strip --strip-all "$fixture/compute.exe"
python3 - <<'PY'
from pathlib import Path
path = Path('tests/fixtures/vulkan-compute/compute.exe')
image = bytearray(path.read_bytes())
pe = int.from_bytes(image[0x3c:0x40], 'little')
image[pe + 8:pe + 12] = bytes(4)
image[pe + 88:pe + 92] = bytes(4)
path.write_bytes(image)
PY
