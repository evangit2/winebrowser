"""Bundle pinned LGPL Wine toolbar bitmap sources without modifying them."""
from pathlib import Path
import json, hashlib, base64, sys
root = Path(__file__).resolve().parent.parent
source = root / 'public/runtime/toolbar'
manifest = json.loads((source / 'manifest.json').read_text())
labels = {
    'std': ['Cut', 'Copy', 'Paste', 'Undo', 'Redo', 'Delete', 'New', 'Open', 'Save', 'Print preview', 'Properties', 'Help', 'Find', 'Replace', 'Print'],
    'view': ['Large icons', 'Small icons', 'List', 'Details', 'Sort by name', 'Sort by size', 'Sort by date', 'Sort by type', 'Parent folder', 'Connect', 'Disconnect', 'New folder'],
    'hist': ['Back', 'Forward', 'Favorites', 'Add to favorites', 'View tree'],
}
bundle = {'_provenance': {'sourceRevision': manifest['sourceRevision'], 'license': 'LGPL-2.1-or-later', 'sources': 'public/runtime/toolbar/', 'generator': 'scripts/generate-toolbar-assets.py'}}
for family, first in [('std', 0), ('view', 4), ('hist', 8)]:
    for size, offset in [('small', 0), ('large', 1)]:
        name = f'idb_{family}_{size}.bmp'
        data = (source / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == manifest['files'][name]['sha256']
        bundle[str(first + offset)] = {'bitmap': base64.b64encode(data[14:]).decode(), 'labels': labels[family], 'size': 16 if size == 'small' else 24}
output = json.dumps(bundle, indent=2) + '\n'
destination = root / 'src/toolbar-bitmaps.json'
if '--check' in sys.argv:
    assert json.loads(destination.read_text()) == bundle
else:
    destination.write_text(output)
