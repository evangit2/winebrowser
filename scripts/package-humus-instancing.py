"""Preserve Humus's redistributable Instancing archive without rebuilding it."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'humus-instancing'
SOURCE = ROOT / '.cache/demo-research/Instancing.zip'
DEST = ROOT / 'public/examples' / NAME
ARCHIVE_SHA = '9c74c3a787a1320e9cd7e7f708ff923f4a83be5a6e1dc93b80763c3c398e61f7'
EXE_SHA = '37df64605e11c7a23df2d5befeb0bf38d2b9b6d2bf1322ffb1d0a437030b2903'
if not SOURCE.exists():
    raise SystemExit('Download https://humus.name/3D/Instancing.zip to ' + str(SOURCE))
if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != ARCHIVE_SHA:
    raise SystemExit('Instancing archive hash mismatch')
with zipfile.ZipFile(SOURCE) as archive:
    exe = archive.read('Instancing/Instancing.exe')
    readme = archive.read('readme.txt')
if hashlib.sha256(exe).hexdigest() != EXE_SHA:
    raise SystemExit('Instancing EXE hash mismatch')
DEST.mkdir(parents=True, exist_ok=True)
shutil.copyfile(SOURCE, DEST / 'Instancing.zip')
(DEST / 'Instancing.exe').write_bytes(exe)
(DEST / 'readme.txt').write_bytes(readme)
(DEST / 'PROVENANCE.md').write_text(f'''# Humus Instancing (Direct3D 9)

Emil Persson (Humus) made this demo. Its included readme permits free use and
redistribution by any method, provided the readme is included. The unchanged
ZIP retains the readme, executable, shaders, source and particle/font texture assets.

- Author/demo listing: <https://www.humus.name/index.php?page=3D>
- Original archive: <https://humus.name/3D/Instancing.zip>
- Archive SHA-256: `{ARCHIVE_SHA}`.
- Original `Instancing/Instancing.exe` SHA-256: `{EXE_SHA}`.
- Archive size: {SOURCE.stat().st_size:,} bytes.
- F1 opens the upstream settings menu. Close the guest window to exit.

The executable renders animated additive particle clouds using its original
shader-constant batching path. WineBrowser translates its x86 blocks to Wasm
and its native D3D9 shaders to WebGPU during execution. The program chooses
this fallback itself from the advertised shader versions. Hardware stream
frequency instancing remains unsupported.

Keys 2, 3 and 4 select shader-constant batching, vertex-buffer upload and
user-pointer arrays. These three paths are covered by the browser regression.
Load the ZIP to include the assets.
''')
manifest_path = ROOT / 'public/examples/manifest.json'
manifest = json.loads(manifest_path.read_text())
entries = [entry for entry in manifest['interactive'] if entry['name'] != NAME]
entries.append({
    'name': NAME,
    'description': 'Animated Humus D3D9 particle clouds using the original shader-constant batching path. Keys 2–4 compare drawing paths; close its window to exit.',
    'exe': f'{NAME}/Instancing.exe', 'exeSha256': EXE_SHA,
    'zip': f'{NAME}/Instancing.zip', 'zipSha256': ARCHIVE_SHA,
    'provenance': 'Freeware by Emil Persson (Humus); redistribution permitted with readme included. Original archive, executable and shaders.',
})
manifest['interactive'] = sorted(entries, key=lambda entry: entry['name'])
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print('Packaged unchanged Instancing:', EXE_SHA)
