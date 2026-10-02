#!/usr/bin/env python3
"""Build/package Microsoft's unchanged D3D12Bundles city as native PE32."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PIN = ROOT / 'runtime/target-builds/microsoft-dx12-city.json'
pin = json.loads(PIN.read_text())
cache = ROOT / '.cache/microsoft-dx12-city'
cache.mkdir(parents=True, exist_ok=True)
destination = ROOT / 'public/examples/microsoft-dx12-city'
destination.mkdir(parents=True, exist_ok=True)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def fetch(url, path, expected):
    if not path.exists() or digest(path.read_bytes()) != expected:
        data = urllib.request.urlopen(url, timeout=60).read()
        if digest(data) != expected:
            raise RuntimeError('Upstream hash mismatch: ' + url)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

base = f"https://raw.githubusercontent.com/microsoft/DirectX-Graphics-Samples/{pin['revision']}/"
for name, expected in pin['files'].items():
    fetch(base + pin['directory'] + '/' + name, cache / name, expected)
fetch(base + 'LICENSE', cache / 'LICENSE', pin['licenseSha256'])
math = pin['directXMath']
for name, expected in math['files'].items():
    fetch(f"https://raw.githubusercontent.com/microsoft/DirectXMath/{math['revision']}/{name}",
          cache / 'DirectXMath' / name, expected)

headers = cache / 'header-compat'
headers.mkdir(exist_ok=True)
(headers / 'D3Dcompiler.h').write_text('#pragma once\n#include <d3dcompiler.h>\n')
(headers / 'pix.h').write_text(
    '#pragma once\n// Windows SDK PIX events are disabled when USE_PIX is absent.\n'
    '#define PIXBeginEvent(...) ((void)0)\n#define PIXEndEvent(...) ((void)0)\n'
    '#define PIXSetMarker(...) ((void)0)\n')
(cache / 'compat.h').write_text(
    (ROOT / 'runtime/target-builds/mingw-wrl-compat.h').read_text() + '\n' +
    (ROOT / 'runtime/target-builds/dx12-city-compat.h').read_text())
compiler = os.environ.get('CXX', 'i686-w64-mingw32-g++')
version = subprocess.check_output([compiler, '--version'], text=True).splitlines()[0]
command = [compiler, '-std=c++17', '-O1', '-fpermissive', '-DUNICODE', '-D_UNICODE',
           '-DNDEBUG', '-D_XM_NO_INTRINSICS_', '-static', '-static-libgcc', '-static-libstdc++',
           '-include', str(cache / 'compat.h'), '-I' + str(headers),
           '-I' + str(cache / 'DirectXMath/Inc'), '-Wl,--no-insert-timestamp',
           '-mwindows', '-o', str(cache / 'D3D12Bundles.exe')]
command += [str(cache / name) for name in sorted(pin['files']) if name.endswith('.cpp')]
command += ['-ld3d12', '-ldxgi', '-ld3dcompiler', '-ldxguid', '-lshell32']
with (cache / 'build.log').open('w') as log:
    subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
subprocess.run(['node', 'scripts/compile-city-shaders.mjs', str(cache)], cwd=ROOT, check=True)
for name, expected in pin['shaders'].items():
    if digest((cache / name).read_bytes()) != expected:
        raise RuntimeError('Shader output differs from the pinned browser compiler: ' + name)

report = {'upstreamRevision': pin['revision'], 'compiler': version,
          'exeSha256': digest((cache / 'D3D12Bundles.exe').read_bytes()),
          'exeBytes': (cache / 'D3D12Bundles.exe').stat().st_size,
          'sourcePinSha256': digest(PIN.read_bytes()), 'buildNote': pin['buildNote'],
          'command': [part.replace(str(cache), '.') for part in command]}
(cache / 'build.json').write_text(json.dumps(report, indent=2) + '\n')

def write_zip(path, entries):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name.endswith('build.sh') else 0o100644) << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

# Rebuild native C++ outside this repository; the source archive also carries
# the original HLSL and the exact generated DXBC used by the ordinary upload.
build = '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\n'
build += '"${CXX:-i686-w64-mingw32-g++}" ' + ' '.join(
    "'" + part.replace(str(cache), '.').replace("'", "'\\''") + "'"
    for part in command[1:]) + '\n'
(cache / 'build.sh').write_text(build)
source = {name: (cache / name).read_bytes() for name in pin['files']}
source.update({'DirectXMath/' + name: (cache / 'DirectXMath' / name).read_bytes()
               for name in math['files']})
for name in ['LICENSE', 'compat.h', 'build.sh', 'build.json', *pin['shaders']]:
    source[name] = (cache / name).read_bytes()
for name in ['D3Dcompiler.h', 'pix.h']:
    source['header-compat/' + name] = (headers / name).read_bytes()
source['source-pin.json'] = PIN.read_bytes()
source['compile-city-shaders.mjs'] = (ROOT / 'scripts/compile-city-shaders.mjs').read_bytes()
write_zip(cache / 'source.zip', source)
for name in ['D3D12Bundles.exe', 'occcity.bin', 'LICENSE', 'build.json', 'source.zip', *pin['shaders']]:
    shutil.copyfile(cache / name, destination / name)
shutil.copyfile(cache / 'DirectXMath/LICENSE', destination / 'DirectXMath-LICENSE')
write_zip(destination / 'D3D12City-x86.zip', {name: (destination / name).read_bytes()
          for name in ['D3D12Bundles.exe', 'occcity.bin', 'LICENSE', 'DirectXMath-LICENSE',
                       'build.json', 'source.zip', *pin['shaders']]})
print(json.dumps(report, indent=2))
