// DIB scanlines are DWORD aligned. RGB arrays here are independent of the
// little-endian BGR triples/quads and packed indices in guest memory.
export function defaultDibPalette(depth) {
  if (depth === 1)
    return [
      [0, 0, 0],
      [255, 255, 255],
    ];
  const colors = [
    [0, 0, 0],
    [128, 0, 0],
    [0, 128, 0],
    [128, 128, 0],
    [0, 0, 128],
    [128, 0, 128],
    [0, 128, 128],
    [128, 128, 128],
    [192, 192, 192],
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
  ];
  if (depth === 4) return colors;
  if (depth !== 8) return [];
  const table = Array.from({ length: 256 }, (_, i) => [
    (i & 7) * 32,
    ((i >> 3) & 7) * 32,
    (i >> 6) * 64,
  ]);
  table.splice(0, 10, ...colors.slice(0, 7), colors[8], [192, 220, 192], [166, 202, 240]);
  table.splice(246, 10, [255, 251, 240], [160, 160, 164], colors[7], ...colors.slice(9));
  return table;
}

export function readDibLayout(r, info, usage, { output = false, paletteEntries } = {}) {
  if (!info || usage > 1) return null;
  r.check(info, 12, output);
  const size = r.read32(info),
    core = size === 12;
  if (![12, 40, 52, 56, 108, 124].includes(size)) return null;
  r.check(info, size, output);
  const width = core ? r.view.getUint16(info + 4, true) : r.read32(info + 4) | 0;
  const signedHeight = core ? r.view.getUint16(info + 6, true) : r.read32(info + 8) | 0;
  const height = Math.abs(signedHeight);
  const depth = r.view.getUint16(info + (core ? 10 : 14), true);
  const planes = r.view.getUint16(info + (core ? 8 : 12), true);
  const compression = core ? 0 : r.read32(info + 16);
  if (
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    planes !== 1 ||
    ![1, 4, 8, 16, 24, 32].includes(depth) ||
    ![0, 3].includes(compression) ||
    (compression === 3 && ![16, 32].includes(depth))
  )
    return null;
  let masks = depth === 16 ? [0x7c00, 0x3e0, 0x1f] : [0xff0000, 0xff00, 0xff];
  if (compression === 3) {
    r.check(info + 40, 12, output);
    if (!output) masks = [0, 4, 8].map((offset) => r.read32(info + 40 + offset));
    if (
      masks.some((mask) => {
        if (!mask || (depth === 16 && mask > 0xffff)) return true;
        const low = (mask & -mask) >>> 0,
          shifted = (mask >>> 0) / low;
        return (shifted & (shifted + 1)) !== 0;
      }) ||
      masks[0] & masks[1] ||
      masks[0] & masks[2] ||
      masks[1] & masks[2]
    )
      return null;
  }
  let palette = [];
  if (depth <= 8) {
    const count = output || core ? 1 << depth : r.read32(info + 32) || 1 << depth;
    if (count > 1 << depth) return null;
    const entry = usage === 1 ? 2 : core ? 3 : 4,
      at = info + size;
    r.check(at, count * entry, output);
    if (output)
      palette =
        usage === 1
          ? paletteEntries?.length &&
            Array.from({ length: count }, (_, i) => paletteEntries[i] ?? [0, 0, 0])
          : defaultDibPalette(depth);
    else {
      palette = Array.from({ length: count }, (_, i) =>
        usage === 1
          ? paletteEntries?.[
              r.view.getUint16(at + i * 2, true) % Math.min(count, paletteEntries.length)
            ]
          : [r.data[at + i * entry + 2], r.data[at + i * entry + 1], r.data[at + i * entry]],
      );
    }
    if (!palette || palette.length !== count || palette.some((color) => !color)) return null;
    // Windows fills omitted entries in a partial color table with black.
    while (palette.length < 1 << depth) palette.push([0, 0, 0]);
  }
  return {
    info,
    size,
    core,
    width,
    height,
    signedHeight,
    depth,
    compression,
    masks,
    palette,
    paletteCache: new Map(),
    stride: Math.ceil((width * depth) / 32) * 4,
  };
}

export function readDibPixel(r, layout, row, x) {
  const { depth, masks, palette } = layout;
  if (depth <= 8) {
    const index =
      depth === 8
        ? r.data[row + x]
        : depth === 4
          ? (r.data[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15
          : (r.data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
    return palette[index];
  }
  if (depth === 24) return [r.data[row + x * 3 + 2], r.data[row + x * 3 + 1], r.data[row + x * 3]];
  const value = depth === 16 ? r.view.getUint16(row + x * 2, true) : r.read32(row + x * 4);
  return masks.map((mask) => {
    const low = (mask & -mask) >>> 0,
      maximum = (mask >>> 0) / low;
    return Math.round(((((value & mask) >>> 0) / low) * 255) / maximum);
  });
}

export function writeDibPixel(r, layout, row, x, rgb) {
  const { depth, masks, palette, paletteCache } = layout;
  if (depth <= 8) {
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    let index = paletteCache.get(key);
    if (index === undefined) {
      index = 0;
      let distance = Infinity;
      for (let i = 0; i < palette.length; i++) {
        const candidate = rgb.reduce((sum, channel, n) => sum + (channel - palette[i][n]) ** 2, 0);
        if (candidate < distance) {
          distance = candidate;
          index = i;
        }
        if (!distance) break;
      }
      // A photograph may have millions of different colors. Cache frequent
      // colors without creating an unbounded map while quantizing the image.
      if (paletteCache.size < 4096) paletteCache.set(key, index);
    }
    if (depth === 8) r.data[row + x] = index;
    else if (depth === 4) r.data[row + (x >> 1)] |= index << (x & 1 ? 0 : 4);
    else r.data[row + (x >> 3)] |= index << (7 - (x & 7));
  } else if (depth === 24) r.data.set([rgb[2], rgb[1], rgb[0]], row + x * 3);
  else {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const mask = masks[i],
        low = (mask & -mask) >>> 0,
        maximum = (mask >>> 0) / low;
      value = (value | ((Math.round((rgb[i] * maximum) / 255) * low) & mask)) >>> 0;
    }
    if (depth === 16) r.view.setUint16(row + x * 2, value, true);
    else r.write32(row + x * 4, value);
  }
}

export function writeDibColorTable(r, layout, usage) {
  const { info, size, core, depth, compression, masks, palette, stride, height } = layout;
  if (!core) {
    r.write32(info + 20, stride * height);
    r.write32(info + 32, 0);
    r.write32(info + 36, 0);
  }
  if (compression === 3) masks.forEach((mask, i) => r.write32(info + 40 + i * 4, mask));
  if (depth > 8) return;
  const entry = usage === 1 ? 2 : core ? 3 : 4;
  for (let i = 0; i < palette.length; i++) {
    const at = info + size + i * entry;
    if (usage === 1) r.view.setUint16(at, i, true);
    else r.data.set([palette[i][2], palette[i][1], palette[i][0], 0].slice(0, entry), at);
  }
}
