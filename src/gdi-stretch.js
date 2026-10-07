import { readDibLayout, readDibPixel, writeDibPixel } from './gdi-dib.js';
import { clippedBounds, visiblePixel, markGdiDirty, surfaceRgb } from './gdi-raster.js';
const SRCCOPY = 0x00cc0020;
const operations = new Map([
  [SRCCOPY, (s) => s],
  [0x00ee0086, (s, d) => s | d],
  [0x008800c6, (s, d) => s & d],
  [0x00660046, (s, d) => s ^ d],
  [0x00330008, (s) => ~s],
  [0x00000042, () => 0],
  [0x00ff0062, () => 0xffffffff],
  [0x00550009, (s, d) => ~d],
]);
const standard32 = (layout) =>
  layout.depth === 32 && layout.masks.every((mask, i) => mask === [0xff0000, 0xff00, 0xff][i]);
const pack = (rgb, alpha = 0) => ((alpha << 24) | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) >>> 0;
const rgbOf = (value) => [(value >>> 16) & 255, (value >>> 8) & 255, value & 255];
function group(phase, source, destination) {
  if (source > destination)
    return [
      Math.ceil((phase * source) / destination),
      Math.ceil(((phase + 1) * source) / destination),
    ];
  const at = Math.floor(((phase + 0.5) * source) / destination);
  return [at, at + 1];
}

