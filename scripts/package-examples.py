"""Package pinned third-party examples separately from generated native fixtures."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'third_party' / 'tetris'
PUBLIC = ROOT / 'public' / 'examples'
DEST = PUBLIC / 'tetris'
EXE_SHA = '3687bc1cfe9a7657ca9da1daacec9f97a92946f0b0440acdb70d3a71a4560007'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def archive(path, files, base):
    with zipfile.ZipFile(path, 'w') as output:
        for source in sorted(files):
            info = zipfile.ZipInfo(source.relative_to(base).as_posix(), (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, source.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


manifest_path = PUBLIC / 'manifest.json'
previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'format': 1, 'interactive': []}
if previous.get('format') != 1 or not isinstance(previous.get('interactive'), list):
    raise SystemExit('Unsupported example manifest')
seen = set()
for entry in previous['interactive']:
    if not isinstance(entry, dict) or not entry.get('name') or entry['name'] in seen:
        raise SystemExit('Invalid or duplicate example entry')
    seen.add(entry['name'])
    if entry['name'] == 'tetris':
        continue
    for field in ('exe', 'zip', 'sourceZip'):
        if field not in entry:
            if field != 'sourceZip':
                raise SystemExit(f'Missing {field} for {entry["name"]}')
            continue
        asset = (PUBLIC / entry[field]).resolve()
        if not asset.is_relative_to(PUBLIC.resolve()) or not asset.is_file() or digest(asset) != entry.get(field + 'Sha256'):
            raise SystemExit(f'Pinned example asset mismatch: {entry["name"]} {field}')

if digest(SOURCE / 'tetris.exe') != EXE_SHA:
    raise SystemExit('Pinned upstream Tetris executable hash mismatch')
DEST.mkdir(parents=True, exist_ok=True)
for name in ['tetris.exe', 'LICENSE.md', 'PROVENANCE.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
archive(DEST / 'tetris.zip', [DEST / name for name in ['tetris.exe', 'LICENSE.md', 'PROVENANCE.md']], PUBLIC)
archive(DEST / 'source.zip', [path for path in SOURCE.rglob('*') if path.is_file() and path.suffix != '.exe'], SOURCE.parent)
manifest = {
    'format': 1,
    'interactive': [{
        'name': 'tetris',
        'description': 'Unchanged wesmar/Tetris x86 release: arrows move/rotate, Space drops, P pauses, F2 restarts.',
        'exe': 'tetris/tetris.exe',
        'exeSha256': EXE_SHA,
        'zip': 'tetris/tetris.zip',
        'zipSha256': digest(DEST / 'tetris.zip'),
        'sourceZip': 'tetris/source.zip',
        'sourceZipSha256': digest(DEST / 'source.zip'),
        'provenance': 'MIT, wesmar/Tetris commit 19ffc5849931f4419230efb596be7f967b31a11c; unchanged release EXE.',
    }],
}
replacement = manifest['interactive'][0]
entries = [replacement if entry['name'] == 'tetris' else entry for entry in previous['interactive']]
if 'tetris' not in seen:
    entries.append(replacement)
previous['interactive'] = entries
manifest_path.write_text(json.dumps(previous, indent=2) + '\n')
print('Packaged unchanged Tetris release:', EXE_SHA)
