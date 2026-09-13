/** Pure pixel operations shared by GDI shapes and text. Surfaces are tightly
 * packed opaque RGBA arrays with `{width,height,pixels,dirty,monochrome?}`. */
export function colorRefRgb(color) {
  const value = color >>> 0;
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
}

export function surfaceRgb(surface, rgb) {
  if (!surface.monochrome) return rgb;
  const luminance = rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114;
  const value = luminance >= 128000 ? 255 : 0;
  return [value, value, value];
}

export function rgbColorRef(rgb) {
  return ((rgb[2] << 16) | (rgb[1] << 8) | rgb[0]) >>> 0;
}

function hatchPixel(hatch, x, y) {
  const ix = ((x % 8) + 8) % 8;
  const iy = ((y % 8) + 8) % 8;
  switch (hatch) {
    case 0:
      return iy === 0; // HS_HORIZONTAL
    case 1:
      return ix === 0; // HS_VERTICAL
    case 2:
      return (ix + iy) % 8 === 0; // HS_FDIAGONAL
    case 3:
      return (((ix - iy) % 8) + 8) % 8 === 0; // HS_BDIAGONAL
    case 4:
      return ix === 0 || iy === 0; // HS_CROSS
    case 5:
      return (ix + iy) % 8 === 0 || (((ix - iy) % 8) + 8) % 8 === 0;
    default:
      return false;
  }
}

function bounds(left, top, right, bottom, surface) {
  return [
    Math.max(0, Math.min(surface.width, left)),
    Math.max(0, Math.min(surface.height, top)),
    Math.max(0, Math.min(surface.width, right)),
    Math.max(0, Math.min(surface.height, bottom)),
  ];
}

/** Fill clipped half-open bounds with a solid/hatch brush or invert ROP. */
export function paintRect(surface, left, top, right, bottom, brush, operation = 'copy', dc = null) {
  if (brush?.null && operation === 'copy') return false;
  const [x1, y1, x2, y2] = bounds(left, top, right, bottom, surface);
  if (x1 >= x2 || y1 >= y2) return false;
  const rgb = surfaceRgb(surface, brush ? colorRefRgb(brush.color ?? 0) : [0, 0, 0]);
  const pixels = surface.pixels;
  let changed = false;
  for (let y = y1; y < y2; y++) {
    let offset = (y * surface.width + x1) * 4;
    for (let x = x1; x < x2; x++, offset += 4) {
      let pixelRgb = rgb;
      if (brush?.hatch !== undefined) {
        const ink = hatchPixel(brush.hatch, x, y);
        if (!ink && dc?.bkMode === 1) continue;
        pixelRgb = surfaceRgb(
          surface,
          colorRefRgb(ink ? brush.color : (dc?.backgroundColor ?? 0xffffff)),
        );
      }
      let r = pixelRgb[0],
        g = pixelRgb[1],
        b = pixelRgb[2];
      if (operation === 'invert') {
        r = 255 - pixels[offset];
        g = 255 - pixels[offset + 1];
        b = 255 - pixels[offset + 2];
      }
      if (
        pixels[offset] !== r ||
        pixels[offset + 1] !== g ||
        pixels[offset + 2] !== b ||
        pixels[offset + 3] !== 255
      )
        changed = true;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }
  if (changed) surface.dirty = true;
  return changed;
}

function clipLine(x0, y0, x1, y1, width, height) {
  // Keep work bounded even when guests provide extreme signed coordinates.
  const dx = x1 - x0;
  const dy = y1 - y0;
  let low = 0,
    high = 1;
  for (const [p, q] of [
    [-dx, x0],
    [dx, width - 1 - x0],
    [-dy, y0],
    [dy, height - 1 - y0],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const ratio = q / p;
    if (p < 0) low = Math.max(low, ratio);
    else high = Math.min(high, ratio);
    if (low > high) return null;
  }
  return [
    Math.round(x0 + low * dx),
    Math.round(y0 + low * dy),
    Math.round(x0 + high * dx),
    Math.round(y0 + high * dy),
  ];
}

/** Draw a one-pixel solid/null pen line and report whether pixels changed. */
export function drawLine(surface, x0, y0, x1, y1, pen) {
  if (pen.style === 5) return false;
  const clipped = clipLine(x0, y0, x1, y1, surface.width, surface.height);
  if (!clipped) return false;
  let [x, y, endX, endY] = clipped;
  const dx = Math.abs(endX - x),
    sx = x < endX ? 1 : -1;
  const dy = -Math.abs(endY - y),
    sy = y < endY ? 1 : -1;
  let error = dx + dy;
  const rgb = surfaceRgb(surface, colorRefRgb(pen.color));
  let changed = false;
  const excludeEnd = endX === x1 && endY === y1;
  for (let steps = 0; steps <= Math.max(surface.width, surface.height); steps++) {
    if (excludeEnd && x === endX && y === endY) break;
    const offset = (y * surface.width + x) * 4;
    if (
      surface.pixels[offset] !== rgb[0] ||
      surface.pixels[offset + 1] !== rgb[1] ||
      surface.pixels[offset + 2] !== rgb[2] ||
      surface.pixels[offset + 3] !== 255
    )
      changed = true;
    surface.pixels[offset] = rgb[0];
    surface.pixels[offset + 1] = rgb[1];
    surface.pixels[offset + 2] = rgb[2];
    surface.pixels[offset + 3] = 255;
    if (x === endX && y === endY) break;
    const twiceError = 2 * error;
    if (twiceError >= dy) {
      error += dy;
      x += sx;
    }
    if (twiceError <= dx) {
      error += dx;
      y += sy;
    }
  }
  if (changed) surface.dirty = true;
  return changed;
}
