import { readPEResource } from './pe-resources.js';
import { resourceDibLayout } from './win32-resource-bitmaps.js';
import { readDibLayout, readDibPixel, writeDibPixel } from './gdi-dib.js';
import { resolveGuestPath } from './guest-paths.js';

const result = (value) => ({ result: value >>> 0, argc: 6 });
function fail(r, error) {
  r.lastError = error;
  return result(0);
}
const FROM_FILE = 0x10,
  TRANSPARENT = 0x20,
  MAP_COLORS = 0x1000,
  SECTION = 0x2000;
const FLAGS = 1 | 2 | FROM_FILE | TRANSPARENT | 0x40 | MAP_COLORS | SECTION | 0x8000;

function bitmapPayload(r, a, wide) {
  const pointer = a(1) >>> 0,
    flags = a(5) >>> 0;
  let name;
  try {
    name =
      pointer <= 0xffff && !(flags & FROM_FILE)
        ? pointer
        : wide
          ? r.wideString(pointer)
          : r.string(pointer);
  } catch {
    return { error: 998 };
  }
  if (flags & FROM_FILE) {
    let path;
    try {
      path = resolveGuestPath(name, r.cwd);
    } catch {
      return { error: 123 };
    }
    const bytes = r.files.get(path);
    if (!bytes) return { error: 2 };
    if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return { error: 13 };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(2, true),
      offset = view.getUint32(10, true);
    if ((size && size > bytes.length) || (offset && offset < 14)) return { error: 13 };
    return { payload: bytes.subarray(14), offset: offset ? offset - 14 : null };
  }
  // Null hInstance names predefined OEM bitmaps, rather than the main EXE.
  if (!a(0)) return { error: 120 };
  const module = [...r.graph.modules.values()].find((m) => m.base === a(0) >>> 0);
  if (!module?.bytes) return { error: 126 };
  try {
    const payload = readPEResource(module.bytes, 2, name);
    return payload ? { payload, offset: null } : { error: 1814 };
  } catch {
    return { error: 13 };
  }
}

function fixPalette(r, layout, flags, source, declaredColors) {
  if (layout.depth > 8) return;
  const system = (index) => {
    const color = r.apiProvider.get('user32.dll!GetSysColor')(r, () => index).result;
    return [color & 255, (color >>> 8) & 255, (color >>> 16) & 255];
  };
  if (flags & TRANSPARENT) {
    const first = r.data[source];
    const index = layout.depth === 1 ? first >>> 7 : layout.depth === 4 ? first >>> 4 : first;
    if (index < declaredColors) layout.palette[index] = system(flags & MAP_COLORS ? 15 : 5);
  }
  if (flags & MAP_COLORS)
    layout.palette = layout.palette.map((rgb, index) => {
      if (index >= declaredColors) return rgb;
      if (!rgb.every((v) => v === rgb[0])) return rgb;
      return rgb[0] === 128
        ? system(16)
        : rgb[0] === 192
          ? system(15)
          : rgb[0] === 223
            ? system(22)
            : rgb;
    });
}

