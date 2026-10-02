#!/usr/bin/env python3
"""Build and package the pinned Windows x86 glTF skinning demo."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / 'runtime/target-builds/willems-skinning.json'
pin = json.loads(PIN.read_text())
cache = ROOT / '.cache/willems-skinning'
cache.mkdir(parents=True, exist_ok=True)
digest = lambda data: hashlib.sha256(data).hexdigest()

def fetch(url, path, expected):
    if not path.exists() or digest(path.read_bytes()) != expected:
        data = urllib.request.urlopen(url, timeout=120).read()
        if digest(data) != expected:
            raise RuntimeError('Pinned input mismatch: ' + url)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return path.read_bytes()

def extract(archive, destination):
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            parts = Path(member.name).parts
            if len(parts) <= 1:
                continue
            relative = Path(*parts[1:])
            if member.isfile():
                path = destination / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(tar.extractfile(member).read())

archives = {
    'source.tar.gz': (f"https://codeload.github.com/{pin['project']}/tar.gz/{pin['revision']}", pin['sourceArchiveSha256']),
    'glm.tar.gz': (f"https://codeload.github.com/g-truc/glm/tar.gz/{pin['glm']['revision']}", pin['glm']['archiveSha256']),
    'headers.tar.gz': (f"https://codeload.github.com/KhronosGroup/Vulkan-Headers/tar.gz/{pin['headers']['revision']}", pin['headers']['archiveSha256']),
}
for name, (url, sha) in archives.items():
    fetch(url, cache / name, sha)
source = cache / 'source'
extract(cache / 'source.tar.gz', source)
extract(cache / 'glm.tar.gz', source / 'external/glm')
extract(cache / 'headers.tar.gz', cache / 'headers')
# size_t and uint32_t are the same type on PE32; preserve the common function
# once rather than defining a duplicate overload. No scene code is changed.
helper = source / 'base/VulkanTools.cpp'
text = helper.read_text()
overload = '\t\tsize_t alignedSize(size_t value, size_t alignment)\n\t\t{\n\t\t\treturn (value + alignment - 1) & ~(alignment - 1);\n\t\t}'
if text.count(overload) != 1:
    raise RuntimeError('Portability guard no longer matches pinned helper')
helper.write_text(text.replace(overload, '#if SIZE_MAX != UINT32_MAX\n' + overload + '\n#endif'))

# Produce an ordinary Windows import library with Vulkan-only stdcall widths.
registry = ET.parse(cache / 'headers/registry/vk.xml').getroot()
wide = {t.findtext('name') for t in registry.findall('./types/type')
        if t.get('category') == 'handle' and t.findtext('type') == 'VK_DEFINE_NON_DISPATCHABLE_HANDLE'} | {'VkDeviceSize', 'VkDeviceAddress', 'uint64_t', 'int64_t'}
lines = ['LIBRARY vulkan-1.dll', 'EXPORTS']
for command in registry.findall('./commands/command'):
    name = command.findtext('proto/name')
    if not name:
        continue
    params = [p for p in command.findall('param') if not p.get('api') or 'vulkan' in p.get('api').split(',')]
    width = sum(8 if p.findtext('type') in wide and '*' not in ''.join(p.itertext()) else 4 for p in params)
    lines.append(f'{name}@{width}')
definition = cache / 'vulkan.def'
definition.write_text('\n'.join(lines) + '\n')
library = cache / 'libvulkan-1.a'
subprocess.run(['i686-w64-mingw32-dlltool', '-k', '-d', str(definition), '-l', str(library)], check=True)
cxx = os.environ.get('CXX', 'i686-w64-mingw32-g++')
cc = os.environ.get('CC', 'i686-w64-mingw32-gcc')
flags = '-O2 -DNDEBUG -mfpmath=387 -mno-sse -mno-sse2 -fno-tree-vectorize -ffunction-sections -fdata-sections'
build = cache / 'build'
configure = ['cmake', '-S', str(source), '-B', str(build), '-DCMAKE_SYSTEM_NAME=Windows',
             '-DCMAKE_C_COMPILER=' + cc, '-DCMAKE_CXX_COMPILER=' + cxx,
             '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
             '-DUSE_RELATIVE_ASSET_PATH=ON', '-DVulkan_INCLUDE_DIR=' + str(cache / 'headers/include'),
             '-DVulkan_LIBRARY=' + str(library), '-DCMAKE_CXX_FLAGS_RELEASE=' + flags,
             '-DCMAKE_C_FLAGS_RELEASE=-O2 -DNDEBUG -ffunction-sections -fdata-sections',
             '-DCMAKE_EXE_LINKER_FLAGS=-static -static-libgcc -static-libstdc++ -Wl,--no-insert-timestamp -Wl,--gc-sections']
with (cache / 'build.log').open('w') as log:
    subprocess.run(configure, stdout=log, stderr=subprocess.STDOUT, check=True)
    subprocess.run(['cmake', '--build', str(build), '--target', 'gltfskinning', '-j', '6'], stdout=log, stderr=subprocess.STDOUT, check=True)
executable = build / 'bin/gltfskinning.exe'
subprocess.run(['i686-w64-mingw32-strip', '--strip-all', str(executable)], check=True)
# GNU strip rewrites the COFF timestamp even when the linker suppressed it.
# Keep package hashes stable for the same pinned source and compiler.
image = bytearray(executable.read_bytes())
pe_offset = int.from_bytes(image[0x3c:0x40], 'little')
image[pe_offset + 8:pe_offset + 12] = bytes(4)
image[pe_offset + 88:pe_offset + 92] = bytes(4)
executable.write_bytes(image)
if 'pei-i386' not in subprocess.check_output(['i686-w64-mingw32-objdump', '-f', str(executable)], text=True):
    raise RuntimeError('Build did not produce Windows x86')

destination = ROOT / 'public/examples/gltfskinning'
destination.mkdir(parents=True, exist_ok=True)
(destination / 'bin').mkdir(exist_ok=True)
shutil.copyfile(executable, destination / 'bin/gltfskinning.exe')
for name, sha in pin['assets']['files'].items():
    url = f"https://raw.githubusercontent.com/{pin['assets']['project']}/{pin['assets']['revision']}/{name}"
    data = fetch(url, cache / 'assets' / name, sha)
    path = destination / 'assets' / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
data = fetch(pin['modelLicense']['url'], cache / 'model-license.md', pin['modelLicense']['sha256'])
(destination / 'assets/models/CesiumMan/LICENSE.md').write_bytes(data)
for folder in ['gltfskinning', 'base']:
    shutil.copytree(source / 'shaders/glsl' / folder, destination / 'shaders/glsl' / folder, dirs_exist_ok=True)
licenses = {
    'WILLEMS-MIT.txt': source / 'LICENSE.md',
    'IMGUI-MIT.txt': source / 'external/imgui/LICENSE.txt',
    'TINYGLTF-MIT.txt': source / 'external/tinygltf/LICENSE',
    'KTX-LICENSE.txt': source / 'external/ktx/LICENSE.md',
    'KTX-NOTICE.txt': source / 'external/ktx/NOTICE.md',
    'GLM-LICENSE.md': source / 'external/glm/readme.md',
    'GCC-COPYING3.txt': ROOT / 'public/runtime/COPYING3',
    'GCC-RUNTIME-EXCEPTION.txt': ROOT / 'public/runtime/COPYING.RUNTIME',
}
for name, path in licenses.items():
    target = destination / 'licenses' / name
    target.parent.mkdir(exist_ok=True)
    shutil.copyfile(path, target)
for name, notice in pin['notices'].items():
    (destination / 'licenses' / name).write_bytes(fetch(notice['url'], cache / 'notices' / name, notice['sha256']))
provenance = f'''# Sascha Willems glTF skinning demo

Current upstream revision: `{pin['revision']}`. Native Windows x86 build.

{pin['buildNote']}

The character is CesiumMan, copyright 2017 Cesium, licensed CC BY 4.0.
The Cesium logo retains its separate trademark notice in the model license.
Roboto Medium is copyright Google, Apache-2.0. TinyglTF, STB and JSON notices
are retained in the included pinned source; KTX and ImGui notices accompany
the package. The GNU runtime uses GPL-3.0 with the GCC runtime exception.

Upload this ZIP or open the complete extracted folder, select
`bin/gltfskinning.exe`, and Run. The EXE requires its adjacent assets/shaders
tree. P pauses/resumes skeletal animation; left mouse drag rotates the camera,
right drag or wheel zooms, F1 hides/shows the native ImGui overlay, Escape exits.
Wireframe requires an unavailable optional Vulkan feature; keep it unchecked.

WineBrowser compiles the Windows x86 executable and original SPIR-V in the
browser. No pretranslated application Wasm or replacement JavaScript scene is
included. `source.zip` contains hash-pinned source inputs and the build recipe.
'''
(destination / 'PROVENANCE.md').write_text(provenance)
report = {'project': pin['project'], 'revision': pin['revision'], 'compiler': subprocess.check_output([cxx, '--version'], text=True).splitlines()[0], 'flags': flags, 'exeSha256': digest(executable.read_bytes()), 'exeBytes': executable.stat().st_size, 'buildNote': pin['buildNote']}
(destination / 'build.json').write_text(json.dumps(report, indent=2) + '\n')
if (ROOT / 'scripts/audit-program-dependencies.mjs').exists():
    subprocess.run(['node', str(ROOT / 'scripts/audit-program-dependencies.mjs'), str(destination), 'bin/gltfskinning.exe', str(destination / 'dependencies.json')], cwd=ROOT, check=True)
def zip_entries(path, entries):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
source_entries = {'runtime/target-builds/willems-skinning.json': PIN.read_bytes(),
                  'scripts/build-willems-skinning.py': Path(__file__).read_bytes(),
                  'scripts/audit-program-dependencies.mjs': (ROOT / 'scripts/audit-program-dependencies.mjs').read_bytes()}
source_entries.update({'.cache/willems-skinning/' + name: (cache / name).read_bytes() for name in archives})
source_entries.update({'public/runtime/' + name: (ROOT / 'public/runtime' / name).read_bytes() for name in ['COPYING3', 'COPYING.RUNTIME']})
zip_entries(destination / 'source.zip', source_entries)
archive = destination / 'gltfskinning.zip'
zip_entries(archive, {'gltfskinning/' + p.relative_to(destination).as_posix(): p.read_bytes() for p in destination.rglob('*') if p.is_file() and p.name not in ['gltfskinning.zip', 'source.zip']})
catalog_path = ROOT / 'public/examples/manifest.json'
catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else {'format': 1, 'interactive': []}
entry = {'name': 'gltfskinning', 'description': 'Sascha Willems / CesiumMan: textured skeletal animation, joint storage buffers, node transforms and native ImGui. P pauses, drag rotates, wheel zooms, F1 toggles overlay.',
         'exe': 'gltfskinning/bin/gltfskinning.exe', 'exeSha256': report['exeSha256'],
         'zip': 'gltfskinning/gltfskinning.zip', 'zipSha256': digest(archive.read_bytes()),
         'sourceZip': 'gltfskinning/source.zip', 'sourceZipSha256': digest((destination / 'source.zip').read_bytes()),
         'provenance': pin['buildNote']}
catalog['interactive'] = [old for old in catalog['interactive'] if old['name'] != entry['name']] + [entry]
catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
print(json.dumps(entry, indent=2))
