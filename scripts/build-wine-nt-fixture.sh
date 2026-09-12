#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture_dir="$repo_dir/tests/fixtures/wine-nt"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-wine-nt.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

CC=${CC:-i686-w64-mingw32-gcc}
STRIP=${STRIP:-i686-w64-mingw32-strip}

SOURCE_DATE_EPOCH=0 "$CC" -m32 -c -x assembler-with-cpp \
  -o "$tmp_dir/wine-nt.o" "$fixture_dir/wine-nt.S"
SOURCE_DATE_EPOCH=0 "$CC" -m32 -nostdlib -shared \
  -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase \
  -Wl,--image-base,0x10000000 -Wl,--entry,_DllMain@12 \
  -o "$tmp_dir/ntdll.dll" "$tmp_dir/wine-nt.o" "$fixture_dir/wine-nt.def"
"$STRIP" --strip-all "$tmp_dir/ntdll.dll"

# Normalize linker metadata to keep the checked-in binary reproducible.
node --input-type=module - "$tmp_dir/ntdll.dll" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2];
const bytes = new Uint8Array(readFileSync(path));
const view = new DataView(bytes.buffer);
const peOffset = view.getUint32(0x3c, true);
view.setUint32(peOffset + 8, 0, true); // COFF TimeDateStamp.
view.setUint32(peOffset + 88, 0, true); // Optional-header CheckSum.
writeFileSync(path, bytes);
NODE

cp "$tmp_dir/ntdll.dll" "$fixture_dir/ntdll.dll"
echo "Built $fixture_dir/ntdll.dll"
