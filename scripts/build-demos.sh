#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CC="${MINGW32_CC:-i686-w64-mingw32-gcc}"
OBJDUMP="${MINGW32_OBJDUMP:-i686-w64-mingw32-objdump}"
PYTHON="${PYTHON:-python3}"
OUT="$ROOT/public/demos"

command -v "$CC" >/dev/null || { echo "missing compiler: $CC" >&2; exit 1; }
command -v "$OBJDUMP" >/dev/null || { echo "missing objdump: $OBJDUMP" >&2; exit 1; }
command -v "$PYTHON" >/dev/null || { echo "missing Python: $PYTHON" >&2; exit 1; }

mkdir -p "$OUT"

build_one() {
    local name="$1" subsystem="$2"
    local dest="$OUT/$name"
    rm -rf "$dest"
    mkdir -p "$dest"
    local -a link_args=("-Wl,--no-insert-timestamp" "-Wl,--entry,_start" "-Wl,--subsystem,$subsystem")
    local -a libraries=("${@:3}")
    "$CC" -nostdlib -fno-ident "${link_args[@]}" -o "$dest/$name.exe" "$ROOT/demos/$name/main.S" "${libraries[@]}"
    "$OBJDUMP" -f "$dest/$name.exe" | rg -q 'file format pei-i386' || { echo "$name is not a 32-bit PE executable" >&2; exit 1; }
    if [[ "$name" == files ]]; then
        mkdir -p "$dest/assets"
        cp "$ROOT/demos/files/assets/message.txt" "$dest/assets/message.txt"
    fi
    }

build_one console console -lkernel32
build_one files console -lkernel32
build_one messagebox windows -luser32 -lkernel32
build_one beep console -lkernel32
bash "$ROOT/scripts/build-tls-fixtures.sh"
mkdir -p "$OUT/tls"
cp "$ROOT/tests/fixtures/tls/app.exe" "$OUT/tls/tls.exe"
cp "$ROOT/tests/fixtures/tls/tls.dll" "$OUT/tls/tls.dll"
cp "$ROOT/tests/fixtures/tls/LICENSE" "$OUT/tls/LICENSE"

"$PYTHON" - "$OUT" <<'PY'
import hashlib
import json
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1])
descriptions = {
    "console": {"stdout": "console demo: hello from WriteFile\r\n", "exitCode": 0, "apiErrorExitCode": 1},
    "files": {"stdoutFrom": "assets/message.txt byte-for-byte", "createdFiles": {"output.txt": "files demo: generated output file.\r\n"}, "exitCode": 0, "apiErrorExitCode": 1},
    "messagebox": {"messageBoxA": {"title": "WineBrowser demo", "text": "MessageBoxA ran successfully."}, "exitCode": 0, "apiErrorExitCode": 1},
    "beep": {"beepHz": 440, "beepMilliseconds": 180, "exitCode": 0, "apiErrorExitCode": 1},
    "tls": {"exitCode": 0, "stdout": "TLS events:12349678\r\n"},
}
items = []
for name in sorted(descriptions):
    folder = root / name
    archive = root / f"{name}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(p for p in folder.rglob("*") if p.is_file()):
            rel = path.relative_to(root).as_posix()
            info = zipfile.ZipInfo(rel, (1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (0o100644 & 0xFFFF) << 16
            info.flag_bits = 0
            zf.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    exe = folder / f"{name}.exe"
    items.append({
        "name": name,
        "exe": exe.relative_to(root).as_posix(),
        "exeSha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
        "zip": archive.relative_to(root).as_posix(),
        "zipSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "expected": descriptions[name],
    })
manifest_path = root / "manifest.json"
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
manifest.update({"format": 1, "architecture": "x86 (PE32)", "fixtures": items})
(root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

bash "$ROOT/scripts/build-window-demo.sh"
echo "Built deterministic demo fixtures in $OUT"
