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

// Display surfaces only need a dirty flag. A shared DIB also retains a damage
// rectangle, so one changed pixel doesn't cause a full guest-buffer rewrite.
export function markGdiDirty(surface, left, top, right, bottom) {
  surface.dirty = true;
  if (!surface.dib) return;
  const rect = surface.dib.damage;
  surface.dib.damage = rect
    ? [
        Math.min(rect[0], left),
        Math.min(rect[1], top),
        Math.max(rect[2], right),
        Math.max(rect[3], bottom),
      ]
    : [left, top, right, bottom];
}

function hatchPixel(hatch, x, y) {
  const ix = ((x % 8) + 8) % 8;
  const iy = ((y % 8) + 8) % 8;
  switch (hatch) {
    case 0:
      return iy === 3; // HS_HORIZONTAL
    case 1:
      return ix === 4; // HS_VERTICAL
    case 2:
      return ix === iy; // HS_FDIAGONAL
    case 3:
      return ix + iy === 7; // HS_BDIAGONAL
    case 4:
      return ix === 4 || iy === 3; // HS_CROSS
    case 5:
      return ix === iy || ix + iy === 7;
    default:
      return false;
  }
}

export function clippedBounds(surface, left, top, right, bottom, dc = null) {
  const clip = dc?.clip ?? [0, 0, surface.width, surface.height];
  return [
    Math.max(0, clip[0], Math.min(surface.width, left)),
    Math.max(0, clip[1], Math.min(surface.height, top)),
    Math.min(surface.width, clip[2], Math.max(0, right)),
    Math.min(surface.height, clip[3], Math.max(0, bottom)),
  ];
}

export function visiblePixel(surface, dc, x, y) {
  return (
    x >= 0 &&
    y >= 0 &&
    x < surface.width &&
    y < surface.height &&
    (!dc?.clip || (x >= dc.clip[0] && y >= dc.clip[1] && x < dc.clip[2] && y < dc.clip[3])) &&
    (!dc?.clipRects || dc.clipRects.some(([l, t, r, b]) => x >= l && y >= t && x < r && y < b))
  );
}

/** Native brush blits include the starting pixel when an extent is negative. */
export function nativeBrushBounds(left, top, right, bottom) {
  return [
    right < left ? right + 1 : left,
    bottom < top ? bottom + 1 : top,
    right < left ? left + 1 : right,
    bottom < top ? top + 1 : bottom,
  ];
}

// Four bits encode the (pattern,destination) truth table. Source-dependent
// ternary operations must be rejected by the API before reaching this painter.
function brushRop(pattern, destination, truth) {
  return (
    ((truth & 1 ? ~pattern & ~destination : 0) |
      (truth & 2 ? ~pattern & destination : 0) |
      (truth & 4 ? pattern & ~destination : 0) |
      (truth & 8 ? pattern & destination : 0)) &
    255
  );
}

