"""Embed independently captured desktop Wine pixel-write expectations."""
from pathlib import Path
import json
import sys
root = Path(__file__).resolve().parent.parent
rows = json.loads((root / 'tests/fixtures/gdi-pixel-colors/wine-oracle.json').read_text())['cases']
source = ('/* Original WineBrowser contributors, MIT. Generated from desktop Wine results. */\n'
          'struct NativeCase{unsigned type;COLORREF color,result;DWORD error;COLORREF pixel;DWORD raw;};\n'
          'static const struct NativeCase cases[]={\n')
source += ''.join('{%du,0x%08xu,0x%08xu,%du,0x%08xu,0x%08xu},\n' %
                  (r['type'],r['color'],r['result'],r['error'],r['pixel'],r['raw']) for r in rows)
source += '};\n'
path = root / 'tests/fixtures/gdi-pixel-colors/native-cases.h'
if '--check' in sys.argv:
    assert path.read_text() == source, 'Native pixel expectations are stale'
else:
    path.write_text(source)