function loadBitmapImage(r, a, wide) {
  const flags = a(5) >>> 0,
    width = a(3) | 0,
    height = a(4) | 0;
  if (flags & ~FLAGS || width < 0 || height < 0 || width > 4096 || height > 4096)
    return fail(r, 87);
  const input = bitmapPayload(r, a, wide);
  if (input.error) return fail(r, input.error);
  const resource = resourceDibLayout(input.payload, input.offset);
  if (!resource) return fail(r, 13);
  const allocated = [];
  const allocate = (size) => {
    const p = r.allocate(size);
    allocated.push(p);
    return p;
  };
  let bitmap = 0,
    complete = false;
  const api = (name, ...args) =>
    r.apiProvider.get('gdi32.dll!' + name)(r, (i) => args[i] ?? 0).result;
  try {
    const source = allocate(input.payload.length);
    r.check(source, input.payload.length, true);
    r.data.set(input.payload, source);
    const original = readDibLayout(r, source, 0);
    if (!original) return fail(r, 13);
    fixPalette(r, original, flags, source + resource.bits, resource.colors);
    const w = width || original.width,
      h = height || original.height;
    const monochrome =
      original.depth === 1 && original.palette.every((rgb, i) => rgb.every((v) => v === i * 255));
    const depth = flags & SECTION ? original.depth : flags & 1 || monochrome ? 1 : 32;
    const compression = flags & SECTION ? original.compression : 0;
    const palette =
      depth <= 8
        ? flags & SECTION
          ? original.palette
          : [
              [0, 0, 0],
              [255, 255, 255],
            ]
        : [];
    const header = allocate(40 + (compression === 3 ? 12 : palette.length * 4));
    const stride = Math.ceil((w * depth) / 32) * 4,
      bytes = stride * h;
    r.check(header, 40 + (compression === 3 ? 12 : palette.length * 4), true);
    r.data.fill(0, header, header + 40 + (compression === 3 ? 12 : palette.length * 4));
    r.write32(header, 40);
    r.write32(header + 4, w);
    r.write32(header + 8, original.signedHeight < 0 ? -h : h);
    r.view.setUint16(header + 12, 1, true);
    r.view.setUint16(header + 14, depth, true);
    r.write32(header + 16, compression);
    r.write32(header + 20, bytes);
    if (palette.length) r.write32(header + 32, palette.length);
    if (compression === 3)
      original.masks.forEach((mask, i) => r.write32(header + 40 + i * 4, mask));
    else palette.forEach((rgb, i) => r.data.set([rgb[2], rgb[1], rgb[0], 0], header + 40 + i * 4));
    const outputLayout = readDibLayout(r, header, 0);
    let output;
    if (flags & SECTION) {
      const pointer = allocate(4);
      bitmap = api('CreateDIBSection', 0, header, 0, pointer, 0, 0);
      if (!bitmap) return result(0);
      output = r.read32(pointer);
    } else output = allocate(bytes);
    r.check(output, bytes, true);
    r.data.fill(0, output, output + bytes);
    const samePalette =
      palette.length === original.palette.length &&
      palette.every((rgb, i) => rgb.every((v, c) => v === original.palette[i][c]));
    if (
      w === original.width &&
      h === original.height &&
      depth === original.depth &&
      compression === original.compression &&
      samePalette
    ) {
      // Preserve duplicate indexed colors, packed neighbors, row padding and
      // unused BGRA bits when the native format and dimensions are unchanged.
      r.data.set(input.payload.subarray(resource.bits, resource.bits + bytes), output);
    } else {
      for (let y = 0; y < h; y++) {
        const sy = Math.min(original.height - 1, Math.floor(((y + 0.5) * original.height) / h));
        const row =
          source +
          resource.bits +
          (original.signedHeight < 0 ? sy : original.height - 1 - sy) * original.stride;
        const destination = output + (outputLayout.signedHeight < 0 ? y : h - 1 - y) * stride;
        for (let x = 0; x < w; x++) {
          const sx = Math.min(original.width - 1, Math.floor(((x + 0.5) * original.width) / w));
          const rgb = readDibPixel(r, original, row, sx);
          if (!rgb) return fail(r, 13);
          writeDibPixel(r, outputLayout, destination, x, rgb);
        }
      }
    }
    if (!(flags & SECTION)) bitmap = api('CreateDIBitmap', 0, header, 4, output, header, 0);
    complete = !!bitmap;
    return result(bitmap);
  } finally {
    if (bitmap && !complete) api('DeleteObject', bitmap);
    for (const pointer of allocated.reverse()) r.free(pointer);
  }
}

// Six SDK arguments, including type at index 2 and fuLoad at index 5.
export function loadImage(r, a, wide) {
  const type = a(2) >>> 0;
  if (type === 0) return loadBitmapImage(r, a, wide);
  if (type !== 1 && type !== 2) return fail(r, 87);
  // Existing resource icon/cursor decoders own their normal-sized shared handles.
  // File loading, custom sizing and conversion need the corresponding decoder.
  const flags = a(5) >>> 0;
  if (a(3) || a(4) || flags & ~(0x40 | 0x8000)) return fail(r, 120);
  const api = 'user32.dll!Load' + (type === 1 ? 'Icon' : 'Cursor') + (wide ? 'W' : 'A');
  return { ...r.apiProvider.get(api)(r, (i) => [a(0), a(1)][i] ?? 0), argc: 6 };
}
