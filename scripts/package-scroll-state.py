"""Publish the authored native scrollbar state inspector and its complete source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/scroll-state'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'scroll-state'
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
for name in ['scroll-state.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
(DEST / 'PROVENANCE.md').write_text(
    '# Native scrollbar state inspector\n\nOriginal WineBrowser contributors, MIT.\n\n'
    'Unchanged native Windows SDK PE32 executable built with MinGW. Browser-local\n'
    'x86-to-Wasm translation happens during execution. No third-party game assets.\n\n'
    f'Executable SHA-256: `{digest(DEST / "scroll-state.exe")}`\n\n'
    f'Client source SHA-256: `{digest(SOURCE / "client.c")}`\n\n'
    'The source archive includes the client, license, documentation and deterministic\n'
    'build script for the native GUI.\n'
)
archive(DEST / 'scroll-state.zip', [('scroll-state/' + name, (DEST / name).read_bytes()) for name in ['scroll-state.exe', 'README.md', 'LICENSE', 'PROVENANCE.md']])
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in ['LICENSE', 'scripts/build-scroll-state-fixture.sh', 'tests/fixtures/scroll-state/client.c', 'tests/fixtures/scroll-state/README.md', 'tests/fixtures/scroll-state/oracle.c', 'tests/fixtures/scroll-state/extra.c', 'tests/fixtures/scroll-state/extra-handles.c', 'tests/fixtures/scroll-state/callback.c', 'tests/fixtures/scroll-state/wine-oracle.json', 'tests/fixtures/scroll-state/extra-wine-oracle.json', 'tests/fixtures/scroll-state/callback-wine-oracle.json']])
path = PUBLIC / 'manifest.json'
entry = {
    'name': 'scroll-state',
    'description': 'Native scrollbar state inspector: range/page clamping, signed limits, legacy structures and custom callbacks. Click stages and close to finish.',
    'exe': 'scroll-state/scroll-state.exe', 'exeSha256': digest(DEST / 'scroll-state.exe'),
    'zip': 'scroll-state/scroll-state.zip', 'zipSha256': digest(DEST / 'scroll-state.zip'),
    'sourceZip': 'scroll-state/source.zip', 'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'Original WineBrowser contributors MIT Windows SDK client; complete deterministic source build included.',
}
raw = path.read_text()
marker = '    {\n      "name": "scroll-state",'
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
print('Packaged native scrollbar state inspector:', entry['exeSha256'])
