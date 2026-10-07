"""Publish the authored native GUI and the editable LGPL control adapter."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/frame-controls'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'frame-controls'
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
for name in ['frame-controls.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native classic control GUI\n\nOriginal WineBrowser contributors, MIT SDK client.\n\n'
    'Unchanged native Windows SDK PE32 executable built with MinGW. Browser-local\n'
    'x86-to-Wasm translation happens during execution. No third-party game assets.\n\n'
    f'Executable SHA-256: `{digest(DEST / "frame-controls.exe")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'The complete deterministic native client build is in source.zip. The separate\n'
    'Wine-derived browser adapter is LGPL-2.1-or-later; its editable source and\n'
    'upstream reference are published at ../../runtime/frame-controls/.\n'
)
archive(DEST / 'frame-controls.zip', [('frame-controls/' + name, (DEST / name).read_bytes()) for name in ['frame-controls.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']])
source_files = ['LICENSE', 'scripts/build-frame-controls-fixture.sh', 'tests/fixtures/frame-controls/client.c', 'tests/fixtures/frame-controls/layout.h', 'tests/fixtures/frame-controls/README.md', 'tests/fixtures/frame-controls/oracle.c', 'tests/fixtures/frame-controls/wine-oracle.json', 'tests/fixtures/frame-controls/gui-oracle.c', 'tests/fixtures/frame-controls/gui-wine-oracle.json']
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in source_files])
runtime = ROOT / 'public/runtime/frame-controls'
runtime.mkdir(parents=True, exist_ok=True)
for name, path in [('gdi-frame-controls.js', 'src/gdi-frame-controls.js'), ('wine-uitools.c', 'third_party/wine/user32-uitools.c'), ('COPYING.LIB', 'third_party/wine/COPYING.LIB'), ('README.md', 'runtime/frame-controls/README.md')]:
    shutil.copyfile(ROOT / path, runtime / name)
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'frame-controls',
    'description': 'Native classic control GUI: push buttons, checkboxes, three-state controls, scroll arrows and menu marks. Try states, clipping and adjusted rectangles; close to finish.',
    'exe': 'frame-controls/frame-controls.exe', 'exeSha256': digest(DEST / 'frame-controls.exe'),
    'zip': 'frame-controls/frame-controls.zip', 'zipSha256': digest(DEST / 'frame-controls.zip'),
    'sourceZip': 'frame-controls/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original MIT Windows SDK client; complete deterministic source build included. Separate Wine-derived browser geometry adapter retains LGPL source and notices.',
}
raw = path.read_text()
marker = '    {\n      "name": "frame-controls",'
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
print('Packaged native frame control GUI:', entry['exeSha256'])
