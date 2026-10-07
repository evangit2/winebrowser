import { readDibLayout, readDibPixel, writeDibPixel } from './gdi-dib.js';
import { clippedBounds, visiblePixel, markGdiDirty, surfaceRgb } from './gdi-raster.js';

export function createDibTransferApis({ stateFor, getDc, dibPalette, success, failure }) {
  const transfer = (r, a) => {
    const state = stateFor(r),
      dc = getDc(r, state, a(0));
    if (!dc) return failure(r, 6, 0, 12);
    const x = a(1) | 0,
      y = a(2) | 0,
      w = a(3) >>> 0,
      h = a(4) >>> 0,
      sx = a(5) | 0,
      sy = a(6) | 0,
      start = a(7) >>> 0,
      bits = a(9);
    let count = a(8) >>> 0;
    if (!bits || !w || !count) return success(0, 12);
    const layout = readDibLayout(r, a(10), a(11) >>> 0, { paletteEntries: dibPalette(state, dc) });
    if (!layout) return failure(r, 87, 0, 12);
    if (start >= layout.height) return success(0, 12);
    const topDown = layout.signedHeight < 0;
    if (!topDown) count = Math.min(count, layout.height - start);
    if (count > 4096) return failure(r, 87, 0, 12);
    let sourceY = start + count - sy - h;
    if (sourceY > 0) {
      if (sourceY >= count) return success(topDown ? count : 0, 12);
      if (!topDown) {
        count -= sourceY;
        sourceY = 0;
      }
    }
    const rows = topDown ? Math.min(count, layout.height) : count,
      left = Math.max(0, sx),
      top = Math.max(0, sourceY),
      right = Math.min(layout.width, sx + w),
      bottom = Math.min(rows, sourceY + h);
    if (left >= right || top >= bottom) return success(0, 12);
    r.check(bits, rows * layout.stride);
    const target = dc.surface,
      bounds = clippedBounds(
        target,
        x + left - sx,
        y + top - sourceY,
        x + right - sx,
        y + bottom - sourceY,
        dc,
      ),
      dib = target.dib;
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return success(count, 12);
    if (dib) r.check(dib.bits, dib.layout.stride * dib.layout.height, true);
    const source = new Uint32Array(layout.width * rows),
      source32 =
        layout.depth === 32 && layout.masks.every((v, i) => v === [0xff0000, 0xff00, 0xff][i]);
    for (let row = 0; row < rows; row++)
      for (let xx = 0; xx < layout.width; xx++) {
        const address = bits + row * layout.stride,
          rgb = readDibPixel(r, layout, address, xx),
          alpha = source32 ? r.data[address + xx * 4 + 3] : 0;
        source[(topDown ? row : rows - 1 - row) * layout.width + xx] =
          ((alpha << 24) | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0;
      }
    const rawAlpha =
      target.kind === 'bitmap' &&
      (dib?.layout.depth ?? target.depth ?? (target.monochrome ? 1 : 32)) === 32;
    if (rawAlpha && !dib && !target.iconAlpha)
      target.iconAlpha = new Uint8Array(target.width * target.height);
    let changed = false;
    for (let yy = bounds[1]; yy < bounds[3]; yy++)
      for (let xx = bounds[0]; xx < bounds[2]; xx++) {
        if (!visiblePixel(target, dc, xx, yy)) continue;
        const value = source[(sourceY + yy - y) * layout.width + sx + xx - x],
          rgb = surfaceRgb(target, [(value >>> 16) & 255, (value >>> 8) & 255, value & 255]),
          at = (yy * target.width + xx) * 4;
        target.pixels.set([...rgb, 255], at);
        if (dib) {
          const row = dib.layout.signedHeight < 0 ? yy : target.height - 1 - yy,
            address = dib.bits + row * dib.layout.stride;
          writeDibPixel(r, dib.layout, address, xx, rgb);
          if (rawAlpha) r.data[address + xx * 4 + 3] = value >>> 24;
          dib.dirtyRows.add(row);
        } else if (rawAlpha) target.iconAlpha[yy * target.width + xx] = value >>> 24;
        changed = true;
      }
    if (changed) markGdiDirty(target, ...bounds);
    return success(count, 12);
  };
  return { 'gdi32.dll!SetDIBitsToDevice': transfer };
}