/** Fill clipped half-open bounds with a brush, invert, or binary brush ROP. */
export function paintRect(surface, left, top, right, bottom, brush, operation = 'copy', dc = null) {
  if (brush?.null || operation === 10) return false;
  const [x1, y1, x2, y2] = clippedBounds(surface, left, top, right, bottom, dc);
  if (x1 >= x2 || y1 >= y2) return false;
  const rgb = surfaceRgb(surface, brush ? colorRefRgb(brush.color ?? 0) : [0, 0, 0]);
  const pixels = surface.pixels;
  const pattern = brush?.pattern,
    originX = dc?.brushOriginX ?? 0,
    originY = dc?.brushOriginY ?? 0;
  const monoForeground =
      pattern?.monochrome && surfaceRgb(surface, colorRefRgb(dc?.textColor ?? 0)),
    monoBackground =
      pattern?.monochrome && surfaceRgb(surface, colorRefRgb(dc?.backgroundColor ?? 0xffffff));
  const startX = pattern && (((x1 - originX) % pattern.width) + pattern.width) % pattern.width;
  let changed = false;
  for (let y = y1; y < y2; y++) {
    let offset = (y * surface.width + x1) * 4;
    const tileStart =
        pattern &&
        ((((y - originY) % pattern.height) + pattern.height) % pattern.height) * pattern.width * 4,
      tileEnd = pattern && tileStart + pattern.width * 4;
    let tileOffset = pattern && tileStart + startX * 4;
    for (let x = x1; x < x2; x++, offset += 4) {
      const at = tileOffset;
      if (pattern) {
        tileOffset += 4;
        if (tileOffset === tileEnd) tileOffset = tileStart;
      }
      if (!visiblePixel(surface, dc, x, y)) continue;
      let r = rgb[0],
        g = rgb[1],
        b = rgb[2];
      if (pattern) {
        // Monochrome pattern brushes always draw both foreground/background,
        // even when the DC's hatch/text background mode is TRANSPARENT.
        if (pattern.monochrome) {
          const color = pattern.pixels[at] ? monoBackground : monoForeground;
          r = color[0];
          g = color[1];
          b = color[2];
        } else {
          r = pattern.pixels[at];
          g = pattern.pixels[at + 1];
          b = pattern.pixels[at + 2];
          if (surface.monochrome) r = g = b = r * 299 + g * 587 + b * 114 >= 128000 ? 255 : 0;
        }
      } else if (brush?.hatch !== undefined) {
        const ink = hatchPixel(brush.hatch, x - originX, y - originY);
        if (!ink && dc?.bkMode === 1) continue;
        const color = surfaceRgb(
          surface,
          colorRefRgb(ink ? brush.color : (dc?.backgroundColor ?? 0xffffff)),
        );
        r = color[0];
        g = color[1];
        b = color[2];
      }
      if (operation === 'invert') {
        r = 255 - pixels[offset];
        g = 255 - pixels[offset + 1];
        b = 255 - pixels[offset + 2];
      } else if (typeof operation === 'number') {
        r = brushRop(r, pixels[offset], operation);
        g = brushRop(g, pixels[offset + 1], operation);
        b = brushRop(b, pixels[offset + 2], operation);
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
  if (changed) markGdiDirty(surface, x1, y1, x2, y2);
  return changed;
}

/** Draw a one-pixel solid/null pen line and report whether pixels changed. */
export function drawLine(surface, x0, y0, x1, y1, pen, dc = null) {
  if (pen.style === 5) return false;
  const horizontal = Math.abs(x1 - x0),
    vertical = Math.abs(y1 - y0),
    xMajor = horizontal > vertical;
  const major = xMajor ? horizontal : vertical,
    minor = xMajor ? vertical : horizontal;
  if (!major) return false;
  const sx = x1 >= x0 ? 1 : -1,
    sy = y1 >= y0 ? 1 : -1;
  const origin = xMajor ? x0 : y0,
    direction = xMajor ? sx : sy;
  const limit = xMajor ? surface.width : surface.height;
  const first = Math.max(0, direction > 0 ? -origin : origin - limit + 1);
  const last = Math.min(major, direction > 0 ? limit - origin : origin + 1);
  // Native tie-breaking is directional. Sampling from the original endpoints
  // retains that phase when the visible portion starts after offscreen pixels.
  const bias = xMajor ? +(y1 <= y0) : +(x1 < x0);
  const rgb = surfaceRgb(surface, colorRefRgb(pen.color));
  let changed = false,
    left = surface.width,
    top = surface.height,
    right = 0,
    bottom = 0;
  for (let step = first; step < last; step++) {
    const numerator = 2 * minor * step + major - 1 + bias;
    const offset = Number.isSafeInteger(numerator)
      ? Math.floor(numerator / (2 * major))
      : Number(
          (2n * BigInt(minor) * BigInt(step) + BigInt(major - 1 + bias)) / (2n * BigInt(major)),
        );
    const x = x0 + sx * (xMajor ? step : offset),
      y = y0 + sy * (xMajor ? offset : step);
    if (!visiblePixel(surface, dc, x, y)) continue;
    const at = (y * surface.width + x) * 4;
    if (
      surface.pixels[at] !== rgb[0] ||
      surface.pixels[at + 1] !== rgb[1] ||
      surface.pixels[at + 2] !== rgb[2] ||
      surface.pixels[at + 3] !== 255
    )
      changed = true;
    surface.pixels.set([...rgb, 255], at);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + 1);
    bottom = Math.max(bottom, y + 1);
  }
  if (changed) markGdiDirty(surface, left, top, right, bottom);
  return changed;
}

/** XOR an alternating one-pixel rectangular focus outline. Dash phase follows
 * the complete perimeter from the top-right corner, including clipped steps.
 * Iterate only the visible portions so extreme guest bounds remain bounded.
 * Return null when a browser-painted control has no readable native pixels. */
export function paintFocusRect(surface, left, top, right, bottom, dc = null) {
  const l = Math.min(left, right),
    t = Math.min(top, bottom),
    r = Math.max(left, right) - 1,
    b = Math.max(top, bottom) - 1;
  if (r < l || b < t) return false;
  const width = r - l,
    height = b - t;
  const edges = [
    [r, t, 0, 1, height, 0],
    [r, b, -1, 0, width, height],
    [l, b, 0, -1, height, height + width],
    [l, t, 1, 0, width, height * 2 + width],
  ];
  const visit = (callback) => {
    for (const [x0, y0, dx, dy, length, phase] of edges) {
      const start = Math.max(
        0,
        dx < 0 ? x0 - surface.width + 1 : dy < 0 ? y0 - surface.height + 1 : dx ? -x0 : -y0,
      );
      const end = Math.min(
        length,
        dx < 0 ? x0 + 1 : dy < 0 ? y0 + 1 : dx ? surface.width - x0 : surface.height - y0,
      );
      for (let step = start + ((start + phase) % 2); step < end; step += 2) {
        const x = x0 + dx * step,
          y = y0 + dy * step;
        if (visiblePixel(surface, dc, x, y) && !callback((y * surface.width + x) * 4)) return false;
      }
    }
    return true;
  };
  if (surface.controlOverlay && !visit((offset) => surface.pixels[offset + 3] === 255)) return null;
  let changed = false;
  visit((offset) => {
    surface.pixels[offset] ^= 255;
    surface.pixels[offset + 1] ^= 255;
    surface.pixels[offset + 2] ^= 255;
    surface.pixels[offset + 3] = 255;
    changed = true;
    return true;
  });
  if (changed) {
    const bounds = clippedBounds(surface, l, t, r + 1, b + 1, dc);
    markGdiDirty(surface, ...bounds);
  }
  return changed;
}
