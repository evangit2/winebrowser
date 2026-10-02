"""Preserve Humus's redistributable TransparentShadowMapping archive without rebuilding it."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'humus-transparent-shadows'
SOURCE = ROOT / '.cache/demo-research/TransparentShadowMapping.zip'
DEST = ROOT / 'public/examples' / NAME
ARCHIVE_SHA = 'da7446674a70947d4c5ec43d70bbd9ceb6e71468fc1830faaeb7def1f4d45cb5'
EXE_SHA = '7364e6f1ff3fe694dc0c939ded55eeee526f61bfae6073e3e4530dd549a926cf'
if not SOURCE.exists():
    raise SystemExit('Download https://humus.name/3D/TransparentShadowMapping.zip to ' + str(SOURCE))
if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != ARCHIVE_SHA:
    raise SystemExit('TransparentShadowMapping archive hash mismatch')
with zipfile.ZipFile(SOURCE) as archive:
    exe = archive.read('TransparentShadowMapping/TransparentShadowMapping.exe')
    readme = archive.read('readme.txt')
if hashlib.sha256(exe).hexdigest() != EXE_SHA:
    raise SystemExit('TransparentShadowMapping EXE hash mismatch')
DEST.mkdir(parents=True, exist_ok=True)
shutil.copyfile(SOURCE, DEST / 'TransparentShadowMapping.zip')
(DEST / 'TransparentShadowMapping.exe').write_bytes(exe)
(DEST / 'readme.txt').write_bytes(readme)
(DEST / 'PROVENANCE.md').write_text(f'''# Humus TransparentShadowMapping (Direct3D 9)

Emil Persson (Humus) made this demo. Its included readme permits free use and
redistribution by any method, provided the readme is included. The unchanged
ZIP retains the readme, executable, shaders, source and room/font texture assets.

- Author/demo listing: <https://www.humus.name/index.php?page=3D>
- Original archive: <https://humus.name/3D/TransparentShadowMapping.zip>
- Archive SHA-256: `{ARCHIVE_SHA}`.
- Original `TransparentShadowMapping/TransparentShadowMapping.exe` SHA-256: `{EXE_SHA}`.
- Archive size: {SOURCE.stat().st_size:,} bytes.
- F1 opens the upstream settings menu. Close the guest window to exit.

The unchanged executable renders a room with stained glass and animated light.
Its original shader path renders six 512x512 cubemap faces with a shared D16
depth surface, then samples the shadow cube while drawing the room. WineBrowser
translates its native x86 blocks to Wasm during execution and compiles its
original D3D9 shader bytecode for WebGPU in the browser.

A sustained ordinary-upload probe passed more than 7,000 frames, animation of
the scene excluding the FPS text, and window-close exit zero. The ZIP-upload and
catalog regression checks scene pixels, animation and the original API path.
This establishes this demo's path, not general shadow/Direct3D compatibility.
The renderer currently reads offscreen targets back at each batch boundary;
GPU-only render-to-texture sampling remains a future optimization.
Load the ZIP to include the assets. F1 opens the upstream settings menu.
''')
manifest_path = ROOT / 'public/examples/manifest.json'
manifest = json.loads(manifest_path.read_text())
entries = [entry for entry in manifest['interactive'] if entry['name'] != NAME]
entries.append({
    'name': NAME,
    'description': 'Humus D3D9 stained-glass room with animated light and six cubemap shadow passes. Close the guest window to exit.',
    'exe': f'{NAME}/TransparentShadowMapping.exe', 'exeSha256': EXE_SHA,
    'zip': f'{NAME}/TransparentShadowMapping.zip', 'zipSha256': ARCHIVE_SHA,
    'provenance': 'Freeware by Emil Persson (Humus); redistribution permitted with readme included. Original archive, executable and shaders.',
})
manifest['interactive'] = sorted(entries, key=lambda entry: entry['name'])
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print('Packaged unchanged TransparentShadowMapping:', EXE_SHA)
