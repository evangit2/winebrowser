"""Publish the authored native brush raster GUI and its complete source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/gdi-brush-rop'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'gdi-brush-rop'
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
for name in ['gdi-brush-rop.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native brush raster GUI\n\nOriginal WineBrowser contributors, MIT.\n\n'
    'Unchanged native Windows SDK PE32 executable built with MinGW. Browser-local\n'
    'x86-to-Wasm translation happens during execution. No third-party game assets.\n\n'
    f'Executable SHA-256: `{digest(DEST / "gdi-brush-rop.exe")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'The source archive includes the client, license, documentation and deterministic\n'
    'build script for the native GUI.\n'
)
archive(DEST / 'gdi-brush-rop.zip', [('gdi-brush-rop/' + name, (DEST / name).read_bytes()) for name in ['gdi-brush-rop.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']])
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in ['LICENSE', 'scripts/build-gdi-brush-rop-fixture.sh', 'tests/fixtures/gdi-brush-rop/client.c', 'tests/fixtures/gdi-brush-rop/layout.h', 'tests/fixtures/gdi-brush-rop/README.md', 'tests/fixtures/gdi-brush-rop/oracle.c', 'tests/fixtures/gdi-brush-rop/wine-oracle.json', 'tests/fixtures/gdi-brush-rop/gui-oracle.c', 'tests/fixtures/gdi-brush-rop/gui-wine-oracle.json']])
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'gdi-brush-rop',
    'description': 'Native brush GUI: try sixteen paint rules with color/mono patterns, transparent hatches, holes and reversed coordinates. Close to finish.',
    'exe': 'gdi-brush-rop/gdi-brush-rop.exe', 'exeSha256': digest(DEST / 'gdi-brush-rop.exe'),
    'zip': 'gdi-brush-rop/gdi-brush-rop.zip', 'zipSha256': digest(DEST / 'gdi-brush-rop.zip'),
    'sourceZip': 'gdi-brush-rop/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors MIT Windows SDK client; complete deterministic source build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "gdi-brush-rop",'
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
print('Packaged native brush raster GUI:', entry['exeSha256'])
