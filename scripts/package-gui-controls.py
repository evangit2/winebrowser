"""Package our native GUI showcase with reproducible MIT source and provenance."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'demos/gui-controls'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'gui-controls'
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
def archive(path, files):
    with zipfile.ZipFile(path, 'w') as output:
        for name, content in files:
            info = zipfile.ZipInfo('gui-controls/' + name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
DEST.mkdir(parents=True, exist_ok=True)
for name in ['LICENSE', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
exe_sha = digest(DEST / 'gui-controls.exe')
(DEST / 'PROVENANCE.md').write_text(
    '# Native GUI controls\n\nCopyright (c) 2026 WineBrowser contributors, MIT.\n\n'
    'Original freestanding C source, compiled to a Windows PE32 x86 executable\n'
    'with MinGW. The app calls USER32, COMCTL32 and GDI32; its x86 code is\n'
    'translated to WebAssembly inside the browser. No app-specific Wasm\n'
    'artifact is included.\n\n'
    f'Executable SHA-256: `{exe_sha}`\n\n'
    f'C source SHA-256: `{digest(SOURCE / "main.c")}`\n\n'
    'Source: `demos/gui-controls/` in the WineBrowser repository. The source\n'
    'archive includes the standalone reproducible MinGW build script.\n')
archive(DEST / 'source.zip', [(name, (SOURCE / name).read_bytes())
    for name in ['main.c', 'build.sh', 'LICENSE', 'README.md']])
archive(DEST / 'gui-controls.zip', [(name, (DEST / name).read_bytes())
    for name in ['gui-controls.exe', 'LICENSE', 'README.md', 'PROVENANCE.md']])
path = PUBLIC / 'manifest.json'
manifest = json.loads(path.read_text())
entry = {'name': 'gui-controls', 'description': 'Native Win32 GUI showcase: tree, lists, editable combo, check/radio groups, menus, a draggable priorities list, native Priorities/Notes tabs and a custom GDI canvas with a nested button. All callbacks run from the Windows x86 EXE inside the browser.',
    'exe': 'gui-controls/gui-controls.exe', 'exeSha256': exe_sha,
    'zip': 'gui-controls/gui-controls.zip', 'zipSha256': digest(DEST / 'gui-controls.zip'),
    'sourceZip': 'gui-controls/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors C program, MIT; source and standalone MinGW build included.'}
raw = path.read_text()
marker = '    {\n      "name": "gui-controls",'
if marker in raw:
    # Replace this package's entry without reordering or reformatting unrelated examples.
    start = raw.index(marker) + 4
    previous, length = json.JSONDecoder().raw_decode(raw[start:])
    assert previous['name'] == entry['name']
    replacement = json.dumps(entry, indent=2, ensure_ascii=False).replace('\n', '\n    ')
    path.write_text(raw[:start] + replacement + raw[start + length:])
else:
    manifest['interactive'].append(entry)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
print('Packaged native GUI controls:', exe_sha)
