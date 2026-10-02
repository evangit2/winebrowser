"""Publish the unchanged freeware Humus Water archive, including its readme."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT=Path(__file__).resolve().parents[1]
NAME='humus-water'
SOURCE=ROOT/'.cache/demo-research/Water.zip'
DEST=ROOT/'public/examples'/NAME
ARCHIVE_SHA='b932030521da28ab2c66e01e4d7914101540cd3f9cd9381586f12890f7d9fa70'
EXE_SHA='435463c13f528a9012daa03004441e4187a7668ed0871f941633d8d53b6d4b0d'
if not SOURCE.exists():raise SystemExit('Download https://humus.name/3D/Water.zip to '+str(SOURCE))
if hashlib.sha256(SOURCE.read_bytes()).hexdigest()!=ARCHIVE_SHA:raise SystemExit('Water archive hash mismatch')
with zipfile.ZipFile(SOURCE) as archive:
 exe=archive.read('Water/Water.exe');readme=archive.read('readme.txt')
if hashlib.sha256(exe).hexdigest()!=EXE_SHA:raise SystemExit('Water EXE hash mismatch')
assert b'may be distributed freely' in readme
DEST.mkdir(parents=True,exist_ok=True)
shutil.copyfile(SOURCE,DEST/'Water.zip')
(DEST/'Water.exe').write_bytes(exe);(DEST/'readme.txt').write_bytes(readme)
(DEST/'PROVENANCE.md').write_text(f'''# Humus Water (Direct3D 9)

Emil Persson (Humus) made this freeware demo. The included readme permits
free use and redistribution by any method when that readme is included.
The original archive retains its EXE, shaders, source, font and cubemap assets.

- Author: <https://www.humus.name/index.php?page=3D>
- Original archive: <https://humus.name/3D/Water.zip>
- Archive SHA-256: `{ARCHIVE_SHA}`.
- Original `Water/Water.exe` SHA-256: `{EXE_SHA}`.
- Archive size: {SOURCE.stat().st_size:,} bytes.

Load the ZIP to include all assets. The unchanged Windows EXE decodes its JPEG
cubemap, computes geometry and remainder functions in x86, and supplies its
own water, drop and physics shaders. WineBrowser compiles the machine code
and legacy shaders during browser execution. Two 128x128 RGBA16 UNORM targets
ping-pong the wave simulation, retaining every guest component's 16-bit precision.

F1 opens the original settings menu. Close the guest window to exit.
Verification covers ordinary ZIP upload and catalog/static-host paths,
animated scene pixels excluding the FPS overlay, and exit code zero.
This is one verified application; broader Windows compatibility remains work.
''')
p=ROOT/'public/examples/manifest.json';manifest=json.loads(p.read_text())
manifest['interactive']=[e for e in manifest['interactive'] if e['name']!=NAME]+[dict(
 name=NAME,description='Humus D3D9 water reflection and ripple simulation using two RGBA16 targets. Close the guest window to exit.',
 exe=f'{NAME}/Water.exe',exeSha256=EXE_SHA,zip=f'{NAME}/Water.zip',zipSha256=ARCHIVE_SHA,
 provenance='Freeware by Emil Persson (Humus); redistribution permitted with readme included. Original archive, executable and shaders.')]
manifest['interactive'].sort(key=lambda e:e['name']);p.write_text(json.dumps(manifest,indent=2)+'\n')
print('Packaged unchanged Water',EXE_SHA)
