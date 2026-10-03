"""Package the pinned, unchanged MIT GUI release and original source archive."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'third_party' / 'minesweeper'
PUBLIC = ROOT / 'public' / 'examples'
DEST = PUBLIC / 'minesweeper'
EXE_SHA = 'd97ab2cabe8e4eb9cfd95079fb743bdd9b762592e2774382bc0d032a22b2988e'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


if digest(SOURCE / 'minesweeper.exe') != EXE_SHA:
    raise SystemExit('Pinned unchanged executable mismatch')
if digest(SOURCE / 'upstream-source.zip') != 'cdddd02f30424da909f798b2ffb07e765fdba4355e704a334176cdaf764078e6':
    raise SystemExit('Pinned upstream source mismatch')
DEST.mkdir(parents=True, exist_ok=True)
for name in ['minesweeper.exe', 'LICENSE.md', 'PROVENANCE.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(SOURCE / 'upstream-source.zip', DEST / 'source.zip')
with zipfile.ZipFile(DEST / 'minesweeper.zip', 'w') as archive:
    for name in ['LICENSE.md', 'PROVENANCE.md', 'minesweeper.exe']:
        info = zipfile.ZipInfo('minesweeper/' + name, (1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (DEST / name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
manifest_path = PUBLIC / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
entry = {
    'name': 'minesweeper',
    'description': 'Unchanged MIT wesmar Minesweeper: reveal cells, flag mines, select difficulty and customize the board through original Win32 dialogs.',
    'exe': 'minesweeper/minesweeper.exe',
    'exeSha256': EXE_SHA,
    'zip': 'minesweeper/minesweeper.zip',
    'zipSha256': digest(DEST / 'minesweeper.zip'),
    'sourceZip': 'minesweeper/source.zip',
    'sourceZipSha256': digest(DEST / 'source.zip'),
    'provenance': 'MIT, wesmar/minesweeper commit a950b89de6946faa360dcd5febfcb4206a877af1; unchanged release EXE.',
}
manifest['interactive'] = [e for e in manifest['interactive'] if e['name'] != 'minesweeper'] + [entry]
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print('Packaged unchanged Minesweeper release:', EXE_SHA)
