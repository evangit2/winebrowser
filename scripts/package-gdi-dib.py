"""Publish the authored bitmap GUI with reproducible source and MIT license."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/gdi-dib'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'gdi-dib'


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
for name in ['gdi-dib.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native bitmap transfers\n\nOriginal WineBrowser contributors C program, MIT.\n\n'
    'MinGW compiles the authored Windows SDK client into PE32 x86 input. The\n'
    'browser translates the unchanged executable to Wasm while it runs.\n'
    'No application-specific precompiled Wasm or third-party binary is included.\n\n'
    f'Executable SHA-256: `{digest(DEST / "gdi-dib.exe")}`\n\n'
    f'Source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'Source: `tests/fixtures/gdi-dib/client.c`; rebuild from the source archive\n'
    'with `sh scripts/build-gdi-dib-fixture.sh` after installing i686 MinGW.\n'
)
archive(DEST / 'gdi-dib.zip', [
    ('gdi-dib/' + name, (DEST / name).read_bytes())
    for name in ['gdi-dib.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']
])
archive(DEST / 'source.zip', [
    ('tests/fixtures/gdi-dib/client.c', (SOURCE / 'client.c').read_bytes()),
    ('tests/fixtures/gdi-dib/README.md', (SOURCE / 'README.md').read_bytes()),
    ('scripts/build-gdi-dib-fixture.sh', (ROOT / 'scripts/build-gdi-dib-fixture.sh').read_bytes()),
    ('LICENSE', (ROOT / 'LICENSE').read_bytes()),
])
path = PUBLIC / 'manifest.json'
manifest = json.loads(path.read_text())
entry = {
    'name': 'gdi-dib',
    'description': 'Native Win32 bitmap GUI: RGB color bars, six DIB pixel formats and palette checks. Press F6 to update two rows through SetDIBits. Close the window to finish.',
    'exe': 'gdi-dib/gdi-dib.exe', 'exeSha256': digest(DEST / 'gdi-dib.exe'),
    'zip': 'gdi-dib/gdi-dib.zip', 'zipSha256': digest(DEST / 'gdi-dib.zip'),
    'sourceZip': 'gdi-dib/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors C program, MIT; reproducible source and MinGW build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "gdi-dib",'
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
print('Packaged native bitmap GUI:', entry['exeSha256'])
