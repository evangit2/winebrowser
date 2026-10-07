import { writeDibPixel } from './gdi-dib.js';
import { clippedBounds, visiblePixel, markGdiDirty, surfaceRgb } from './gdi-raster.js';
const mul = (value, alpha) => Math.floor((value * alpha + 127) / 255);
const depthOf = (bitmap) =>
  bitmap.dib?.layout.depth ?? bitmap.depth ?? (bitmap.monochrome ? 1 : 32);
function alphaAt(r, bitmap, x, y) {
  if (depthOf(bitmap) !== 32) return 255;
  if (bitmap.dib) {
    const { bits, layout } = bitmap.dib;
    return r.data[
      bits + (layout.signedHeight < 0 ? y : bitmap.height - 1 - y) * layout.stride + x * 4 + 3
    ];
  }
  return bitmap.iconAlpha?.[y * bitmap.width + x] ?? 0;
}
function standard32(bitmap) {
  const layout = bitmap.dib?.layout;
  return (
    !layout ||
    layout.depth !== 32 ||
    layout.masks.every((v, i) => v === [0xff0000, 0xff00, 0xff][i])
  );
}

/** Native SRC_OVER: combined rounding for constant alpha, separate products for pixel alpha. */
export function createAlphaBlendApis({ stateFor, getDc, readablePixels, success, failure }) {
  const blend = (r, a) => {
    const state = stateFor(r),
      destination = getDc(r, state, a(0)),
      source = getDc(r, state, a(5));
    if (!destination || !source) return failure(r, 6, 0, 11);
    const dx = a(1) | 0,
      dy = a(2) | 0,
      dw = a(3) | 0,
      dh = a(4) | 0,
      sx = a(6) | 0,
      sy = a(7) | 0,
      sw = a(8) | 0,
      sh = a(9) | 0,
      functionWord = a(10) >>> 0,
      constant = (functionWord >>> 16) & 255,
      perPixel = (functionWord >>> 24) & 255;
    if ((functionWord & 0xffff) !== 0 || perPixel > 1 || Math.min(dw, dh, sw, sh) < 0)
      return failure(r, 87, 0, 11);
    if (!dw || !dh || !sw || !sh) return success(1, 11);
    if (sx < 0 || sy < 0 || sx + sw > source.surface.width || sy + sh > source.surface.height)
      return failure(r, 87, 0, 11);
    if (
      destination.surface === source.surface &&
      dx < sx + sw &&
      sx < dx + dw &&
      dy < sy + sh &&
      sy < dy + dh
    )
      return failure(r, 87, 0, 11);
    const srcBitmap = source.kind === 'memory-dc' ? source.surface : null,
      dstBitmap = destination.kind === 'memory-dc' ? destination.surface : null;
    if (perPixel && srcBitmap && depthOf(srcBitmap) !== 32) return failure(r, 87, 0, 11);
    if (!constant) return success(1, 11);
    if (perPixel && (!srcBitmap || !standard32(srcBitmap))) return failure(r, 120, 0, 11);
    if (dstBitmap && !standard32(dstBitmap)) return failure(r, 120, 0, 11);
    if (!readablePixels(source.surface, sx, sy, sw, sh)) return failure(r, 120, 0, 11);
    const target = destination.surface,
      bounds = clippedBounds(target, dx, dy, dx + dw, dy + dh, destination),
      src = source.surface.pixels,
      pixels = target.pixels;
    if (target.controlOverlay) {
      for (let y = bounds[1]; y < bounds[3]; y++)
        for (let x = bounds[0]; x < bounds[2]; x++)
          if (
            visiblePixel(target, destination, x, y) &&
            pixels[(y * target.width + x) * 4 + 3] !== 255
          )
            return failure(r, 120, 0, 11);
    }
    const dib = dstBitmap?.dib,
      writeAlpha = dstBitmap && depthOf(dstBitmap) === 32;
    if (dib) r.check(dib.bits, dib.layout.stride * dib.layout.height, true);
    if (writeAlpha && !dib && !dstBitmap.iconAlpha)
      dstBitmap.iconAlpha = new Uint8Array(dstBitmap.width * dstBitmap.height);
    let changed = false;
    for (let y = bounds[1]; y < bounds[3]; y++) {
      const sourceY = sy + Math.floor(((y - dy) * sh) / dh);
      for (let x = bounds[0]; x < bounds[2]; x++) {
        if (!visiblePixel(target, destination, x, y)) continue;
        const sourceX = sx + Math.floor(((x - dx) * sw) / dw),
          from = (sourceY * source.surface.width + sourceX) * 4,
          to = (y * target.width + x) * 4,
          rawSourceAlpha = srcBitmap ? alphaAt(r, srcBitmap, sourceX, sourceY) : 255,
          sourceAlpha = mul(rawSourceAlpha, constant),
          inverse = 255 - (perPixel ? sourceAlpha : constant);
        let rgb = [0, 1, 2].map((c) =>
          perPixel
            ? Math.min(255, mul(src[from + c], constant) + mul(pixels[to + c], inverse))
            : Math.floor((src[from + c] * constant + pixels[to + c] * inverse + 127) / 255),
        );
        rgb = surfaceRgb(target, rgb);
        const oldAlpha = writeAlpha ? alphaAt(r, dstBitmap, x, y) : 255,
          alpha = perPixel
            ? Math.min(255, sourceAlpha + mul(oldAlpha, inverse))
            : Math.floor((rawSourceAlpha * constant + oldAlpha * inverse + 127) / 255);
        if (rgb.some((v, c) => v !== pixels[to + c]) || (writeAlpha && alpha !== oldAlpha))
          changed = true;
        pixels.set([...rgb, 255], to);
        if (dib) {
          const row = dib.layout.signedHeight < 0 ? y : dstBitmap.height - 1 - y,
            address = dib.bits + row * dib.layout.stride;
          // Write RGB before alpha: the GDI boundary sees matching pixels and
          // preserves the native alpha byte instead of clearing it during commit.
          writeDibPixel(r, dib.layout, address, x, rgb);
          if (writeAlpha) r.data[address + x * 4 + 3] = alpha;
          dib.dirtyRows.add(row);
        } else if (writeAlpha) dstBitmap.iconAlpha[y * dstBitmap.width + x] = alpha;
      }
    }
    if (changed) markGdiDirty(target, ...bounds);
    return success(1, 11);
  };
  return { 'gdi32.dll!GdiAlphaBlend': blend, 'msimg32.dll!AlphaBlend': blend };
}
