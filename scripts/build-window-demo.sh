#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$repo_dir/demos/breakout"
output_dir="$repo_dir/public/demos/breakout"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-breakout.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

CC=${CC:-i686-w64-mingw32-gcc}
STRIP=${STRIP:-i686-w64-mingw32-strip}
OBJDUMP=${OBJDUMP:-i686-w64-mingw32-objdump}

command -v "$CC" >/dev/null 2>&1 || { echo "missing compiler: $CC" >&2; exit 1; }
command -v "$STRIP" >/dev/null 2>&1 || { echo "missing strip tool: $STRIP" >&2; exit 1; }
command -v "$OBJDUMP" >/dev/null 2>&1 || { echo "missing objdump tool: $OBJDUMP" >&2; exit 1; }

cflags='-m32 -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident -Wall -Wextra -Werror'
ldflags='-nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase -Wl,--nxcompat -Wl,--image-base,0x400000 -Wl,--entry,_entry -Wl,--subsystem,windows'

cd "$source_dir"
SOURCE_DATE_EPOCH=0 "$CC" $cflags $ldflags -o "$tmp_dir/breakout.exe" main.c \
  -luser32 -lgdi32 -lkernel32
"$STRIP" --strip-all "$tmp_dir/breakout.exe"
"$OBJDUMP" -f "$tmp_dir/breakout.exe" | rg -q 'file format pei-i386' || {
  echo 'breakout.exe is not a 32-bit PE executable' >&2
  exit 1
}

node --input-type=module - "$tmp_dir/breakout.exe" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const bytes = new Uint8Array(readFileSync(path));
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const peOffset = view.getUint32(0x3c, true);
view.setUint32(peOffset + 8, 0, true); // Stable COFF timestamp.
view.setUint32(peOffset + 88, 0, true); // Recompute-independent checksum.
writeFileSync(path, bytes);
NODE

mkdir -p "$output_dir"
cp "$tmp_dir/breakout.exe" "$output_dir/breakout.exe"
cp "$source_dir/README.md" "$source_dir/LICENSE" "$output_dir/"

python3 - "$output_dir" <<'PY'
from pathlib import Path
import hashlib
import json
import sys
import zipfile

directory = Path(sys.argv[1])
archive = directory.parent / "breakout.zip"
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        name = path.relative_to(directory.parent).as_posix()
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (0o100644 & 0xFFFF) << 16
        info.flag_bits = 0
        package.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
manifest_path = directory.parent / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
item = {
    'name': 'breakout',
    'exe': 'breakout/breakout.exe',
    'exeSha256': hashlib.sha256((directory / 'breakout.exe').read_bytes()).hexdigest(),
    'zip': 'breakout.zip',
    'zipSha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
    'description': 'Native Win32 Breakout: arrows or mouse, Space pauses, R restarts. Close both windows to exit.',
    'provenance': 'Original MIT-licensed freestanding C demo; compiled to a Windows PE32 executable.',
}
manifest['interactive'] = [entry for entry in manifest.get('interactive', []) if entry['name'] != 'breakout'] + [item]
manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
PY

echo "Built deterministic Breakout demo in $output_dir and $output_dir/../breakout.zip"
