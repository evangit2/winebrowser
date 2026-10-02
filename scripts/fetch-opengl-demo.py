#!/usr/bin/env python3
"""Fetch a published Windows OpenGL demo unchanged into an ignored local package."""
from pathlib import Path
import hashlib
import io
import json
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.cache/opengl-upstream'
DEST.mkdir(parents=True, exist_ok=True)
EXE_URL = 'https://raw.githubusercontent.com/ShrutiKulkarni03/RTR2020/26f79accdd5758fa280d579502aedee702d45892/01-Windows/02-ProgrammablePipeline/09-3DAnimation/3DAnimation.exe'
GLEW_URL = 'https://github.com/nigels-com/glew/releases/download/glew-2.3.1/glew-2.3.1-win32.zip'
EXE_HASH = '4fadde7d78f056f4b25556f4eb894bcfd12ae6ffdae54980882e30633af84316'
GLEW_HASH = '3792b7bb563d2870ce08491fd3f1147f2fe6a27a43076df475eea7c2b853fd0f'
DLL_HASH = '13feb9004bdfc408dba674e35738f71e27cb5a35ec0d269558e85e911df16f33'
def digest(data):
    return hashlib.sha256(data).hexdigest()
def fetch(url, name, expected):
    path = DEST / name
    if not path.exists() or digest(path.read_bytes()) != expected:
        data = urllib.request.urlopen(url, timeout=60).read()
        if digest(data) != expected:
            raise RuntimeError('Upstream hash mismatch: ' + url)
        path.write_bytes(data)
    return path.read_bytes()
exe = fetch(EXE_URL, '3DAnimation.exe', EXE_HASH)
glew = fetch(GLEW_URL, 'glew-release.zip', GLEW_HASH)
with zipfile.ZipFile(io.BytesIO(glew)) as archive:
    dll = archive.read('glew-2.3.1/bin/Release/Win32/glew32.dll')
    if digest(dll) != DLL_HASH:
        raise RuntimeError('GLEW DLL hash mismatch')
    (DEST / 'glew32.dll').write_bytes(dll)
    license_data = archive.read('glew-2.3.1/LICENSE.txt')
    (DEST / 'GLEW-LICENSE.txt').write_bytes(license_data)
report = {'exeUrl': EXE_URL, 'exeSha256': EXE_HASH, 'glewUrl': GLEW_URL,
          'glewZipSha256': GLEW_HASH, 'dllSha256': DLL_HASH,
          'note': 'Original published PE32 and DLL; no recompilation or patching. Application repository has no declared redistribution license; package stays local.'}
(DEST / 'provenance.json').write_text(json.dumps(report, indent=2) + '\n')
with zipfile.ZipFile(DEST / '3DAnimation.zip', 'w') as archive:
    for name in ('3DAnimation.exe', 'glew32.dll', 'GLEW-LICENSE.txt', 'provenance.json'):
        info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        info.external_attr = 0o100644 << 16
        archive.writestr(info, (DEST / name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
print('Upload:', DEST / '3DAnimation.zip')
