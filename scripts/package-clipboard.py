"""Package the MIT native clipboard editor with its deterministic source build."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile
ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'tests/fixtures/clipboard'
PUBLIC = ROOT / 'public/examples'
DEST = PUBLIC / 'clipboard-editor'
def sha(data):
    return hashlib.sha256(data).hexdigest()
def archive(path, entries):
    with zipfile.ZipFile(path, 'w') as output:
        for name, data in sorted(entries):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
DEST.mkdir(parents=True, exist_ok=True)
for name in ['clipboard.exe', 'README.md']:
    shutil.copyfile(SOURCE / name, DEST / name)
shutil.copyfile(ROOT / 'LICENSE', DEST / 'LICENSE')
provenance = {'name': 'clipboard-editor', 'license': 'MIT', 'source': 'Original Windows SDK client',
              'exeSha256': sha((SOURCE / 'clipboard.exe').read_bytes()),
              'sourceSha256': sha((SOURCE / 'client.c').read_bytes()),
              'reference': json.loads((SOURCE / 'wine-reference.json').read_text())}
(DEST / 'PROVENANCE.json').write_text(json.dumps(provenance, indent=2)+'\n')
archive(DEST / 'clipboard-editor.zip', [('clipboard-editor/'+p.name, p.read_bytes()) for p in
        [DEST / name for name in ['clipboard.exe', 'README.md', 'LICENSE', 'PROVENANCE.json']]])
names = ['LICENSE', 'scripts/build-clipboard-fixture.sh', 'tests/fixtures/clipboard/client.c',
         'tests/fixtures/clipboard/oracle.c', 'tests/fixtures/clipboard/wine-reference.json',
         'tests/fixtures/clipboard/README.md']
archive(DEST / 'source.zip', [(name, (ROOT / name).read_bytes()) for name in names])
entry = {'name': 'clipboard-editor', 'description': 'Native ANSI and Unicode text editors with Copy, Paste, Cut and Undo. Select text and use the buttons or Ctrl+C / Ctrl+V / Ctrl+X.',
         'entry': 'clipboard.exe', 'args': [], 'exe': 'clipboard-editor/clipboard.exe',
         'exeSha256': provenance['exeSha256'], 'zip': 'clipboard-editor/clipboard-editor.zip',
         'zipSha256': sha((DEST / 'clipboard-editor.zip').read_bytes()),
         'sourceZip': 'clipboard-editor/source.zip', 'sourceZipSha256': sha((DEST / 'source.zip').read_bytes()),
         'provenance': 'Original MIT Windows SDK client; complete deterministic source build and independent native clipboard reference included.'}
manifest = PUBLIC / 'manifest.json'
value = json.loads(manifest.read_text())
value['interactive'] = [e for e in value['interactive'] if e['name'] != entry['name']] + [entry]
manifest.write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n')
print(entry['exeSha256'])
