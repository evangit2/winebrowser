"""Build a real PE32 OpenGL demo and package its complete MIT-licensed sources."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NAME = 'opengl-raymarch'
SOURCE = ROOT / 'demos' / NAME
DEST = ROOT / 'public/demos' / NAME
with tempfile.TemporaryDirectory(prefix='winebrowser-opengl-') as temp:
    exe = Path(temp) / (NAME + '.exe')
    subprocess.run(['sh', str(SOURCE / 'build.sh'), str(exe)], check=True)
    headers = subprocess.check_output(['i686-w64-mingw32-objdump', '-f', str(exe)], text=True)
    if 'file format pei-i386' not in headers:
        raise SystemExit('OpenGL demo is not a PE32 i386 executable')
    DEST.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(exe, DEST / exe.name)
for filename in ('main.c', 'scene.vert', 'scene.frag', 'build.sh', 'README.md', 'LICENSE'):
    shutil.copyfile(SOURCE / filename, DEST / filename)
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
exe_hash = digest(DEST / (NAME + '.exe'))
(DEST / 'SHA256SUMS').write_text(exe_hash + '  ' + NAME + '.exe\n')
archive = DEST.parent / (NAME + '.zip')
with zipfile.ZipFile(archive, 'w') as z:
    for p in sorted(DEST.iterdir()):
        if not p.is_file():
            continue
        info = zipfile.ZipInfo(NAME + '/' + p.name, (1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        z.writestr(info, p.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
manifest_path = ROOT / 'public/demos/manifest.json'
manifest = json.loads(manifest_path.read_text())
entries = [x for x in manifest.get('interactive', []) if x['name'] != NAME]
entries.append({
    'name': NAME,
    'description': 'Native OpenGL 3.3 / GLSL 330 3D raymarch demo with soft shadows and ambient occlusion. Arrows orbit; Space pauses; Escape exits.',
    'exe': NAME + '/' + NAME + '.exe',
    'exeSha256': exe_hash,
    'zip': NAME + '.zip',
    'zipSha256': digest(archive),
    'provenance': 'MIT-licensed WineBrowser source-built PE32 fixture. Guest x86 and original GLSL compile in the browser.',
})
manifest['interactive'] = sorted(entries, key=lambda x: x['name'])
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
print('EXE:', exe_hash, 'ZIP:', digest(archive))
