"""Original deterministic BMPs for native module resource/GDI contracts."""
from pathlib import Path
import struct
ROOT = Path(__file__).parent
palette = [(0, 0, 0), (128, 128, 128), (192, 192, 192), (255, 255, 255)]
def bmp(name, header, colors, pixels, masks=b''):
    offset = 14 + len(header) + len(masks) + len(colors)
    data = struct.pack('<2sIHHI', b'BM', offset + len(pixels), 0, 0, offset)
    (ROOT / name).write_bytes(data + header + masks + colors + pixels)
def info(width, height, depth, compression=0, colors=0):
    return struct.pack('<IiiHHIIiiII', 40, width, height, 1, depth, compression, 0, 0, 0, colors, 0)
quads = bytes(c for r, g, b in palette for c in (b, g, r, 0))
bmp('indexed4.bmp', info(8, 2, 4, colors=4), quads, bytes.fromhex('3210321001230123'))
bmp('indexed8.bmp', info(8, 2, 8, colors=4), quads, bytes([3,2,1,0,3,2,1,0,0,1,2,3,0,1,2,3]))
core_colors = palette + [(i, i, i) for i in range(12)]
triples = bytes(c for r, g, b in core_colors for c in (b, g, r))
bmp('core4.bmp', struct.pack('<IHHHH', 12, 8, 2, 1, 4), triples, bytes.fromhex('3210321001230123'))
bmp('mono.bmp', info(9, 2, 1, colors=2), bytes([0,0,0,0,255,255,255,0]), bytes.fromhex('5500abcd aa800123'))
rgb_rows = bytes([30,20,10,255,255,255,0,255,255,0xAA,0xBB,0xCC,
                  3,2,1,6,5,4,9,8,7,0xDD,0xEE,0xFF])
bmp('rgb24.bmp', info(3, -2, 24), b'', rgb_rows)
bmp('rgb565.bmp', info(3, 1, 16, 3), b'', bytes.fromhex('00f8 e007 1f00 abcd'),
    struct.pack('<III', 0xf800, 0x7e0, 0x1f))
bmp('rgb32.bmp', info(1, -2, 32), b'', bytes([30,20,10,0,30,60,90,255]))
