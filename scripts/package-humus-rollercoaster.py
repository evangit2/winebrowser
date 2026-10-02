"""Preserve Humus's redistributable RollerCoaster archive without rebuilding it."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'humus-rollercoaster'
SOURCE = ROOT / '.cache/demo-research/RollerCoaster.zip'
DEST = ROOT / 'public/examples' / NAME
ARCHIVE_SHA = 'fbb55c23ae94469ba12712ce830186d719de1a3abc983a3298a055331f0de0a0'
EXE_SHA = 'acf1fed9b4863723b41600d4016e97dd3ec6313dbd5144622919f9b8103e912e'
if not SOURCE.exists():
    raise SystemExit('Download https://humus.name/3D/RollerCoaster.zip to ' + str(SOURCE))
if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != ARCHIVE_SHA:
    raise SystemExit('RollerCoaster archive hash mismatch')
with zipfile.ZipFile(SOURCE) as archive:
    exe = archive.read('RollerCoaster/RollerCoaster.exe')
    readme = archive.read('readme.txt')
if hashlib.sha256(exe).hexdigest() != EXE_SHA:
    raise SystemExit('RollerCoaster EXE hash mismatch')
DEST.mkdir(parents=True, exist_ok=True)
shutil.copyfile(SOURCE, DEST / 'RollerCoaster.zip')
(DEST / 'RollerCoaster.exe').write_bytes(exe)
(DEST / 'readme.txt').write_bytes(readme)
(DEST / 'PROVENANCE.md').write_text(f'''# Humus RollerCoaster (Direct3D 9)

Emil Persson (Humus) made this demo. Its included readme permits free use and
redistribution by any method, provided the readme is included. The unchanged
ZIP retains the readme, executable, shaders, source, terrain and texture assets.

- Author/demo listing: <https://www.humus.name/index.php?page=3D>
- Original archive: <https://humus.name/3D/RollerCoaster.zip>
- Archive SHA-256: `{ARCHIVE_SHA}`.
- Original `RollerCoaster/RollerCoaster.exe` SHA-256: `{EXE_SHA}`.
- Archive size: {SOURCE.stat().st_size:,} bytes.
- F1 opens the upstream settings menu. Close the guest window to exit.

The executable uses a moving camera on a reflective roller-coaster track,
large indexed terrain, 3D procedural noise, cube reflections, water, lava and
particles. WineBrowser translates its original x86 blocks to Wasm and its
original Direct3D shaders to WebGPU during execution in the browser. It does
not patch or pretranslate the executable. Load the ZIP to include its assets.
Startup is CPU intensive; this is a compatibility demo, not a performance claim.
''')
manifest_path = ROOT / 'public/examples/manifest.json'
manifest = json.loads(manifest_path.read_text())
entries = [entry for entry in manifest['interactive'] if entry['name'] != NAME]
entries.append({
    'name': NAME,
    'description': 'Unchanged Humus RollerCoaster D3D9 demo: moving reflective track, terrain, water, lava and particles. CPU intensive startup; close its window to exit.',
    'exe': f'{NAME}/RollerCoaster.exe', 'exeSha256': EXE_SHA,
    'zip': f'{NAME}/RollerCoaster.zip', 'zipSha256': ARCHIVE_SHA,
    'provenance': 'Freeware by Emil Persson (Humus); redistribution permitted with readme included. Original archive, executable and shaders.',
})
manifest['interactive'] = sorted(entries, key=lambda entry: entry['name'])
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print('Packaged unchanged RollerCoaster:', EXE_SHA)
