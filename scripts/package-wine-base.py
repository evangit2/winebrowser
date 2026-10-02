#!/usr/bin/env python3
"""Package verified source-built Wine inputs and their corresponding source."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / '.cache/wine-base'
DEST = ROOT / 'public/runtime/wine-base'
REVISION = 'db11d0fe6a169c457e23d007e20404643d067aa8'
SOURCE_HASH = '18aaee150ad540885b9706ae73ccf6febca904049de2792199a9dc18a2772e6a'

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def main():
    manifest = json.loads((CACHE / 'runtime.json').read_text())
    inventory = json.loads((CACHE / 'manifest.json').read_text())
    assert manifest['sourceRevision'] == inventory['sourceRevision'] == REVISION
    assert manifest['sourceSha256'] == inventory['sourceArchive']['sha256'] == SOURCE_HASH
    patch = ROOT / 'runtime/wine/browser-loader.patch'
    assert manifest['patchSha256'] == inventory['patch']['sha256'] == digest(patch)
    pinned_nls = json.loads((ROOT / 'runtime/wine/nls-probe-manifest.json').read_text())
    assert {r['name'] for r in manifest['dlls']} == {'ntdll.dll', 'kernel32.dll', 'kernelbase.dll', 'msvcrt.dll', 'msacm32.dll', 'ucrtbase.dll', 'vcruntime140.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'concrt140.dll'}
    assert {r['name'] for r in manifest['nls']} == set(pinned_nls['files'])
    copies = []
    for kind in ['dlls', 'nls']:
        for row in manifest[kind]:
            p = (CACHE / row['path']).resolve()
            assert p.parent == CACHE.resolve() and row['path'] == row['name']
            assert p.stat().st_size == row['bytes'] and digest(p) == row['sha256']
            if kind == 'nls':
                assert row['sha256'] == pinned_nls['files'][row['name']]['sha256']
            else:
                b = p.read_bytes(); offset = int.from_bytes(b[0x3c:0x40], 'little')
                assert b[:2] == b'MZ' and b[offset:offset+6] == b'PE\0\0\x4c\x01'
            copies.append((p, row['path']))
    archive = ROOT / '.cache/wine-db11d0fe-source.tar.gz'
    assert digest(archive) == SOURCE_HASH
    copies.extend([(archive, 'wine-source.tar.gz'), (patch, 'browser-loader.patch')])
    for name, info in inventory['licenses'].items():
        p = (ROOT / info['path']).resolve()
        assert digest(p) == info['sha256'] and p.stat().st_size == info['bytes']
        copies.append((p, name))
    for name in ['build-wine-loader.py', 'build-wine-base.py', 'package-wine-base.py']:
        copies.append((ROOT / 'scripts' / name, name))
    DEST.mkdir(parents=True, exist_ok=True)
    for p, name in copies:
        shutil.copyfile(p, DEST / name)
    manifest.pop('scope')
    manifest['toolchain'] = inventory['toolchain']
    manifest['build'] = ['--enable-archs=i386', '--disable-tests', 'make -j4 ' + ' '.join(inventory['make'][2:])]
    manifest['scope'] = 'Source-built PE32 base libraries and NLS for automatic missing-import fallback. Win32/NT browser services remain bounded; this is not arbitrary Windows compatibility.'
    manifest['sourceArchive'] = {'path': 'wine-source.tar.gz', 'bytes': archive.stat().st_size, 'sha256': SOURCE_HASH}
    manifest['licenses'] = [name for name in inventory['licenses']]
    text = json.dumps(manifest, indent=2) + '\n'
    text = subprocess.check_output(
        ['node', str(ROOT / 'node_modules/prettier/bin/prettier.cjs'), '--stdin-filepath', 'manifest.json'],
        input=text, text=True, cwd=ROOT,
    )
    (DEST / 'manifest.json').write_text(text)
    metadata = ROOT / 'runtime/wine-base'
    metadata.mkdir(parents=True, exist_ok=True)
    (metadata / 'manifest.json').write_text(text)
    (DEST / 'NOTICE.txt').write_text(
        'Wine 11.0 base libraries, LGPL-2.1-or-later. See LICENSE and COPYING.LIB.\n'
        'Corresponding upstream source: wine-source.tar.gz (revision ' + REVISION + ').\n'
        'Local changes: browser-loader.patch. No installed Wine binaries are used.\n'
        'Rebuild in the WineBrowser repository: npm run build:wine-base, then npm run package:wine-base.\n'
        'The included builders preserve the source, patch, compiler and NLS provenance checks.\n'
        'Source URL: ' + manifest['sourceUrl'] + '\n'
        'Source/build instructions: https://github.com/evangit2/winebrowser/blob/main/docs/wine-loader-bridge.md\n'
    )
    print('Packaged native source DLL/NLS bytes:', sum(r['bytes'] for k in ['dlls','nls'] for r in manifest[k]))

if __name__ == '__main__':
    main()
