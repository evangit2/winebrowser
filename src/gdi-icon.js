import { iconForHandle, createOwnedIcon } from './win32-icons.js';

// Bitmap-backed icons own both planes independently of the guest HBITMAPs.
// The native planes retain XOR RGB and the separate monochrome AND mask;
// display RGBA alone cannot represent destination inversion.
export function createBitmapIconApis({ stateFor, snapshotBitmap, ownBitmap, success, failure }) {
  const failed = (r, error, argc) => failure(r, error, 0, argc);
  const normalize = (icon) => {
    if (icon.native) return icon;
    const color = icon.pixels.slice(),
      mask = new Uint8Array(icon.width * icon.height);
    let alpha = false;
    for (let i = 0; i < mask.length; i++) {
      mask[i] = color[i * 4 + 3] === 0 ? 255 : 0;
      alpha ||= color[i * 4 + 3] !== 255;
    }
    return { ...icon, native: { color, mask, alpha, monochrome: false } };
  };
  const make = (r, icon, argc) => {
    try {
      return success(createOwnedIcon(r, icon), argc);
    } catch {
      return failed(r, 8, argc);
    }
  };
  const create = (r, a) => {
    const input = a(0) >>> 0;
    try {
      if (!input) throw Error();
      r.check(input, 20);
    } catch {
      return failed(r, 87, 1);
    }
    if (!r.read32(input)) return failed(r, 120, 1); // Custom cursor ownership is separate.
    const state = stateFor(r),
      mask = snapshotBitmap(r, state, r.read32(input + 12)),
      colorHandle = r.read32(input + 16),
      color = colorHandle && snapshotBitmap(r, state, colorHandle);
    if (!mask || (colorHandle && !color)) return failed(r, 6, 1);
    if (mask.depth !== 1 || (color && ![24, 32].includes(color.depth))) return failed(r, 120, 1);
    const width = color ? color.width : mask.width,
      height = color ? color.height : mask.height / 2;
    if (
      width < 1 ||
      height < 1 ||
      width > 256 ||
      height > 256 ||
      !Number.isInteger(height) ||
      mask.width !== width ||
      mask.height < (color ? height : height * 2)
    )
      return failed(r, 87, 1);
    const and = new Uint8Array(width * height),
      xor = new Uint8Array(width * height * 4);
    let alpha = false;
    for (let i = 0; i < and.length; i++) {
      and[i] = mask.pixels[i * 4] ? 255 : 0;
      for (let c = 0; c < 3; c++)
        xor[i * 4 + c] = color ? color.pixels[i * 4 + c] : mask.pixels[(i + and.length) * 4 + c];
      xor[i * 4 + 3] = color?.depth === 32 ? color.pixels[i * 4 + 3] : 0;
      alpha ||= xor[i * 4 + 3] !== 0;
    }
    const pixels = xor.slice();
    for (let i = 0; i < and.length; i++) if (!alpha) pixels[i * 4 + 3] = and[i] ? 0 : 255;
    return make(
      r,
      { width, height, pixels, native: { mask: and, color: xor, alpha, monochrome: !color } },
      1,
    );
  };
  const getInfo = (r, a) => {
    const icon = iconForHandle(r, a(0) >>> 0),
      out = a(1) >>> 0;
    if (!icon) return failed(r, 1402, 2);
    try {
      if (!out) throw Error();
      r.check(out, 20, true);
    } catch {
      return failed(r, 87, 2);
    }
    const { width, height, native } = normalize(icon),
      state = stateFor(r),
      mono = native.monochrome;
    const maskPixels = new Uint8Array(width * height * (mono ? 2 : 1) * 4);
    for (let i = 0; i < maskPixels.length / 4; i++) {
      const value = i < width * height ? native.mask[i] : native.color[(i - width * height) * 4];
      maskPixels.set([value, value, value, 255], i * 4);
    }
    const mask = ownBitmap(r, state, width, height * (mono ? 2 : 1), 1, maskPixels);
    if (!mask) return failed(r, 8, 2);
    const color = mono ? 0 : ownBitmap(r, state, width, height, 32, native.color);
    if (!mono && !color) {
      state.bitmaps.delete(mask);
      return failed(r, 8, 2);
    }
    [1, Math.floor(width / 2), Math.floor(height / 2), mask, color].forEach((v, i) =>
      r.write32(out + i * 4, v),
    );
    return success(1, 2);
  };
  const copyImage = (r, a) => {
    const handle = a(0) >>> 0,
      type = a(1) >>> 0,
      flags = a(4) >>> 0;
    const width = a(2) | 0,
      height = a(3) | 0;
    if (width < 0 || height < 0 || width > 4096 || height > 4096) return failed(r, 87, 5);
    if (flags & ~(0x8 | 0x40 | 0x4)) return failed(r, 120, 5);
    if (type === 0) {
      const state = stateFor(r),
        bitmap = snapshotBitmap(r, state, handle);
      if (!bitmap) return failed(r, 6, 5);
      if (![1, 24, 32].includes(bitmap.depth)) return failed(r, 120, 5);
      const w = width || bitmap.width,
        h = height || bitmap.height;
      if (w * h > 16 * 1024 * 1024) return failed(r, 8, 5);
      const pixels = new Uint8Array(w * h * 4),
        sameSize = w === bitmap.width && h === bitmap.height;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = (x * bitmap.width) / w,
            sy = (y * bitmap.height) / h,
            x0 = Math.floor(sx),
            y0 = Math.floor(sy),
            at = (y0 * bitmap.width + x0) * 4,
            to = (y * w + x) * 4;
          if (bitmap.depth === 1 || sameSize) pixels.set(bitmap.pixels.subarray(at, at + 4), to);
          else {
            const x1 = Math.min(x0 + 1, bitmap.width - 1),
              y1 = Math.min(y0 + 1, bitmap.height - 1),
              fx = sx - x0,
              fy = sy - y0;
            for (let c = 0; c < 3; c++) {
              const top =
                  bitmap.pixels[at + c] * (1 - fx) +
                  bitmap.pixels[(y0 * bitmap.width + x1) * 4 + c] * fx,
                bottom =
                  bitmap.pixels[(y1 * bitmap.width + x0) * 4 + c] * (1 - fx) +
                  bitmap.pixels[(y1 * bitmap.width + x1) * 4 + c] * fx;
              pixels[to + c] = Math.round(top * (1 - fy) + bottom * fy);
            }
            // Native color bitmap resampling clears the reserved alpha byte.
            pixels[to + 3] = 0;
          }
        }
      const made = ownBitmap(r, state, w, h, bitmap.depth === 1 ? 1 : 32, pixels);
      if (!made) return failed(r, 8, 5);
      if (flags & 8) r.apiProvider.get('gdi32.dll!DeleteObject')(r, () => handle);
      return success(made, 5);
    }
    if (type !== 1) return failed(r, 120, 5);
    const source = iconForHandle(r, handle);
    if (!source) return failed(r, 1402, 5);
    const icon = normalize(source),
      w = width || (flags & 0x40 ? 32 : icon.width),
      h = height || (flags & 0x40 ? 32 : icon.height);
    if (w > 256 || h > 256) return failed(r, 87, 5);
    if (flags & 0x4 && w === icon.width && h === icon.height) return success(handle, 5);
    const pixels = new Uint8Array(w * h * 4),
      color = new Uint8Array(w * h * 4),
      mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const at =
            Math.floor((y * icon.height) / h) * icon.width + Math.floor((x * icon.width) / w),
          to = y * w + x;
        pixels.set(icon.pixels.subarray(at * 4, at * 4 + 4), to * 4);
        color.set(icon.native.color.subarray(at * 4, at * 4 + 4), to * 4);
        mask[to] = icon.native.mask[at];
      }
    const made = make(
      r,
      { width: w, height: h, pixels, native: { ...icon.native, color, mask } },
      5,
    );
    if (made.result && flags & 8) r.apiProvider.get('user32.dll!DestroyIcon')(r, () => handle);
    return made;
  };
  return {
    'user32.dll!CreateIconIndirect': create,
    'user32.dll!GetIconInfo': getInfo,
    'user32.dll!CopyImage': copyImage,
  };
}
