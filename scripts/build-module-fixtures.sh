#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture_dir="$repo_dir/tests/fixtures/modules"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-modules.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

CC=${CC:-i686-w64-mingw32-gcc}
DLLTOOL=${DLLTOOL:-i686-w64-mingw32-dlltool}
OBJDUMP=${OBJDUMP:-i686-w64-mingw32-objdump}
STRIP=${STRIP:-i686-w64-mingw32-strip}

common_cflags='-m32 -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident -Wall -Wextra'
common_ldflags='-nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase'

cd "$fixture_dir"
SOURCE_DATE_EPOCH=0 "$CC" $common_cflags -c math.c -o "$tmp_dir/math.o"
SOURCE_DATE_EPOCH=0 "$CC" $common_cflags -c forward.c -o "$tmp_dir/forward.o"
SOURCE_DATE_EPOCH=0 "$CC" $common_cflags -c app.c -o "$tmp_dir/app.o"

"$DLLTOOL" --input-def math.def --output-lib "$tmp_dir/libmath.a" --dllname math.dll
"$DLLTOOL" --input-def forward.def --output-lib "$tmp_dir/libforward.a" --dllname forward.dll

SOURCE_DATE_EPOCH=0 "$CC" -m32 $common_ldflags -shared -Wl,--image-base,0x10000000 \
  -Wl,--entry,_DllMain@12 \
  -o "$tmp_dir/math.dll" "$tmp_dir/math.o" math.def
SOURCE_DATE_EPOCH=0 "$CC" -m32 $common_ldflags -shared -Wl,--image-base,0x10000000 \
  -Wl,--entry,_DllMain@12 -o "$tmp_dir/forward.dll" "$tmp_dir/forward.o" forward.def
SOURCE_DATE_EPOCH=0 "$CC" -m32 $common_ldflags -Wl,--image-base,0x400000 \
  -Wl,--entry,_start -Wl,--subsystem,console -o "$tmp_dir/app.exe" "$tmp_dir/app.o" \
  "$tmp_dir/libmath.a" "$tmp_dir/libforward.a" -lkernel32

# MinGW keeps a COFF symbol table after the PE image by default. Those symbol
# records include temporary import-library identifiers, so strip them to keep
# generated evidence reproducible without touching the PE relocation section.
"$STRIP" --strip-all "$tmp_dir/app.exe" "$tmp_dir/math.dll" "$tmp_dir/forward.dll"

# Some toolchain builds still stamp PE headers despite --no-insert-timestamp;
# normalize the COFF timestamp and optional-header checksum explicitly.
node --input-type=module - "$tmp_dir" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [directory] = process.argv.slice(2);
for (const name of ['app.exe', 'math.dll', 'forward.dll']) {
  const path = `${directory}/${name}`;
  const bytes = new Uint8Array(readFileSync(path));
  const view = new DataView(bytes.buffer);
  const peOffset = view.getUint32(0x3c, true);
  view.setUint32(peOffset + 8, 0, true); // COFF TimeDateStamp.
  view.setUint32(peOffset + 88, 0, true); // Optional-header CheckSum.
  writeFileSync(path, bytes);
}
NODE

cp "$tmp_dir/app.exe" "$fixture_dir/app.exe"
cp "$tmp_dir/math.dll" "$fixture_dir/math.dll"
cp "$tmp_dir/forward.dll" "$fixture_dir/forward.dll"

# Package the three files in a stable order with fixed DOS-compatible times.
TZ=UTC node --input-type=module - "$tmp_dir" "$fixture_dir" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { zipSync } from 'fflate';

const [tmp, output] = process.argv.slice(2);
const fixed = new Date(1980, 0, 1, 0, 0, 0);
const files = Object.fromEntries(
  ['app.exe', 'math.dll', 'forward.dll'].map((name) => [
    name,
    [new Uint8Array(readFileSync(`${tmp}/${name}`)), { level: 0, mtime: fixed }],
  ]),
);
writeFileSync(`${output}/modules.zip`, zipSync(files, { level: 0 }));
NODE

echo 'Built PE fixtures:'
"$OBJDUMP" -p "$fixture_dir/app.exe" | sed -n '/The Import Tables/,$p' | head -80
"$OBJDUMP" -p "$fixture_dir/math.dll" | sed -n '/The Export Tables/,$p' | head -90
"$OBJDUMP" -p "$fixture_dir/forward.dll" | sed -n '/The Export Tables/,$p' | head -60
