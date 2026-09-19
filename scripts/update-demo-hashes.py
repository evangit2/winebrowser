#!/usr/bin/env python3
"""Refresh hashes for rebuilt, already cataloged native graphics fixtures."""
import hashlib
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1] / 'public' / 'demos'
manifest_path = root / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
for name in sys.argv[1:]:
    item = next((entry for entry in manifest['interactive'] if entry['name'] == name), None)
    if item is None:
        raise SystemExit(f'Add provenance and description to the demo catalog first: {name}')
    for kind in ('exe', 'zip'):
        path = (root / item[kind]).resolve()
        if not path.is_relative_to(root):
            raise SystemExit(f'Demo path is outside the catalog directory: {path}')
        item[kind + 'Sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
