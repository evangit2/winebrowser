"""Publish the authored bitmap GUI with reproducible source and MIT license."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/gdi-section'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'gdi-section'


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
for name in ['gdi-section.exe', 'bitmap-producer.dll', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native shared bitmap GUI\n\nOriginal WineBrowser contributors C program, MIT.\n\n'
    'MinGW compiles the authored Windows SDK client into PE32 x86 input. The\n'
    'browser translates the unchanged EXE and DLL to Wasm while they run.\n'
    'No application-specific precompiled Wasm or third-party binary is included.\n\n'
    f'Executable SHA-256: `{digest(DEST / "gdi-section.exe")}`\n\n'
    f'Native DLL SHA-256: `{digest(DEST / "bitmap-producer.dll")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    f'Producer source SHA-256: `{digest(SOURCE / "producer.c")}`\n\n'
    'Sources: `tests/fixtures/gdi-section/client.c` and `producer.c`; rebuild from the source archive\n'
    'with `sh scripts/build-gdi-section-fixture.sh` after installing i686 MinGW.\n'
)
archive(DEST / 'gdi-section.zip', [
    ('gdi-section/' + name, (DEST / name).read_bytes())
    for name in ['gdi-section.exe', 'bitmap-producer.dll', 'README.md', 'LICENSE', 'PROVENANCE.md']
])
archive(DEST / 'source.zip', [
    ('tests/fixtures/gdi-section/client.c', (SOURCE / 'client.c').read_bytes()),
    ('tests/fixtures/gdi-section/producer.c', (SOURCE / 'producer.c').read_bytes()),
    ('tests/fixtures/gdi-section/README.md', (SOURCE / 'README.md').read_bytes()),
    ('scripts/build-gdi-section-fixture.sh', (ROOT / 'scripts/build-gdi-section-fixture.sh').read_bytes()),
    ('LICENSE', (ROOT / 'LICENSE').read_bytes()),
])
path = PUBLIC / 'manifest.json'
manifest = json.loads(path.read_text())
entry = {
    'name': 'gdi-section',
    'description': 'Native EXE + DLL shared bitmap GUI. Press F6 for DLL pixel writes, GDI painting, CRT clearing and restoration. Close the window to finish.',
    'exe': 'gdi-section/gdi-section.exe', 'exeSha256': digest(DEST / 'gdi-section.exe'),
    'zip': 'gdi-section/gdi-section.zip', 'zipSha256': digest(DEST / 'gdi-section.zip'),
    'sourceZip': 'gdi-section/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors C program, MIT; reproducible source and MinGW build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "gdi-section",'
replacement = json.dumps(entry, indent=2, ensure_ascii=False).replace('\n', '\n    ')
if marker in raw:
    start = raw.index(marker) + 4
    previous, length = json.JSONDecoder().raw_decode(raw[start:])
    assert previous['name'] == entry['name']
    path.write_text(raw[:start] + replacement + raw[start + length:])
else:
    end = raw.rfind('\n  ]')
    assert end >= 0 and not any(item['name'] == entry['name'] for item in manifest['interactive'])
    path.write_text(raw[:end] + ',\n    ' + replacement + raw[end:])
print('Packaged native shared bitmap GUI:', entry['exeSha256'])
