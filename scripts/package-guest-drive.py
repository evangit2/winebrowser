"""Publish the authored native guest drive GUI and its complete source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/guest-drive'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'guest-drive'
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
for name in ['guest-drive.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native guest drive GUI\n\nOriginal WineBrowser contributors, MIT.\n\n'
    'Unchanged native Windows SDK PE32 executable built with MinGW. Browser-local\n'
    'x86-to-Wasm translation happens during execution. No third-party game assets.\n\n'
    f'Executable SHA-256: `{digest(DEST / "guest-drive.exe")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'The source archive includes the client, license, documentation and deterministic\n'
    'build script for both the native GUI and SDK host-only acceptance client.\n'
)
archive(DEST / 'guest-drive.zip', [('guest-drive/' + name, (DEST / name).read_bytes()) for name in ['guest-drive.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']])
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in ['LICENSE', 'scripts/build-guest-drive-fixture.sh', 'tests/fixtures/guest-drive/client.c', 'tests/fixtures/guest-drive/README.md']])
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'guest-drive',
    'description': 'Native drive GUI: write an 8 KiB file, resize it to 4 KiB and delete it while free-space figures update. Open file imports and reads a selected file. Close the window to finish.',
    'exe': 'guest-drive/guest-drive.exe', 'exeSha256': digest(DEST / 'guest-drive.exe'),
    'zip': 'guest-drive/guest-drive.zip', 'zipSha256': digest(DEST / 'guest-drive.zip'),
    'sourceZip': 'guest-drive/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors MIT Windows SDK client; complete deterministic source build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "guest-drive",'
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
print('Packaged native guest drive GUI:', entry['exeSha256'])
