# Original WineBrowser contributors, MIT. Runs unchanged on Windows CPython.
import sys, json, zlib, bz2, lzma, decimal, sqlite3, unicodedata
import _decimal, _sqlite3, _bz2, _lzma, _elementtree, pyexpat
import xml.etree.ElementTree as ET
from decimal import Decimal, localcontext

assert all(module.__file__.lower().endswith('.pyd') for module in
           [_decimal, _sqlite3, _bz2, _lzma, _elementtree, pyexpat, unicodedata])
payload = ('WineBrowser Unicode: café λ 日本語\n' * 32).encode('utf-8')
compressed = {}
for name, module in [('zlib', zlib), ('bz2', bz2), ('lzma', lzma)]:
    packed = module.compress(payload)
    assert module.decompress(packed) == payload
    compressed[name] = len(packed)
with localcontext() as context:
    context.prec = 40
    root = str(Decimal(2).sqrt())
assert root == '1.414213562373095048801688724209698078570'

connection = sqlite3.connect('compatibility.db')
connection.execute('create table items (id integer primary key, label text, data blob)')
connection.executemany('insert into items(label,data) values(?,?)',
                       [('café', b'\x00\xff'), ('日本語', payload)])
connection.commit()
connection.execute("insert into items(label,data) values('rolled back',NULL)")
connection.rollback()
assert connection.execute('pragma integrity_check').fetchone() == ('ok',)
rows = connection.execute('select id,label,length(data) from items order by id').fetchall()
assert rows == [(1, 'café', 2), (2, '日本語', len(payload))]
connection.close()
connection = sqlite3.connect('compatibility.db')
assert connection.execute('select count(*) from items').fetchone()[0] == 2
connection.close()

root_xml = ET.fromstring('<root><item name="café">日本語</item></root>')
assert root_xml.find('item').text == '日本語'
events = []
parser = pyexpat.ParserCreate()
parser.StartElementHandler = lambda name, attrs: events.append([name, attrs])
parser.Parse('<root><item name="café"/></root>', True)
assert events == [['root', {}], ['item', {'name': 'café'}]]
assert unicodedata.normalize('NFC', 'cafe\u0301') == 'café'
result = {'version': list(sys.version_info[:3]), 'sum_squares': sum(i*i for i in range(100)),
          'compression_bytes': compressed, 'decimal_sqrt': root, 'sqlite_rows': rows,
          'unicode_normalized': 'café', 'xml_events': events,
          'crc32': zlib.crc32(payload), 'payload_bytes': len(payload)}
encoded = json.dumps(result, sort_keys=True, ensure_ascii=True)
open('workload-results.json', 'w', encoding='utf-8').write(encoded + '\n')
print('PYTHON NATIVE EXTENSION WORKLOAD ' + encoded, flush=True)
