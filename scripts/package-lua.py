"""Publish the unchanged MIT LuaBinaries Windows DLL and a native script client."""
from pathlib import Path
import hashlib, html, io, json, re, shutil, subprocess, tarfile, urllib.request, zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache/lua-research'
DEST = ROOT / 'public/examples/lua'
DLL_URL = 'https://downloads.sourceforge.net/project/luabinaries/5.4.2/Windows%20Libraries/Dynamic/lua-5.4.2_Win32_dllw6_lib.zip'
DLL_ARCHIVE_SHA = 'cff34d8074fca1ad54bb7cd7e34d8f01b0d685ef95377d372e22c81fa530fa3f'
DLL_SHA = 'cfc3f1d4a6e8922d16d71a4c12c1b731bc9e7edab82d5282f15c3aaa86a388e3'
SOURCE_URL = 'https://www.lua.org/ftp/lua-5.4.2.tar.gz'
SOURCE_SHA = '11570d97e9d7303c0a59567ed1ac7c648340cd0db10d5fd594c09223ef2f524f'
sha = lambda data: hashlib.sha256(data).hexdigest()

def fetch(url, expected):
    path = CACHE / url.rsplit('/',1)[1]
    if not path.exists():
        with urllib.request.urlopen(url,timeout=30) as response: path.write_bytes(response.read())
    data = path.read_bytes()
    if sha(data) != expected: raise SystemExit('Upstream hash mismatch: '+url)
    return data

def archive(path, entries):
    with zipfile.ZipFile(path,'w') as out:
        for name,data in sorted(entries.items()):
            info=zipfile.ZipInfo(name,(1980,1,1,0,0,0));info.create_system=3;info.external_attr=0o100644<<16
            out.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)

def write_json(path, value):
    text=subprocess.check_output(['node','node_modules/prettier/bin/prettier.cjs','--stdin-filepath',str(path)],input=json.dumps(value,indent=2,ensure_ascii=False)+'\n',text=True,cwd=ROOT)
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)

def main():
    CACHE.mkdir(parents=True,exist_ok=True);DEST.mkdir(parents=True,exist_ok=True)
    original=fetch(DLL_URL,DLL_ARCHIVE_SHA);source=fetch(SOURCE_URL,SOURCE_SHA)
    with zipfile.ZipFile(io.BytesIO(original)) as z: dll=z.read('lua54.dll')
    assert sha(dll)==DLL_SHA
    with tarfile.open(fileobj=io.BytesIO(source)) as t: readme=t.extractfile('lua-5.4.2/doc/readme.html').read().decode()
    license=readme[readme.index('Copyright &copy;'):readme.index('</BLOCKQUOTE>',readme.index('Copyright &copy;'))]
    license=html.unescape(re.sub('<[^>]+>','',license)).strip()+'\n'
    assert 'Permission is hereby granted' in license and '1994–2020 Lua.org, PUC-Rio.' in license
    client=(ROOT/'tests/fixtures/lua/lua-client.exe').read_bytes()
    script=(ROOT/'tests/fixtures/lua/main.lua').read_bytes()
    provenance=f'''# Lua 5.4.2 native Windows DLL

The unchanged LuaBinaries Windows x86 DLL executes the supplied main.lua script
through an MIT-authored native Windows client. Both the upstream DLL and Lua
source use the MIT license retained in Lua-LICENSE.txt.

- Original Windows DLL archive: <{DLL_URL}>
- Archive SHA-256: `{DLL_ARCHIVE_SHA}`.
- Original DLL SHA-256: `{DLL_SHA}`.
- Original Lua 5.4.2 source: <{SOURCE_URL}>
- Source SHA-256: `{SOURCE_SHA}`.
- Authored client SHA-256: `{sha(client)}`.

Upload lua.zip or select lua-client.exe, lua54.dll and main.lua together. Modify
main.lua to run another script with the same original library. WineBrowser loads
its native Wine base before startup and translates the original EXE/DLL x86 code
to Wasm inside the browser. Lua itself parses and executes the script as it would
on Windows; the script is not replaced by browser JavaScript.

The example checks 64-bit integers, floating-point math, a guest C callback, Unicode, table sorting,
coroutines, caught errors, garbage collection, packed binary data and file
write/read round trips. Download lua-output.bin after clean process exit. The
browser test independently decodes its 64-bit values and float.

source.zip contains the complete original Lua source archive, original DLL
archive, license, authored client and script, and client build recipe. The
upstream DLL is unmodified; rebuilding the client requires only MinGW-w64.
This is a bounded scripting workload, not proof of every Lua module, networking,
external processes or arbitrary Windows application compatibility.
'''
    entries={'lua-client.exe':client,'lua54.dll':dll,'main.lua':script,'Lua-LICENSE.txt':license.encode(),'PROVENANCE.md':provenance.encode(),'Client-LICENSE.txt':(ROOT/'LICENSE').read_bytes()}
    for name,data in entries.items(): (DEST/name).write_bytes(data)
    archive(DEST/'lua.zip',{'app/'+name:data for name,data in entries.items()})
    archive(DEST/'source.zip',{
        'lua-5.4.2.tar.gz':source,'upstream-dll.zip':original,'Lua-LICENSE.txt':license.encode(),
        'tests/fixtures/lua/lua-client.c':(ROOT/'tests/fixtures/lua/lua-client.c').read_bytes(),
        'tests/fixtures/lua/main.lua':script,'tests/fixtures/lua/README.md':(ROOT/'tests/fixtures/lua/README.md').read_bytes(),
        'scripts/build-lua-fixture.sh':(ROOT/'scripts/build-lua-fixture.sh').read_bytes(),'Client-LICENSE.txt':(ROOT/'LICENSE').read_bytes(),
    })
    (DEST/'upstream-dll.zip').write_bytes(original)
    pin={'version':'5.4.2','upstream':[{'url':DLL_URL,'sha256':DLL_ARCHIVE_SHA,'bytes':len(original)},{'url':SOURCE_URL,'sha256':SOURCE_SHA,'bytes':len(source)}],
         'dll':{'path':'lua/lua54.dll','sha256':DLL_SHA,'bytes':len(dll)},
         'client':{'path':'lua/lua-client.exe','sha256':sha(client),'source':'tests/fixtures/lua/lua-client.c'},
         'script':{'path':'lua/main.lua','sha256':sha(script)},
         'zip':{'path':'lua/lua.zip','sha256':sha((DEST/'lua.zip').read_bytes())},
         'sourceZip':{'path':'lua/source.zip','sha256':sha((DEST/'source.zip').read_bytes())},'license':'MIT'}
    write_json(ROOT/'runtime/target-builds/lua.json',pin)
    path=ROOT/'public/examples/manifest.json';catalog=json.loads(path.read_text())
    catalog['interactive']=[e for e in catalog['interactive'] if e['name']!='lua']
    catalog['interactive'].append({'name':'lua','description':'Lua 5.4.2 unchanged Windows DLL: scripts, 64-bit arithmetic, Unicode, coroutines, caught errors and binary file I/O. Replace main.lua to run your own script; download lua-output.bin after exit.',
        'exe':pin['client']['path'],'exeSha256':pin['client']['sha256'],'zip':pin['zip']['path'],'zipSha256':pin['zip']['sha256'],
        'sourceZip':pin['sourceZip']['path'],'sourceZipSha256':pin['sourceZip']['sha256'],'provenance':'Original upstream MIT Windows Lua DLL, unchanged; full original source, binary archive, license and MIT authored script/client included.'})
    write_json(path,catalog);print('Packaged unchanged Lua Windows DLL',DLL_SHA)

if __name__=='__main__': main()
