// Block-compressed D3D texture formats (S3TC/DXT). Each 4x4 texel block is a
// fixed number of bytes, so pitch and addressing work in block units rather
// than pixels. The decoders reproduce the documented S3TC expansion exactly:
// 5:6:5 endpoints replicate their high bits into the low ones, and the 1/3 and
// 2/3 blend weights truncate with integer division. Byte-for-byte matches
// against Pillow's independent DDS decoder are checked by the unit tests.
export const COMPRESSED_FORMATS = {
  0x31545844: { name: 'DXT1', blockBytes: 8, alpha: 'one-bit' },
  0x33545844: { name: 'DXT3', blockBytes: 16, alpha: 'explicit' },
  0x35545844: { name: 'DXT5', blockBytes: 16, alpha: 'interpolated' },
};
export const compressedFormat = (format) => COMPRESSED_FORMATS[format] ?? null;

// Force the specials back to the normal end-point ramp.
const expand565 = (value) => [(value >>> 11) & 31, (value >>> 5) & 63, value & 31];
const replicate = ([r, g, b]) => [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];

function endpoints(data, p, alpha) {
  const c0 = data[p] | (data[p + 1] << 8),
    c1 = data[p + 2] | (data[p + 3] << 8);
  const [r0, g0, b0] = replicate(expand565(c0)),
    [r1, g1, b1] = replicate(expand565(c1));
  const palette = new Uint8Array(16);
  palette.set([r0, g0, b0, 255, r1, g1, b1, 255]);
  // The c0 <= c1 ordering only selects DXT1's 3-color plus transparent mode.
  // DXT3 and DXT5 carry alpha separately, so their color block always decodes
  // as the full four-color ramp.
  if (c0 > c1 || alpha !== 'one-bit') {
    palette[8] = ((2 * r0 + r1) / 3) | 0;
    palette[9] = ((2 * g0 + g1) / 3) | 0;
    palette[10] = ((2 * b0 + b1) / 3) | 0;
    palette[12] = ((r0 + 2 * r1) / 3) | 0;
    palette[13] = ((g0 + 2 * g1) / 3) | 0;
    palette[14] = ((b0 + 2 * b1) / 3) | 0;
    palette[11] = 255;
    palette[15] = 255;
  } else {
    palette[8] = ((r0 + r1) / 2) | 0;
    palette[9] = ((g0 + g1) / 2) | 0;
    palette[10] = ((b0 + b1) / 2) | 0;
    palette[11] = 255;
    // Only DXT1 reaches here, where index 3 is the transparent black texel.
    palette[12] = palette[13] = palette[14] = palette[15] = 0;
  }
  return palette;
}
// DXT3 stores 4 explicit 4-bit alpha values per texel; DXT5 stores two 8-bit
// alpha endpoints and three bits per texel of interpolated alpha.
function alphaTable(data, p, kind) {
  if (kind === 'explicit') {
    const table = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      const nibble = (data[p + (i >> 1)] >> ((i & 1) * 4)) & 15;
      table[i] = nibble * 17;
    }
    return (index) => table[index];
  }
  const a0 = data[p],
    a1 = data[p + 1];
  const table = new Uint8Array(8);
  table[0] = a0;
  table[1] = a1;
  if (a0 > a1) for (let i = 1; i <= 6; i++) table[i + 1] = (((7 - i) * a0 + i * a1) / 7) | 0;
  else {
    for (let i = 1; i <= 4; i++) table[i + 1] = (((5 - i) * a0 + i * a1) / 5) | 0;
    table[6] = 0;
    table[7] = 255;
  }
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(data[p + 2 + i]) << BigInt(8 * i);
  return (index) => table[Number((bits >> BigInt(3 * index)) & 7n)];
}
// Decode one block-compressed level into a tightly packed RGBA buffer.
export function decodeCompressed(data, offset, format, width, height, out) {
  const { blockBytes, alpha } = compressedFormat(format);
  const blocksWide = Math.ceil(width / 4);
  const blocksHigh = Math.ceil(height / 4);
  for (let by = 0; by < blocksHigh; by++)
    for (let bx = 0; bx < blocksWide; bx++) {
      const p = offset + (by * blocksWide + bx) * blockBytes;
      const colorOffset = alpha === 'one-bit' ? p : p + 8;
      const alphaAt = alpha === 'one-bit' ? null : alphaTable(data, p, alpha);
      const palette = endpoints(data, colorOffset, alpha);
      const bits =
        data[colorOffset + 4] |
        (data[colorOffset + 5] << 8) |
        (data[colorOffset + 6] << 16) |
        (data[colorOffset + 7] << 24);
      for (let ty = 0; ty < 4; ty++)
        for (let tx = 0; tx < 4; tx++) {
          const x = bx * 4 + tx,
            y = by * 4 + ty;
          if (x >= width || y >= height) continue;
          const texel = ty * 4 + tx;
          const index = (bits >>> (2 * texel)) & 3;
          const q = (y * width + x) * 4;
          out[q] = palette[index * 4];
          out[q + 1] = palette[index * 4 + 1];
          out[q + 2] = palette[index * 4 + 2];
          out[q + 3] = alphaAt ? alphaAt(texel) : palette[index * 4 + 3];
        }
    }
}
