"""Publish the authored native owned cursor GUI and its complete source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/owned-cursors'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'owned-cursors'
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
for name in ['owned-cursors.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native owned cursor GUI\n\nOriginal WineBrowser contributors, MIT.\n\n'
    'Unchanged native Windows SDK PE32 executable built with MinGW. Browser-local\n'
    'x86-to-Wasm translation happens during execution. No third-party game assets.\n\n'
    f'Executable SHA-256: `{digest(DEST / "owned-cursors.exe")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'The source archive includes the client, license, documentation and deterministic\n'
    'build script for the native GUI.\n'
)
archive(DEST / 'owned-cursors.zip', [('owned-cursors/' + name, (DEST / name).read_bytes()) for name in ['owned-cursors.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']])
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in ['LICENSE', 'scripts/build-owned-cursors-fixture.sh', 'tests/fixtures/owned-cursors/client.c', 'tests/fixtures/owned-cursors/shapes.h', 'tests/fixtures/owned-cursors/README.md', 'tests/fixtures/owned-cursors/oracle.c', 'tests/fixtures/owned-cursors/wine-oracle.json', 'tests/fixtures/owned-cursors/draw-oracle.c', 'tests/fixtures/owned-cursors/draw-wine-oracle.json', 'tests/fixtures/owned-cursors/shapes-oracle.c', 'tests/fixtures/owned-cursors/shapes-wine-oracle.json', 'tests/fixtures/owned-cursors/resource-oracle.c', 'tests/fixtures/owned-cursors/resource-wine-oracle.json', 'scripts/build-custom-cursors-fixture.sh', 'tests/fixtures/custom-cursors/main.c', 'tests/fixtures/custom-cursors/generate.py', 'tests/fixtures/custom-cursors/cursors.rc', 'tests/fixtures/custom-cursors/README.md']])
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'owned-cursors',
    'description': 'Native owned cursor GUI: try alpha and monochrome mouse cursors, copies, scaling, visibility, hotspots and active destruction. Close to finish.',
    'exe': 'owned-cursors/owned-cursors.exe', 'exeSha256': digest(DEST / 'owned-cursors.exe'),
    'zip': 'owned-cursors/owned-cursors.zip', 'zipSha256': digest(DEST / 'owned-cursors.zip'),
    'sourceZip': 'owned-cursors/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors MIT Windows SDK client; complete deterministic source build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "owned-cursors",'
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
print('Packaged native owned cursor GUI:', entry['exeSha256'])