export function createStretchDibApis({ stateFor, getDc, dibPalette, success, failure }) {
  const stretch = (r, a) => {
    const state = stateFor(r),
      dc = getDc(r, state, a(0));
    if (!dc) return failure(r, 6, 0, 13);
    let [x, y, w, h, sx, sy, sw, sh] = Array.from({ length: 8 }, (_, i) => a(i + 1) | 0);
    const bits = a(9),
      usage = a(11) >>> 0,
      rop = a(12) >>> 0,
      operation = operations.get(rop);
    if (!operation) return failure(r, 120, 0, 13);
    const layout = readDibLayout(r, a(10), usage, { paletteEntries: dibPalette(state, dc) });
    if (!layout) return failure(r, 87, 0, 13);
    if (!bits) return success(0, 13);
    if (!sw || !sh) return success(0, 13);
    if (Math.abs(sw) > 4096 || Math.abs(sh) > 4096) return failure(r, 87, 0, 13);
    const result = rop === SRCCOPY ? layout.height : layout.signedHeight;
    if (!w || !h) return success(result, 13);
    // Non-copy single-pixel transfers exclude the far source edge, as native GDI does.
    if (rop !== SRCCOPY) {
      if (w === 1 && sw > 1) sw--;
      if (h === 1 && sh > 1) sh--;
    }
    const aw = Math.abs(w),
      ah = Math.abs(h),
      asw = Math.abs(sw),
      ash = Math.abs(sh),
      mode = dc.stretchMode ?? 1,
      fromOrigin = sx === 0 && sy === 0 && sw === w && sh === h;
    let baseY =
      layout.signedHeight < 0 && (rop !== SRCCOPY || fromOrigin) ? sy : layout.height - sy - sh;
    if (baseY >= layout.height && baseY + sh + 1 < layout.height) baseY = layout.height - 1;
    else if (baseY > 0 && baseY + sh + 1 < 0) baseY = -sh - 1;
    const sourceBounds = [
      Math.max(0, sw < 0 ? sx + sw + 1 : sx),
      Math.max(0, sh < 0 ? baseY + sh + 1 : baseY),
      Math.min(layout.width, sw < 0 ? sx + 1 : sx + sw),
      Math.min(layout.height, sh < 0 ? baseY + 1 : baseY + sh),
    ];
    if (sourceBounds[0] >= sourceBounds[2] || sourceBounds[1] >= sourceBounds[3])
      return success(0, 13);
    r.check(bits, layout.stride * layout.height);
    const target = dc.surface,
      bounds = clippedBounds(
        target,
        w < 0 ? x + w + 1 : x,
        h < 0 ? y + h + 1 : y,
        w < 0 ? x + 1 : x + w,
        h < 0 ? y + 1 : y + h,
        dc,
      );
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) return success(result, 13);
    if (target.controlOverlay && [0x00ee0086, 0x008800c6, 0x00660046, 0x00550009].includes(rop)) {
      for (let yy = bounds[1]; yy < bounds[3]; yy++)
        for (let xx = bounds[0]; xx < bounds[2]; xx++)
          if (
            visiblePixel(target, dc, xx, yy) &&
            target.pixels[(yy * target.width + xx) * 4 + 3] !== 255
          )
            return failure(r, 120, 0, 13);
    }
    const dib = target.dib;
    if (dib) r.check(dib.bits, dib.layout.stride * dib.layout.height, true);
    // Snapshot every source pixel before writes: source bits may alias the selected DIB.
    const source = new Uint32Array(layout.width * layout.height);
    for (let row = 0; row < layout.height; row++) {
      const address = bits + row * layout.stride,
        yy = layout.signedHeight < 0 ? row : layout.height - 1 - row;
      for (let xx = 0; xx < layout.width; xx++)
        source[yy * layout.width + xx] = pack(
          readDibPixel(r, layout, address, xx),
          standard32(layout) ? r.data[address + xx * 4 + 3] : 0,
        );
    }
    if (mode === 4 && (asw !== aw || ash !== ah)) {
      // HALFTONE fits the visible source rectangle to the visible destination
      // bounding box, including the native one-pixel visibility margin.
      for (let axis = 0; axis < 2; axis++) {
        const start = axis ? baseY : sx,
          span = axis ? sh : sw,
          dstStart = axis ? y : x,
          dstSpan = axis ? h : w;
        const mapped = [sourceBounds[axis], sourceBounds[axis + 2]].map(
          (edge) => dstStart + Math.trunc(((edge - start - (span < 0 ? 1 : 0)) * dstSpan) / span),
        );
        bounds[axis] = Math.max(bounds[axis], Math.min(...mapped) - 1);
        bounds[axis + 2] = Math.min(bounds[axis + 2], Math.max(...mapped) + 1);
        const back = [bounds[axis], bounds[axis + 2]].map(
          (edge) =>
            start + Math.trunc(((edge - dstStart - (dstSpan < 0 ? 1 : 0)) * span) / dstSpan),
        );
        sourceBounds[axis] = Math.max(sourceBounds[axis], Math.min(...back) - 1);
        sourceBounds[axis + 2] = Math.min(sourceBounds[axis + 2], Math.max(...back) + 1);
      }
      if (
        bounds[0] >= bounds[2] ||
        bounds[1] >= bounds[3] ||
        sourceBounds[0] >= sourceBounds[2] ||
        sourceBounds[1] >= sourceBounds[3]
      )
        return success(result, 13);
    }
    const sample = (ix, iy) => {
      const xx = sx + (sw < 0 ? -ix : ix),
        yy = baseY + (sh < 0 ? -iy : iy);
      return xx < 0 || yy < 0 || xx >= layout.width || yy >= layout.height
        ? null
        : source[yy * layout.width + xx];
    };
    const scaled = (px, py) => {
      if (mode === 4 && (asw !== aw || ash !== ah)) {
        const coordinate = (axis, phase, mirrored) => {
          const lo = sourceBounds[axis],
            hi = sourceBounds[axis + 2],
            size = bounds[axis + 2] - bounds[axis],
            offset = (phase * (hi - lo)) / size,
            value = mirrored ? hi - 1 - offset : lo + offset;
          return Math.max(lo, Math.min(hi - 1, value));
        };
        const fx = coordinate(0, px, sw < 0 !== w < 0),
          fy = coordinate(1, py, sh < 0 !== h < 0),
          ix = Math.floor(fx),
          iy = Math.floor(fy),
          rx = fx - ix,
          ry = fy - iy;
        const at = (xx, yy) => source[yy * layout.width + xx],
          nextX = Math.min(sourceBounds[2] - 1, ix + 1),
          nextY = Math.min(sourceBounds[3] - 1, iy + 1),
          values = [at(ix, iy), at(nextX, iy), at(ix, nextY), at(nextX, nextY)];
        // Native interpolation rounds each horizontal row before the vertical blend.
        const interpolate = (a, b, fraction) => a + Math.floor((b - a) * fraction + 0.5);
        const rgb = [16, 8, 0].map((shift) => {
          const channels = values.map((value) => (value >>> shift) & 255);
          return interpolate(
            interpolate(channels[0], channels[1], rx),
            interpolate(channels[2], channels[3], rx),
            ry,
          );
        });
        return pack(rgb);
      }
      const gx = group(px, asw, aw),
        gy = group(py, ash, ah);
      if (mode >= 3) return sample(gx[1] - 1, gy[0]);
      let value = mode === 1 ? 0xffffffff : 0,
        valid = false;
      for (let yy = gy[0]; yy < gy[1]; yy++)
        for (let xx = gx[0]; xx < gx[1]; xx++) {
          const pixel = sample(xx, yy);
          if (pixel === null) continue;
          value = mode === 1 ? value & pixel : value | pixel;
          valid = true;
        }
      return valid ? value >>> 0 : null;
    };
    const rawAlpha =
      target.kind === 'bitmap' &&
      (dib?.layout.depth ?? target.depth ?? (target.monochrome ? 1 : 32)) === 32;
    if (rawAlpha && !dib && !target.iconAlpha)
      target.iconAlpha = new Uint8Array(target.width * target.height);
    let changed = false;
    for (let yy = bounds[1]; yy < bounds[3]; yy++)
      for (let xx = bounds[0]; xx < bounds[2]; xx++) {
        if (!visiblePixel(target, dc, xx, yy)) continue;
        const half = mode === 4 && (asw !== aw || ash !== ah);
        const pixel = scaled(
          half ? xx - bounds[0] : w < 0 ? x - xx : xx - x,
          half ? yy - bounds[1] : h < 0 ? y - yy : yy - y,
        );
        if (pixel === null) continue;
        const at = (yy * target.width + xx) * 4,
          row = dib ? (dib.layout.signedHeight < 0 ? yy : target.height - 1 - yy) : 0,
          address = dib ? dib.bits + row * dib.layout.stride : 0,
          oldAlpha = rawAlpha
            ? dib
              ? r.data[address + xx * 4 + 3]
              : target.iconAlpha[yy * target.width + xx]
            : 0,
          previous = pack(target.pixels.subarray(at, at + 3), oldAlpha),
          value = operation(pixel, previous) >>> 0,
          rgb = surfaceRgb(target, rgbOf(value)),
          alpha = value >>> 24;
        target.pixels.set([...rgb, 255], at);
        if (dib) {
          writeDibPixel(r, dib.layout, address, xx, rgb);
          if (rawAlpha) r.data[address + xx * 4 + 3] = alpha;
          dib.dirtyRows.add(row);
        } else if (rawAlpha) target.iconAlpha[yy * target.width + xx] = alpha;
        changed = true;
      }
    if (changed) markGdiDirty(target, ...bounds);
    return success(result, 13);
  };
  return {
    'gdi32.dll!StretchDIBits': stretch,
    'gdi32.dll!SetStretchBltMode': (r, a) => {
      const dc = getDc(r, stateFor(r), a(0)),
        mode = a(1) | 0;
      if (!dc) return failure(r, 6, 0, 2);
      if (mode < 1 || mode > 4) return failure(r, 87, 0, 2);
      const old = dc.stretchMode ?? 1;
      dc.stretchMode = mode;
      return success(old, 2);
    },
    'gdi32.dll!GetStretchBltMode': (r, a) => {
      const dc = getDc(r, stateFor(r), a(0));
      return dc ? success(dc.stretchMode ?? 1, 1) : failure(r, 6, 0, 1);
    },
  };
}
