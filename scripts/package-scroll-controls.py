"""Publish the authored native interactive scrollbar GUI and its complete source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/scroll-controls'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'scroll-controls'
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
for name in ['scroll-controls.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native interactive scrollbar GUI\n\nOriginal WineBrowser contributors, MIT.\n\n'
    'Unchanged native Windows SDK PE32 executable built with MinGW. Browser-local\n'
    'x86-to-Wasm translation happens during execution. No third-party game assets.\n\n'
    f'Executable SHA-256: `{digest(DEST / "scroll-controls.exe")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'The source archive includes the client, licenses, native captures and deterministic\n'
    'build script. The separately licensed shared frame painter is LGPL-2.1-or-later;\n'
    'its editable source and complete upstream reference are retained in source.zip.\n'
)
archive(DEST / 'scroll-controls.zip', [('scroll-controls/' + name, (DEST / name).read_bytes()) for name in ['scroll-controls.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']])
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in ['LICENSE', 'scripts/build-scroll-controls-fixture.sh', 'tests/fixtures/scroll-controls/client.c', 'tests/fixtures/scroll-controls/README.md', 'tests/fixtures/scroll-controls/oracle.c', 'tests/fixtures/scroll-controls/wine-oracle.json', 'tests/fixtures/scroll-controls/messages.c', 'tests/fixtures/scroll-controls/messages-wine-oracle.json', 'tests/fixtures/scroll-controls/enable.c', 'tests/fixtures/scroll-controls/enable-wine-oracle.json', 'tests/fixtures/scroll-controls/enabled.c', 'tests/fixtures/scroll-controls/enabled-wine-oracle.json', 'tests/fixtures/scroll-controls/dpi.c', 'tests/fixtures/scroll-controls/dpi-wine-oracle.json', 'src/win32-dpi.js', 'tests/fixtures/scroll-controls/keys.c', 'tests/fixtures/scroll-controls/keys-wine-oracle.json', 'tests/fixtures/scroll-controls/pointer.c', 'tests/fixtures/scroll-controls/pointer-wine-oracle.json', 'tests/fixtures/scroll-controls/native-driver.c', 'tests/fixtures/scroll-controls/alignment.c', 'tests/fixtures/scroll-controls/alignment-wine-oracle.json', 'tests/fixtures/scroll-controls/geometry.c', 'tests/fixtures/scroll-controls/geometry-wine-oracle.json', 'src/gdi-scrollbars.js', 'src/scrollbar-geometry.js', 'src/gdi-frame-controls.js', 'src/gdi-raster.js', 'src/gdi-paths.js', 'third_party/wine/COPYING.LIB', 'third_party/wine/user32-uitools.c', 'runtime/frame-controls/README.md']])
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'scroll-controls',
    'description': 'Native interactive scrollbars with top/bottom and left/right alignment: click arrows and track, drag thumbs, use keyboard navigation, and try large ranges or disabled arrows. Close to finish.',
    'exe': 'scroll-controls/scroll-controls.exe', 'exeSha256': digest(DEST / 'scroll-controls.exe'),
    'zip': 'scroll-controls/scroll-controls.zip', 'zipSha256': digest(DEST / 'scroll-controls.zip'),
    'sourceZip': 'scroll-controls/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original MIT Windows SDK client; deterministic source build and native captures included. Shared LGPL frame painter retains editable source and notices.',
}
raw = path.read_text()
marker = '    {\n      "name": "scroll-controls",'
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
print('Packaged native interactive scrollbar GUI:', entry['exeSha256'])
