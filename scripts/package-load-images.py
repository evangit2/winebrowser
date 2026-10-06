"""Publish authored image-loader inputs and their complete deterministic source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/load-images'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'load-images'
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
names = ['load-images.exe', 'bitmap-resources.dll', 'README.md'] + sorted(p.name for p in SOURCE.glob('*.bmp'))
for name in names:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native image loader GUI\n\nOriginal WineBrowser contributors C programs and generated images, MIT.\n\n'
    'MinGW creates native Windows SDK EXE/DLL inputs. The browser translates their\n'
    'unchanged x86 code into Wasm during execution; there is no application-specific Wasm build.\n\n'
    f'Executable SHA-256: `{digest(SOURCE / "load-images.exe")}`\n\n'
    f'Resource DLL SHA-256: `{digest(SOURCE / "bitmap-resources.dll")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'All image/resource data are authored fixtures. The source archive contains the\n'
    'client, DLL source, bitmap generator, resource scripts and required cursor/icon\n'
    'assets with their generators. Rebuild with `sh scripts/build-load-images-fixture.sh`\n'
    'after installing i686 MinGW; timestamps and ZIP metadata are deterministic.\n'
)
archive(DEST / 'load-images.zip', [('load-images/' + name, (DEST / name).read_bytes()) for name in names + ['LICENSE', 'PROVENANCE.md']])
source_names = [
    'scripts/build-load-images-fixture.sh', 'LICENSE',
    'tests/fixtures/load-images/client.c', 'tests/fixtures/load-images/generate.py',
    'tests/fixtures/load-images/resources.rc', 'tests/fixtures/load-images/README.md',
    'tests/fixtures/resource-bitmaps/resources.rc', 'tests/fixtures/resource-bitmaps/generate.py',
    'tests/fixtures/resource-bitmaps/library.c', 'tests/fixtures/resource-bitmaps/README.md',
    'tests/fixtures/custom-cursors/mono.cur', 'tests/fixtures/custom-cursors/generate.py',
    'tests/fixtures/custom-cursors/README.md', 'tests/fixtures/icon24/icon24.ico',
    'tests/fixtures/icon24/generate.py', 'tests/fixtures/icon24/README.md',
]
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in source_names])
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'load-images',
    'description': 'Image loader GUI: original, themed and file-loaded bitmaps. Press F6 to change a pixel through the native bitmap pointer, then restore it. Close the window to finish.',
    'exe': 'load-images/load-images.exe', 'exeSha256': digest(DEST / 'load-images.exe'),
    'zip': 'load-images/load-images.zip', 'zipSha256': digest(DEST / 'load-images.zip'),
    'sourceZip': 'load-images/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors MIT C programs and generated images; complete source build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "load-images",'
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
print('Packaged native image loader GUI:', entry['exeSha256'])
