"""Publish the authored native polygon and line GUI and its complete source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/gdi-paths'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'gdi-paths'
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def archive(path, entries):
    with zipfile.ZipFile(path, 'w') as output:
        for name, content in sorted(entries):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
DEST.mkdir(parents=True, exist_ok=True)
for name in ['gdi-paths.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native polygon and line GUI\n\nOriginal WineBrowser contributors, MIT.\n\n'
    'Unchanged native Windows SDK PE32 executable built with MinGW. Browser-local\n'
    'x86-to-Wasm translation happens during execution. No third-party game assets.\n\n'
    f'Executable SHA-256: `{digest(DEST / "gdi-paths.exe")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'The source archive includes the client, license, documentation and deterministic\n'
    'build script for the native GUI.\n'
)
archive(DEST / 'gdi-paths.zip', [('gdi-paths/' + name, (DEST / name).read_bytes()) for name in ['gdi-paths.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']])
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in ['LICENSE', 'scripts/build-gdi-paths-fixture.sh', 'tests/fixtures/gdi-paths/client.c', 'tests/fixtures/gdi-paths/README.md', 'tests/fixtures/gdi-paths/oracle.c', 'tests/fixtures/gdi-paths/wine-oracle.json', 'tests/fixtures/gdi-paths/metadata-oracle.c', 'tests/fixtures/gdi-paths/pen-color-oracle.c', 'tests/fixtures/gdi-paths/pen-color-wine-oracle.json']])
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'gdi-paths',
    'description': 'Native polygon and line GUI: color, alpha and mono masks; copies after source deletion, owned bitmap-plane roundtrip, clipping and three native drawing channels. Close to finish.',
    'exe': 'gdi-paths/gdi-paths.exe', 'exeSha256': digest(DEST / 'gdi-paths.exe'),
    'zip': 'gdi-paths/gdi-paths.zip', 'zipSha256': digest(DEST / 'gdi-paths.zip'),
    'sourceZip': 'gdi-paths/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors MIT Windows SDK client; complete deterministic source build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "gdi-paths",'
replacement = json.dumps(entry, indent=2, ensure_ascii=False).replace('\n', '\n    ')
if marker in raw:
    start = raw.index(marker) + 4
    old, length = json.JSONDecoder().raw_decode(raw[start:])
    assert old['name'] == entry['name']
    path.write_text(raw[:start] + replacement + raw[start + length:])
else:
    end = raw.rfind('\n  ]')
    assert end >= 0
    path.write_text(raw[:end] + ',\n    ' + replacement + raw[end:])
print('Packaged native polygon and line GUI:', entry['exeSha256'])
