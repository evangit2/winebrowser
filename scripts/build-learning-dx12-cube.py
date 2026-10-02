#!/usr/bin/env python3
"""Build a PE32 counterpart of the MIT LearningDirectX12 rotating cube."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PIN = ROOT / 'runtime/target-builds/learning-dx12-cube.json'
pin = json.loads(PIN.read_text())
cache = ROOT / '.cache/learning-dx12-cube'
cache.mkdir(parents=True, exist_ok=True)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def fetch(url, path, expected):
    if not path.exists() or digest(path.read_bytes()) != expected:
        data = urllib.request.urlopen(url, timeout=60).read()
        if digest(data) != expected:
            raise RuntimeError('Upstream input hash mismatch: ' + url)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return path.read_bytes()

base = f"https://raw.githubusercontent.com/jpvanoosten/LearningDirectX12/{pin['revision']}/"
for name, expected in {**pin['files'], 'LICENSE': pin['licenseSha256']}.items():
    fetch(base + name, cache / name, expected)
math = pin['directXMath']
base = f"https://raw.githubusercontent.com/microsoft/DirectXMath/{math['revision']}/"
for name, expected in math['files'].items():
    fetch(base + name, cache / 'DirectXMath' / name, expected)
release = pin['release']
fetch(release['url'], cache / 'upstream-release.zip', release['sha256'])
with zipfile.ZipFile(cache / 'upstream-release.zip') as archive:
    for name, expected in release['shaders'].items():
        data = archive.read(name)
        if digest(data) != expected:
            raise RuntimeError('Release shader hash mismatch: ' + name)
        (cache / name).write_bytes(data)

# Preserve the application files; provide only native-toolchain header aliases.
(cache / 'DX12Lib/src/..\\resource.h').write_bytes((cache / 'DX12Lib/resource.h').read_bytes())
(cache / 'compat.h').write_text(
    (ROOT / 'runtime/target-builds/mingw-wrl-compat.h').read_text() +
    '\n#include <cstdio>\n#include <cmath>\n')
headers = cache / 'header-compat'
headers.mkdir(exist_ok=True)
for name in ['Windows.h', 'Shlwapi.h']:
    (headers / name).write_text('#pragma once\n#include_next <' + name.lower() + '>\n')
compiler = os.environ.get('CXX', 'i686-w64-mingw32-g++')
version = subprocess.check_output([compiler, '--version'], text=True).splitlines()[0]
output = cache / 'Tutorial2.exe'
command = [compiler, '-std=c++17', '-O1', '-fpermissive', '-DUNICODE', '-D_UNICODE',
           '-DNDEBUG', '-D_XM_NO_INTRINSICS_', '-static', '-static-libgcc', '-static-libstdc++',
           '-include', str(cache / 'compat.h'), '-include', str(cache / 'DX12Lib/inc/DX12LibPCH.h'),
           '-I' + str(headers), '-I' + str(cache / 'DirectXMath/Inc'), '-I' + str(cache / 'DX12Lib/inc'),
           '-I' + str(cache / 'Tutorial2/inc'), '-Wl,--no-insert-timestamp', '-municode',
           '-mwindows', '-o', str(output)]
command += [str(cache / name) for name in sorted(pin['files']) if name.endswith('.cpp')]
command += ['-ld3d12', '-ldxgi', '-ld3dcompiler', '-ldxguid', '-lshlwapi']
with (cache / 'build.log').open('w') as log:
    subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
if 'file format pei-i386' not in subprocess.check_output(
        [os.environ.get('OBJDUMP', 'i686-w64-mingw32-objdump'), '-f', str(output)], text=True):
    raise RuntimeError('Output must be a 32-bit Windows executable')
report = {'upstreamRevision': pin['revision'], 'compiler': version,
          'exeSha256': digest(output.read_bytes()), 'exeBytes': output.stat().st_size,
          'sourcePinSha256': digest(PIN.read_bytes()), 'buildNote': pin['buildNote'],
          'command': [part.replace(str(cache), '.') for part in command]}
(cache / 'build.json').write_text(json.dumps(report, indent=2) + '\n')
# The corresponding source archive contains the unchanged pinned inputs and an
# ordinary native build script. No application Wasm is shipped.
build = '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\n'
build += "cp DX12Lib/resource.h 'DX12Lib/src/..\\resource.h'\n"
build += '"${CXX:-i686-w64-mingw32-g++}" ' + ' '.join(
    "'" + part.replace(str(cache), '.').replace("'", "'\\''") + "'" for part in command[1:]) + '\n'
(cache / 'build.sh').write_text(build)
def write_zip(destination, entries):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if name.endswith('build.sh') else 0o100644) << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
source_files = {name: (cache / name).read_bytes() for name in pin['files']}
source_files.update({'DirectXMath/' + name: (cache / 'DirectXMath' / name).read_bytes()
                     for name in math['files']})
for name in ['LICENSE', 'compat.h', 'build.sh', 'build.json', *release['shaders']]:
    source_files[name] = (cache / name).read_bytes()
for name in ['Windows.h', 'Shlwapi.h']:
    source_files['header-compat/' + name] = (headers / name).read_bytes()
source_files['source-pin.json'] = PIN.read_bytes()
write_zip(cache / 'source.zip', source_files)
destination = ROOT / 'public/examples/learning-dx12-cube'
destination.mkdir(parents=True, exist_ok=True)
for name in ['Tutorial2.exe', 'VertexShader.cso', 'PixelShader.cso', 'LICENSE', 'build.json', 'source.zip']:
    shutil.copyfile(cache / name, destination / name)
shutil.copyfile(cache / 'DirectXMath/LICENSE', destination / 'DirectXMath-LICENSE')
write_zip(destination / 'Tutorial2-x86.zip', {name: (destination / name).read_bytes()
          for name in ['Tutorial2.exe', 'VertexShader.cso', 'PixelShader.cso', 'LICENSE',
                       'DirectXMath-LICENSE', 'build.json', 'source.zip']})
print(json.dumps(report, indent=2))
