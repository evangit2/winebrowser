import { readPEResource } from './pe-resources.js';

const result = (value) => ({ result: value >>> 0, argc: 5 });
function fail(r, error) {
  r.lastError = error;
  return result(0);
}

// Locate and validate a resource DIB before forwarding it to the shared GDI
// converter. The PE resource bytes are immutable: colour mapping uses a copy.
export function resourceDibLayout(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    size = v.getUint32(0, true),
    core = size === 12;
  if ((!core && ![40, 52, 56, 108, 124].includes(size)) || size > bytes.length) return null;
  const depth = v.getUint16(core ? 10 : 14, true),
    planes = v.getUint16(core ? 8 : 12, true),
    width = core ? v.getUint16(4, true) : v.getInt32(4, true),
    signedHeight = core ? v.getUint16(6, true) : v.getInt32(8, true),
    height = Math.abs(signedHeight),
    compression = core ? 0 : v.getUint32(16, true);
  if (
    planes !== 1 ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    ![1, 4, 8, 16, 24, 32].includes(depth) ||
    ![0, 3].includes(compression) ||
    (compression === 3 && ![16, 32].includes(depth))
  )
    return null;
  const colors = core
      ? depth <= 8
        ? 1 << depth
        : 0
      : v.getUint32(32, true) || (depth <= 8 ? 1 << depth : 0),
    entry = core ? 3 : 4,
    palette = size + (size === 40 && compression === 3 ? 12 : 0);
  if (colors > 256 || (depth <= 8 && colors > 1 << depth)) return null;
  const bits = palette + colors * entry,
    stride = Math.ceil((width * depth) / 32) * 4;
  if (bits + stride * height > bytes.length) return null;
  return { width, height, depth, palette, colors, entry, bits };
}
function loadResourceBitmap(r, instance, name, maps) {
  const module = instance
    ? [...r.graph.modules.values()].find((m) => m.base === instance)
    : r.graph.main;
  if (!module?.bytes) return fail(r, 126);
  let payload;
  try {
    payload = readPEResource(module.bytes, 2, name);
  } catch {
    return fail(r, 13);
  }
  if (!payload) return fail(r, 1814);
  const layout = resourceDibLayout(payload);
  if (!layout) return fail(r, 13);
  const bytes = payload.slice();
  if (maps)
    for (let i = 0; i < layout.colors; i++) {
      const at = layout.palette + i * layout.entry,
        color = (bytes[at + 2] | (bytes[at + 1] << 8) | (bytes[at] << 16)) >>> 0;
      if (!maps.has(color)) continue;
      const replacement = maps.get(color);
      bytes[at] = (replacement >>> 16) & 255;
      bytes[at + 1] = (replacement >>> 8) & 255;
      bytes[at + 2] = replacement & 255;
    }
  const p = r.allocate(bytes.length);
  try {
    r.data.set(bytes, p);
    const args = [0, p, 4, p + layout.bits, p, 0],
      bitmap = r.apiProvider.get('gdi32.dll!CreateDIBitmap')(r, (i) => args[i]);
    return result(bitmap.result);
  } finally {
    r.free(p);
  }
}
function mappedBitmap(r, a) {
  // CMB_MASKED requires native mask composition; returning an ordinary bitmap
  // would misrepresent its contract. Keep unsupported flags visible.
  if (a(2)) return fail(r, 120);
  const count = a(4) | 0,
    maps = new Map();
  if (a(3)) {
    if (count < 0 || count > 256) return fail(r, 87);
    r.check(a(3), count * 8);
    for (let i = 0; i < count; i++) {
      const from = r.read32(a(3) + i * 8),
        to = r.read32(a(3) + i * 8 + 4);
      if (!maps.has(from)) maps.set(from, to);
    }
  } else {
    for (const [from, index] of [
      [0, 18],
      [0x808080, 16],
      [0xc0c0c0, 15],
      [0xffffff, 20],
    ])
      maps.set(from, r.apiProvider.get('user32.dll!GetSysColor')(r, () => index).result);
  }
  const name = a(1) <= 0xffff ? a(1) : r.wideString(a(1));
  return loadResourceBitmap(r, a(0), name, maps);
}
function loadBitmap(r, a, wide) {
  if (!a(0)) return { ...fail(r, 120), argc: 2 }; // Predefined OEM bitmaps need system assets.
  const name = a(1) <= 0xffff ? a(1) : wide ? r.wideString(a(1)) : r.string(a(1)),
    loaded = loadResourceBitmap(r, a(0), name, null);
  return { ...loaded, argc: 2 };
}
export const resourceBitmapApis = {
  'comctl32.dll!CreateMappedBitmap': mappedBitmap,
  'user32.dll!LoadBitmapA': (r, a) => loadBitmap(r, a, false),
  'user32.dll!LoadBitmapW': (r, a) => loadBitmap(r, a, true),
};
