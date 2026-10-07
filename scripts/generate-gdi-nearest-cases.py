"""Embed independently captured desktop Wine expectations in the native SDK client."""
from pathlib import Path
import json
import sys
root = Path(__file__).resolve().parent.parent
rows = json.loads((root / 'tests/fixtures/gdi-nearest/wine-oracle.json').read_text())['cases']
source = ('/* Original WineBrowser contributors, MIT. Generated from independently captured desktop Wine results. */\n'
          'struct NativeCase{unsigned surface,palette;COLORREF input,result;DWORD error;};\n'
          'static const struct NativeCase cases[]={\n')
source += ''.join('{%d,%d,0x%08xu,0x%08xu,%du},\n' %
                  (r['surface'], r['palette'], r['input'], r['result'], r['error']) for r in rows)
source += '};\n'
path = root / 'tests/fixtures/gdi-nearest/native-cases.h'
if '--check' in sys.argv:
    assert path.read_text() == source, 'Native nearest-color expectations are stale'
else:
    path.write_text(source)
