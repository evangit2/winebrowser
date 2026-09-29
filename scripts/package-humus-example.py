"""Package the unchanged Humus Dynamic Branching archives as a hosted example.

The upstream readme is freeware and permits redistribution provided it stays
included, so the original ZIP is republished byte-for-byte alongside a
provenance note. Nothing is rebuilt or patched.
"""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public' / 'examples'
NAME = 'humus-dynamic-branching'
DEST = PUBLIC / NAME
SOURCE = ROOT / '.cache/targets' / 'humus-dynamic-branching-d3d9-x86.upstream.zip'
ARCHIVE_SHA = '8063039867fb69e4c58c6bad90f4aad80e43d0eb5c33818e1ba5a9c2be57077a'
EXE_SHA = '7664f1f55d71593b6af9475bef06aba811bbe8a5ec3ba690ec559064d6207bc5'
PROVENANCE = """# Humus 3D "Dynamic Branching" (Direct3D 9)

This directory republishes the unchanged upstream demo archive by Emil Persson
(a.k.a. Humus), <http://www.humus.name>, under the terms in its own readme.txt:
the demo is freeware and may be used and distributed by anyone for any purpose,
provided the readme is included.

- Upstream page: <https://www.humus.name/index.php?ID=5&page=3D>
- Upstream archive: <https://humus.name/3D/DynamicBranching.zip>
- Upstream archive SHA-256: `8063039867fb69e4c58c6bad90f4aad80e43d0eb5c33818e1ba5a9c2be57077a`.
- `DynamicBranching/DynamicBranching.exe` SHA-256:
  `7664f1f55d71593b6af9475bef06aba811bbe8a5ec3ba690ec559064d6207bc5`.
- Controls: F1 opens the settings menu; the demo's default view uses the
  Dynamic Branching stencil-shadow path.

The executable, shaders, HMDL model and DDS textures are the upstream originals.
WineBrowser translates the x86 code to WebAssembly in the browser; it does not
patch, recompile or substitute the demo's own shaders.
"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


if not SOURCE.exists():
    raise SystemExit(f'Run `npm run fetch:targets` first: missing {SOURCE}')
if digest(SOURCE) != ARCHIVE_SHA:
    raise SystemExit('Upstream Humus archive hash mismatch')

DEST.mkdir(parents=True, exist_ok=True)
for name in DEST.iterdir():
    if name.is_file():
        name.unlink()
shutil.copyfile(SOURCE, DEST / 'DynamicBranching.zip')
# Publish the demo's own executable next to the archive as well, so the catalog
# entry that names it can be fetched directly. The bytes come from the pinned
# archive, are verified against EXE_SHA, and are written verbatim; the demo
# keeps its relative Textures/ and Models/ references because the playable
# package is still the upstream ZIP.
with zipfile.ZipFile(SOURCE) as archive:
    member = next(
        (name for name in archive.namelist() if name.lower().endswith('dynamicbranching.exe')),
        None,
    )
    if member is None:
        raise SystemExit('Upstream archive has no DynamicBranching.exe')
    exe_bytes = archive.read(member)
if hashlib.sha256(exe_bytes).hexdigest() != EXE_SHA:
    raise SystemExit('Upstream DynamicBranching.exe hash mismatch')
(DEST / 'DynamicBranching.exe').write_bytes(exe_bytes)
(DEST / 'PROVENANCE.md').write_text(PROVENANCE)

# The playable package is the upstream archive exactly as downloaded, so its
# internal paths (Textures/, Models/) keep the demo's own relative references.
manifest_path = PUBLIC / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
entries = [entry for entry in manifest['interactive'] if entry['name'] != NAME]
entries.append({
    'name': NAME,
    'description': (
        'Unchanged Humus "Dynamic Branching" Direct3D 9 demo: a stencil-shadow '
        'pillar room with programmable shaders and DXT textures. F1 opens settings.'
    ),
    'exe': f'{NAME}/DynamicBranching.exe',
    'exeSha256': EXE_SHA,
    'zip': f'{NAME}/DynamicBranching.zip',
    'zipSha256': ARCHIVE_SHA,
    'provenance': (
        'Freeware, Emil Persson (Humus); upstream readme permits redistribution '
        'with the readme included. Unchanged upstream archive.'
    ),
})
manifest['interactive'] = sorted(entries, key=lambda entry: entry['name'])
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print('Packaged unchanged Humus Dynamic Branching:', EXE_SHA)
