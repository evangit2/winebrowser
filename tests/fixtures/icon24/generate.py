"""Write deterministic fixture bytes: a 24-bit BGR DIB and an AND mask."""
from pathlib import Path
from struct import pack

width = height = 32
xor = bytearray()
mask = bytearray()
for y in reversed(range(height)):
    mask_row = bytearray(4)
    for x in range(width):
        transparent = x == 0 or y == 0 or x == width - 1 or y == height - 1
        xor.extend((0, 0, 0) if transparent else (x * 3 + y, y * 7, x * 7))
        if transparent:
            mask_row[x // 8] |= 0x80 >> (x % 8)
    mask.extend(mask_row)
dib = pack('<IiiHHIIiiII', 40, width, height * 2, 1, 24, 0, len(xor), 0, 0, 0, 0) + xor + mask
ico = pack('<HHH', 0, 1, 1) + pack('<BBBBHHII', width, height, 0, 0, 1, 24, len(dib), 22) + dib
Path(__file__).with_name('icon24.ico').write_bytes(ico)
