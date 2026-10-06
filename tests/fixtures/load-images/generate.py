"""Authored file-loader fixtures; original palette/pixel data are shared with RT_BITMAP tests."""
from pathlib import Path
import struct
SOURCE = Path(__file__).parent.parent / 'resource-bitmaps'
DEST = Path(__file__).parent
for name in ['indexed4.bmp', 'indexed8.bmp', 'core4.bmp', 'mono.bmp', 'rgb24.bmp', 'rgb565.bmp', 'rgb32.bmp']:
    (DEST / name).write_bytes((SOURCE / name).read_bytes())
original = (SOURCE / 'indexed4.bmp').read_bytes()
offset = struct.unpack_from('<I', original, 10)[0]
gap = bytearray(original[:offset] + bytes([0x55]) * 13 + original[offset:])
struct.pack_into('<I', gap, 2, len(gap))
struct.pack_into('<I', gap, 10, offset + 13)
(DEST / 'gap.bmp').write_bytes(gap)
(DEST / 'truncated.bmp').write_bytes(original[:28])
