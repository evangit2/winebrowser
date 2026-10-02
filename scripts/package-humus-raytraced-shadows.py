"""Publish the untouched freeware Humus OpenGL Raytraced Shadows package."""
from pathlib import Path
import hashlib
import json
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'humus-raytraced-shadows'
URL = 'https://humus.name/3D/RaytracedShadows.zip'
ARCHIVE_SHA = '126b68f89cddb8cefa41f3fe3ba74b64bbbf5a2ef2c402bbe659042295773b08'
SOURCE = ROOT / '.cache/opengl-research/RaytracedShadows.zip'
if not SOURCE.exists():
    SOURCE.parent.mkdir(parents=True, exist_ok=True)
    SOURCE.write_bytes(urllib.request.urlopen(URL, timeout=60).read())
digest = lambda data: hashlib.sha256(data).hexdigest()
data = SOURCE.read_bytes()
if digest(data) != ARCHIVE_SHA:
    raise SystemExit('Upstream archive hash mismatch')
with zipfile.ZipFile(SOURCE) as archive:
    exe = archive.read('RaytracedShadows/RaytracedShadows.exe')
    readme = archive.read('readme.txt')
    entries = [{'path': name, 'bytes': len(archive.read(name)), 'sha256': digest(archive.read(name))}
               for name in archive.namelist() if not name.endswith('/')]
if b'may be distributed freely' not in readme:
    raise SystemExit('Redistribution terms missing')
DEST = ROOT / 'public/examples' / NAME
DEST.mkdir(parents=True, exist_ok=True)
(DEST / 'RaytracedShadows.zip').write_bytes(data)
(DEST / 'RaytracedShadows.exe').write_bytes(exe)
(DEST / 'readme.txt').write_bytes(readme)
(DEST / 'provenance.json').write_text(json.dumps({'url': URL, 'archiveSha256': ARCHIVE_SHA,
    'exeSha256': digest(exe), 'exeEntry': 'RaytracedShadows/RaytracedShadows.exe',
    'files': entries, 'note': 'Unchanged original archive, EXE, shaders and assets; freeware terms retained.'}, indent=2)+'\n')
(DEST / 'PROVENANCE.md').write_text('''# Humus Raytraced Shadows (OpenGL)

Original freeware tech demo by Emil Persson (Humus), republished unchanged under
its included readme.txt. The upstream archive, executable, shader calculations,
DDS/PNG textures and font assets retain their original bytes.

This is a substantial older desktop OpenGL/GLSL compatibility demo: seven
bouncing spheres, a moving light, a textured and bump-mapped room, three lighting/
shadow passes and a settings UI. WineBrowser compiles its original x86 and shader
code in the browser. No scene-specific shader or image is substituted.

Upload RaytracedShadows.zip or choose humus-raytraced-shadows in the catalog.
W/S or up/down move the camera; F1 opens settings. Close the window to exit.
The original executable depends on Windows system DLLs; it statically includes
its CRT, image decoder and graphics framework. The ZIP needs all relative assets.
WineBrowser supplies the imported system services and the exercised OpenGL APIs.
This does not imply complete support for every export of every Windows DLL.

Upstream: <https://humus.name/3D/RaytracedShadows.zip>
''')
p = ROOT / 'public/examples/manifest.json'
manifest = json.loads(p.read_text())
manifest['interactive'] = [entry for entry in manifest['interactive'] if entry['name'] != NAME]
manifest['interactive'].append({'name': NAME,
    'description': 'Unchanged freeware Humus OpenGL tech demo: bump-mapped room, seven bouncing spheres, moving light and raytraced soft shadows. W/S or arrows move; F1 opens settings.',
    'exe': NAME+'/RaytracedShadows.exe', 'exeSha256': digest(exe),
    'zip': NAME+'/RaytracedShadows.zip', 'zipSha256': ARCHIVE_SHA,
    'provenance': 'Emil Persson (Humus). Original freeware archive, retained readme permits redistribution; no binary or shader patching.'})
manifest['interactive'].sort(key=lambda entry: entry['name'])
p.write_text(json.dumps(manifest, indent=2)+'\n')
print('Published original Raytraced Shadows:', digest(exe), ARCHIVE_SHA)
