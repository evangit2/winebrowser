#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture_dir="$repo_dir/tests/fixtures/tls"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/winebrowser-tls.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

CC=${CC:-i686-w64-mingw32-gcc}
DLLTOOL=${DLLTOOL:-i686-w64-mingw32-dlltool}
STRIP=${STRIP:-i686-w64-mingw32-strip}

common_cflags='-m32 -O1 -ffreestanding -fno-builtin -fno-stack-protector -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident -Wall -Wextra'
common_ldflags='-nostdlib -Wl,--no-insert-timestamp -Wl,--enable-reloc-section -Wl,--dynamicbase'

cd "$fixture_dir"
SOURCE_DATE_EPOCH=0 "$CC" $common_cflags -c dll.c -o "$tmp_dir/dll.o"
SOURCE_DATE_EPOCH=0 "$CC" $common_cflags -c app.c -o "$tmp_dir/app.o"
"$DLLTOOL" --input-def dll.def --output-lib "$tmp_dir/libtls.a" --dllname tls.dll

SOURCE_DATE_EPOCH=0 "$CC" -m32 $common_ldflags -shared -Wl,--image-base,0x10000000 \
  -Wl,--entry,_DllMain@12 -o "$tmp_dir/tls.dll" "$tmp_dir/dll.o" dll.def -lkernel32
SOURCE_DATE_EPOCH=0 "$CC" -m32 $common_ldflags -Wl,--image-base,0x400000 \
  -Wl,--entry,_start -Wl,--subsystem,console -o "$tmp_dir/app.exe" "$tmp_dir/app.o" \
  "$tmp_dir/libtls.a" -lkernel32

"$STRIP" --strip-all "$tmp_dir/app.exe" "$tmp_dir/tls.dll"

# Normalize PE timestamps and checksums so checked-in fixtures rebuild exactly.
node --input-type=module - "$tmp_dir" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const [directory] = process.argv.slice(2);
for (const name of ['app.exe', 'tls.dll']) {
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
cp "$tmp_dir/tls.dll" "$fixture_dir/tls.dll"
echo "Built TLS fixtures in $fixture_dir"
