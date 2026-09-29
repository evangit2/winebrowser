"""Independent S3TC/DXT decoder oracle built on Pillow's C implementation.

Writes tests/fixtures/dxt-vectors.json: deterministic packed 4x4-block payloads
plus the RGBA bytes Pillow produces for them.  The runtime decoder in
src/d3d-compressed.js is checked against this file, so its expansion and blend
rounding are never validated against its own arithmetic.
"""
from pathlib import Path
import io
import json
import random
import struct

from PIL import Image

# DDS pixel-format flags and the four-character codes we emit.
DDPF_FOURCC = 0x4


def dds(width, height, fourcc, payload, mip_count=1):
    """Minimal DDS container holding one or more uncompressed/compressed levels."""
    flags = 0x1007  # CAPS|HEIGHT|WIDTH|PIXELFORMAT
    if mip_count > 1:
        flags |= 0x20000  # MIPMAPCOUNT
    header = (
        b'DDS '
        + struct.pack('<IIIIIII', 124, flags, height, width, 0, 0, mip_count)
        + bytes(44)
        + struct.pack('<II4sIIIII', 32, DDPF_FOURCC, fourcc, 0, 0, 0, 0, 0)
        + struct.pack('<IIIII', 0x1000 | (0x400000 if mip_count > 1 else 0), 0, 0, 0, 0)
    )
    assert len(header) == 128, len(header)
    return header + payload


def blocks_for(fourcc, rng):
    """One 4x4 block for the requested format."""
    if fourcc == b'DXT1':
        c0, c1 = rng.randrange(0x10000), rng.randrange(0x10000)
        return struct.pack('<HHI', c0, c1, rng.randrange(1 << 32))
    if fourcc == b'DXT3':
        alpha = bytes(rng.randrange(256) for _ in range(8))
        c0, c1 = rng.randrange(0x10000), rng.randrange(0x10000)
        return alpha + struct.pack('<HHI', c0, c1, rng.randrange(1 << 32))
    if fourcc == b'DXT5':
        a0, a1 = rng.randrange(256), rng.randrange(256)
        alpha = bytes([a0, a1]) + bytes(rng.randrange(256) for _ in range(6))
        c0, c1 = rng.randrange(0x10000), rng.randrange(0x10000)
        return alpha + struct.pack('<HHI', c0, c1, rng.randrange(1 << 32))
    raise ValueError(fourcc)


vectors = []
rng = random.Random(0xD3C0FFEE)
for fourcc in (b'DXT1', b'DXT3', b'DXT5'):
    for tag, count in (('single', 1), ('wide', 8), ('tall', 3)):
        # Keep every level a multiple of four so the oracle needs no edge crop.
        width = count * 4
        height = (1 if tag == 'single' else 2 if tag == 'wide' else 3) * 4
        payload = b''.join(blocks_for(fourcc, rng) for _ in range((width // 4) * (height // 4)))
        image = Image.open(io.BytesIO(dds(width, height, fourcc, payload))).convert('RGBA')
        vectors.append({
            'name': f'{fourcc.decode()}-{tag}',
            'format': int.from_bytes(fourcc, 'little'),
            'width': width,
            'height': height,
            'payload': payload.hex(),
            'rgba': list(image.tobytes()),
        })
# A 1-bit-alpha DXT1 block (color0 <= color1) exercises the transparent texel.
for _ in range(3):
    c0, c1 = sorted((rng.randrange(0x10000), rng.randrange(0x10000)))
    payload = struct.pack('<HHI', c0, c1, rng.randrange(1 << 32))
    image = Image.open(io.BytesIO(dds(4, 4, b'DXT1', payload))).convert('RGBA')
    vectors.append({
        'name': 'DXT1-one-bit-alpha', 'format': int.from_bytes(b'DXT1', 'little'),
        'width': 4, 'height': 4, 'payload': payload.hex(), 'rgba': list(image.tobytes()),
    })

root = Path(__file__).resolve().parents[1]
output = root / 'tests/fixtures/dxt-vectors.json'
output.write_text(json.dumps({
    'oracle': "Pillow's independent S3TC decoder; deterministic packed blocks; no runtime code",
    'vectors': vectors,
}, indent=2) + '\n')
print(f'wrote {len(vectors)} vectors')
