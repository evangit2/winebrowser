#!/usr/bin/env python3
"""Build pinned, unchanged Microsoft HelloTriangle as a normal Windows PE32 target."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
PIN = ROOT / 'runtime/target-builds/microsoft-hello-triangle.json'
pin = json.loads(PIN.read_text())
cache = ROOT / '.cache/dx12-microsoft'
cache.mkdir(parents=True, exist_ok=True)
base = f"https://raw.githubusercontent.com/microsoft/DirectX-Graphics-Samples/{pin['revision']}/"

def digest(data):
    return hashlib.sha256(data).hexdigest()

for name, expected in {**pin['files'], 'LICENSE': pin['licenseSha256']}.items():
    file = cache / name
    if not file.exists() or digest(file.read_bytes()) != expected:
        url = base + ('' if name == 'LICENSE' else pin['directory'] + '/') + name
        data = urllib.request.urlopen(url).read()
        if digest(data) != expected:
            raise RuntimeError('Source hash mismatch: ' + name)
        file.write_bytes(data)
compiler = os.environ.get('CXX', 'i686-w64-mingw32-g++')
version = subprocess.check_output([compiler, '--version'], text=True).splitlines()[0]
output = cache / 'HelloTriangle.exe'
command = [compiler, '-std=c++14', '-O2', '-fpermissive', '-DUNICODE', '-D_UNICODE',
           '-static', '-static-libgcc', '-static-libstdc++', '-include',
           str(ROOT / 'runtime/target-builds/mingw-wrl-compat.h'),
           '-Wl,--no-insert-timestamp', '-mwindows', '-o', str(output)]
command += [str(cache / name) for name in ['Main.cpp', 'DXSample.cpp',
                                        'Win32Application.cpp', 'D3D12HelloTriangle.cpp']]
command += ['-ld3d12', '-ldxgi', '-ld3dcompiler', '-ldxguid']
with (cache / 'build.log').open('w') as log:
    subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
result = {'revision': pin['revision'], 'compiler': version, 'command': command,
          'exeSha256': digest(output.read_bytes()), 'exeBytes': output.stat().st_size,
          'sourcePinSha256': digest(PIN.read_bytes()),
          'compatibilityHeaderSha256': digest((ROOT / 'runtime/target-builds/mingw-wrl-compat.h').read_bytes())}
(cache / 'build.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({'exe': str(output), 'sha256': result['exeSha256'],
                  'note': 'Native target built. This does not establish browser execution.'}, indent=2))
