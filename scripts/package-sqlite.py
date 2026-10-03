"""Publish an unchanged upstream PE32 SQLite DLL and an authored native client."""
from pathlib import Path
import hashlib
import io
import json
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache/sqlite-3500400'
DEST = ROOT / 'public/examples/sqlite'
UPSTREAM = {
    'sqlite-dll-win-x86-3500400.zip': 'c40a52de84bed8ca3b83eac80132c826bedfd702d19b156d2febdf046b3a049b',
    'sqlite-amalgamation-3500400.zip': '1d3049dd0f830a025a53105fc79fd2ab9431aea99e137809d064d8ee8356b032',
}
DLL_SHA = '24e612fd5b239aa6385d2c159b70155968b3f9ccdbf19ba7fd83a83b9255238a'
SOURCE_ID = '2025-07-30 19:33:53 4d8adfb30e03f9cf27f800a2c1ba3c48fb4ca1b08b0f5ed59a4d5ecbf45e20a3'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def write_json(path, value):
    text = subprocess.check_output(['node', str(ROOT/'node_modules/prettier/bin/prettier.cjs'),
        '--stdin-filepath', str(path)], input=json.dumps(value, indent=2)+'\n', text=True, cwd=ROOT)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)

def archive(path, entries):
    with zipfile.ZipFile(path, 'w') as output:
        for name, data in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (1980,1,1,0,0,0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    for name, expected in UPSTREAM.items():
        path = CACHE / name
        if not path.exists():
            with urllib.request.urlopen('https://www.sqlite.org/2025/'+name, timeout=60) as response:
                path.write_bytes(response.read())
        if sha(path.read_bytes()) != expected:
            raise SystemExit('SQLite upstream archive hash mismatch: '+name)
    with zipfile.ZipFile(CACHE/'sqlite-dll-win-x86-3500400.zip') as source:
        dll = source.read('sqlite3.dll')
        definition = source.read('sqlite3.def')
    if sha(dll) != DLL_SHA:
        raise SystemExit('SQLite DLL hash mismatch')
    with zipfile.ZipFile(CACHE/'sqlite-amalgamation-3500400.zip') as source:
        amalgamation = source.read('sqlite-amalgamation-3500400/sqlite3.c')
        header = source.read('sqlite-amalgamation-3500400/sqlite3.h')
    assert SOURCE_ID.encode() in amalgamation
    # Retain the upstream public-domain dedication verbatim from its header.
    first_comment = header.split(b'*/',1)[0]+b'*/\n'
    assert b'disclaims copyright' in first_comment
    exe = (ROOT/'tests/fixtures/sqlite/sqlite-client.exe').read_bytes()
    DEST.mkdir(parents=True, exist_ok=True)
    (DEST/'sqlite3.dll').write_bytes(dll)
    (DEST/'sqlite-client.exe').write_bytes(exe)
    (DEST/'SQLite-LICENSE.txt').write_bytes(first_comment)
    provenance = f'''# SQLite native Windows DLL

This is SQLite 3.50.4's unchanged upstream x86 Windows DLL, used by an authored
MIT native Windows client. SQLite is public domain; its original dedication is
included in SQLite-LICENSE.txt. See <https://www.sqlite.org/copyright.html>.

- Original DLL archive: <https://www.sqlite.org/2025/sqlite-dll-win-x86-3500400.zip>
- Archive SHA-256: `{UPSTREAM['sqlite-dll-win-x86-3500400.zip']}`.
- DLL SHA-256: `{DLL_SHA}`.
- Source identity: `{SOURCE_ID}`.
- Original amalgamation SHA-256: `{UPSTREAM['sqlite-amalgamation-3500400.zip']}`.
- Client executable SHA-256: `{sha(exe)}`.

Upload sqlite.zip, or select the client EXE and sqlite3.dll together. The client
loads SQLite through LoadLibrary/GetProcAddress and checks memory SQL, rollback,
Unicode text and blobs, disk transactions, writer contention, database reopen
and integrity_check. The database is available through the download link.
WineBrowser fetches its source-built native Wine base automatically; both the
client and original DLL compile from x86 to Wasm during browser execution.

source.zip contains the authored client and build recipe, upstream DLL export
definition and unchanged SQLite amalgamation. The official DLL was downloaded
unchanged, not rebuilt or patched. The client rebuild needs MinGW-w64 and no
SQLite SDK or runtime redistributable.

Validation covers these synchronous rollback-journal workloads. WAL mode,
background I/O, cross-process access and crash durability remain unverified.
Waiting byte locks and completion events are verified separately by the native
threaded file-lock fixture. APC completion routines remain unsupported.
Browser storage receives generated outputs after the process finishes.
'''
    (DEST/'PROVENANCE.md').write_text(provenance)
    archive(DEST/'source.zip', {
        'tests/fixtures/sqlite/sqlite-client.c': (ROOT/'tests/fixtures/sqlite/sqlite-client.c').read_bytes(),
        'tests/fixtures/sqlite/README.md': (ROOT/'tests/fixtures/sqlite/README.md').read_bytes(),
        'scripts/build-sqlite-fixture.sh': (ROOT/'scripts/build-sqlite-fixture.sh').read_bytes(),
        'sqlite3.def': definition, 'sqlite3.c':amalgamation, 'sqlite3.h':header,
        'SQLite-LICENSE.txt':first_comment,
    })
    shutil.copyfile(CACHE/'sqlite-dll-win-x86-3500400.zip',DEST/'upstream-dll.zip')
    archive(DEST/'sqlite.zip', {'app/'+name: (DEST/name).read_bytes()
        for name in ['sqlite-client.exe','sqlite3.dll','SQLite-LICENSE.txt','PROVENANCE.md']})
    pin = {
        'version':'3.50.4','sourceId':SOURCE_ID,'upstream':[
            {'url':'https://www.sqlite.org/2025/'+name,'sha256':expected,
             'bytes':(CACHE/name).stat().st_size} for name,expected in UPSTREAM.items()],
        'dll':{'path':'sqlite/sqlite3.dll','sha256':DLL_SHA,'bytes':len(dll)},
        'client':{'path':'sqlite/sqlite-client.exe','sha256':sha(exe),'bytes':len(exe),
            'source':'tests/fixtures/sqlite/sqlite-client.c',
            'sourceSha256':sha((ROOT/'tests/fixtures/sqlite/sqlite-client.c').read_bytes())},
        'zip':{'path':'sqlite/sqlite.zip','sha256':sha((DEST/'sqlite.zip').read_bytes())},
        'sourceZip':{'path':'sqlite/source.zip','sha256':sha((DEST/'source.zip').read_bytes())},
        'license':'SQLite public domain; authored client MIT',
    }
    write_json(ROOT/'runtime/target-builds/sqlite.json',pin)
    path = ROOT/'public/examples/manifest.json'
    catalog = json.loads(path.read_text())
    catalog['interactive'] = [entry for entry in catalog['interactive'] if entry['name']!='sqlite']
    catalog['interactive'].append({
        'name':'sqlite',
        'description':'SQLite 3.50.4 unchanged Windows DLL: memory SQL, Unicode text/blobs, transactional disk database, writer contention and integrity check. Download the resulting database after it exits.',
        'exe':pin['client']['path'],'exeSha256':pin['client']['sha256'],
        'zip':pin['zip']['path'],'zipSha256':pin['zip']['sha256'],
        'sourceZip':pin['sourceZip']['path'],'sourceZipSha256':pin['sourceZip']['sha256'],
        'provenance':'SQLite public-domain upstream PE32 DLL, unchanged. MIT authored native client; original amalgamation, original binary archive, hashes and licenses included.',
    })
    write_json(path,catalog)
    print('Packaged unchanged SQLite Windows DLL',DLL_SHA)

if __name__ == '__main__':
    main()
