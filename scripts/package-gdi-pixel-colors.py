"""Publish the authored native bitmap color GUI and its complete source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/gdi-pixel-colors'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'gdi-pixel-colors'
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
for name in ['gdi-pixel-colors.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native bitmap color GUI\n\nOriginal WineBrowser contributors, MIT.\n\n'
    'Unchanged native Windows SDK PE32 executable built with MinGW. Browser-local\n'
    'x86-to-Wasm translation happens during execution. No third-party game assets.\n\n'
    f'Executable SHA-256: `{digest(DEST / "gdi-pixel-colors.exe")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'The source archive includes the client, license, documentation and deterministic\n'
    'build script for the native GUI.\n'
)
archive(DEST / 'gdi-pixel-colors.zip', [('gdi-pixel-colors/' + name, (DEST / name).read_bytes()) for name in ['gdi-pixel-colors.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']])
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in ['LICENSE', 'scripts/build-gdi-pixel-colors-fixture.sh', 'scripts/generate-gdi-pixel-cases.py', 'tests/fixtures/gdi-pixel-colors/client.c', 'tests/fixtures/gdi-pixel-colors/README.md', 'tests/fixtures/gdi-pixel-colors/oracle.c', 'tests/fixtures/gdi-pixel-colors/wine-oracle.json', 'tests/fixtures/gdi-pixel-colors/native-cases.h', 'tests/fixtures/gdi-pixel-colors/bitfields-oracle.c', 'tests/fixtures/gdi-pixel-colors/bitfields-wine-oracle.json']])
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'gdi-pixel-colors',
    'description': 'Native bitmap color GUI: compare seven bitmap formats, RGB and palette colors, direct indices, range boundaries and clipping. Close to finish.',
    'exe': 'gdi-pixel-colors/gdi-pixel-colors.exe', 'exeSha256': digest(DEST / 'gdi-pixel-colors.exe'),
    'zip': 'gdi-pixel-colors/gdi-pixel-colors.zip', 'zipSha256': digest(DEST / 'gdi-pixel-colors.zip'),
    'sourceZip': 'gdi-pixel-colors/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors MIT Windows SDK client; complete deterministic source build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "gdi-pixel-colors",'
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
print('Packaged native bitmap color GUI:', entry['exeSha256'])
