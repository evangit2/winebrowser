"""Package the independently maintained Khronos scene with reproducible provenance."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'demos/vkcube'
destination = ROOT / 'public/examples/vkcube'
exe = destination / 'vkcube.exe'
manifest = json.loads((source / 'manifest.json').read_text())
for name, digest in manifest['files'].items():
    if hashlib.sha256((source / name).read_bytes()).hexdigest() != digest:
        raise SystemExit('Upstream source changed: ' + name)
data = exe.read_bytes()
pe = int.from_bytes(data[0x3c:0x40], 'little')
if data[pe:pe+4] != b'PE\0\0' or data[pe+4:pe+6] != b'L\x01':
    raise SystemExit('Expected Windows x86 executable')
exe_sha = hashlib.sha256(data).hexdigest()
for path in source.rglob('*'):
    if path.is_file():
        output = destination / path.relative_to(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, output)
provenance = f'''# Khronos Vulkan Cube

Free Apache-2.0 Vulkan tech demo from Khronos, Valve and LunarG.
Upstream revision: `{manifest['revision']}`.
Windows PE32 EXE SHA-256: `{exe_sha}`.

The upstream C scene, original SPIR-V shaders and embedded LunarG texture are
unchanged. This build adds only Windows startup/CRT glue and release build
flags. The executable is built from upstream source, rather than copied from
an official Windows SDK installer. The current upstream Vulkan-Tools project
uses the Vulkan 1.0 API subset for this demo.

Source: <https://github.com/KhronosGroup/Vulkan-Tools/tree/{manifest['revision']}/cube>.
The ZIP retains the complete demo source, build recipe, pin manifest and license.

Upload the EXE directly or the ZIP into WineBrowser, select `vkcube.exe` and
click Run. WineBrowser translates its x86 blocks to WebAssembly and compiles
its SPIR-V to WGSL inside the browser. Space pauses/resumes, arrows change
rotation, and Escape/window close exits. No server compiler is required.

This demonstrates the documented Vulkan subset. It does not establish support
for arbitrary Vulkan programs, x64 executables or modern Vulkan extensions.
'''
(destination / 'PROVENANCE.md').write_text(provenance)
archive = destination / 'vkcube.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
    for path in sorted(destination.rglob('*')):
        if not path.is_file() or path == archive:
            continue
        entry = zipfile.ZipInfo('vkcube/' + path.relative_to(destination).as_posix(), (1980,1,1,0,0,0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        package.writestr(entry, path.read_bytes(), compresslevel=9)
zip_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
catalog_path = ROOT / 'public/examples/manifest.json'
catalog = json.loads(catalog_path.read_text())
catalog['interactive'] = [entry for entry in catalog['interactive'] if entry['name'] != 'vkcube'] + [{
    'name': 'vkcube',
    'description': 'Khronos Vulkan 3D tech demo: original textured rotating cube. Space pauses/resumes, arrows change rotation, Escape exits.',
    'exe': 'vkcube/vkcube.exe', 'exeSha256': exe_sha,
    'zip': 'vkcube/vkcube.zip', 'zipSha256': zip_sha,
    'provenance': 'Apache-2.0, Khronos/Valve/LunarG. Windows x86 build of unchanged upstream scene and SPIR-V shaders; source and build pins included.',
}]
catalog_path.write_text(json.dumps(catalog, indent=2) + '\n')
print(json.dumps({'exeSha256':exe_sha, 'zipSha256':zip_sha, 'zipBytes':archive.stat().st_size},indent=2))
