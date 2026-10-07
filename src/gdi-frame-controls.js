/*!
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * Adapted control geometry from Wine dlls/user32/uitools.c, revision
 * db11d0fe6a169c457e23d007e20404643d067aa8.
 * Copyright 1997 Dimitrie O. Paun, Bertho A. Stultiens.
 * Copyright 2026 WineBrowser contributors (browser raster adapter).
 * License: third_party/wine/COPYING.LIB. Complete editable source is retained
 * here; native SDK pixel captures independently verify the adaptation.
 */
import { nativeBrushBounds, paintRect } from './gdi-raster.js';
import { fillNativePolygons } from './gdi-paths.js';

const INACTIVE = 0x100,
  PUSHED = 0x200,
  CHECKED = 0x400,
  TRANSPARENT = 0x800,
  ADJUST = 0x2000,
  FLAT = 0x4000,
  MONO = 0x8000;
const integer = Math.trunc;

function square(rect) {
  const [left, top, right, bottom] = rect,
    w = right - left,
    h = bottom - top;
  if (w < h) {
    const y = top + integer((h - w) / 2);
    return [left, y, right, y + w];
  }
  const x = left + integer((w - h) / 2);
  return [x, top, x + h, bottom];
}

export function createFrameControlApis({
  stateFor,
  getDc,
  colors,
  success,
  failure,
  strokePolygon,
}) {
  const bounds = (rect) => nativeBrushBounds(...rect);
  const fill = (dc, rect, color) => paintRect(dc.surface, ...bounds(rect), { color }, 'copy', dc);
  // These controls use all four border sides. Keep the native strip order,
  // corner overlaps and integer widths, including degenerate input rectangles.
  const edge = (dc, rect, sunk, flags, soft, width = 1, middle = false) => {
    const [l, t, r, b] = rect;
    let ltOuter, rbOuter, ltInner, rbInner;
    if (flags & MONO) {
      ltOuter = rbOuter = colors[6];
      ltInner = rbInner = colors[5];
    } else if (flags & FLAT) {
      ltOuter = rbOuter = colors[16];
      ltInner = rbInner = colors[15];
    } else if (sunk) {
      ltOuter = colors[soft ? 21 : 16];
      rbOuter = colors[20];
      ltInner = colors[soft ? 16 : 21];
      rbInner = colors[22];
    } else {
      ltOuter = colors[soft ? 20 : 22];
      rbOuter = colors[21];
      ltInner = colors[soft ? 22 : 20];
      rbInner = colors[16];
    }
    fill(dc, [l, t, r, t + width], ltOuter);
    fill(dc, [l, t, l + width, b], ltOuter);
    fill(dc, [l, b - width, r, b], rbOuter);
    fill(dc, [r - width, t, r, b], rbOuter);
    fill(dc, [l + width, t + width, r - width, t + 2 * width], ltInner);
    fill(dc, [l + width, t + width, l + 2 * width, b - width], ltInner);
    fill(dc, [l + width, b - 2 * width, r - width, b - width], rbInner);
    fill(dc, [r - 2 * width, t + width, r - width, b - width], rbInner);
    const inner = [l + 2 * width, t + 2 * width, r - 2 * width, b - 2 * width];
    if (middle) fill(dc, inner, colors[flags & MONO ? 5 : 15]);
    return inner;
  };
  const checkedFill = (dc, rect) => {
    if (colors[20] !== 0xffffff) return fill(dc, rect, colors[20]);
    // Wine's monochrome 55AA brush is combined with the face using PATPAINT.
    // Black bits map to the caller's text color, and white bits map to white.
    const dark = colors[15] | dc.textColor;
    const pixels = new Uint8Array(16);
    for (let i = 0; i < 4; i++) {
      const color = i === 0 || i === 3 ? dark : 0xffffff;
      pixels.set([color & 255, (color >>> 8) & 255, (color >>> 16) & 255, 255], i * 4);
    }
    return paintRect(
      dc.surface,
      ...bounds(rect),
      { pattern: { width: 2, height: 2, pixels } },
      'copy',
      dc,
    );
  };
  const push = (dc, rect, flags) => {
    const sunk = !!(flags & (PUSHED | CHECKED | FLAT));
    const inner = edge(dc, rect, sunk, flags, true);
    if (!(flags & TRANSPARENT)) {
      if (flags & CHECKED) checkedFill(dc, inner);
      else fill(dc, inner, colors[15]);
    }
    return flags & ADJUST ? inner : rect;
  };
  const poly = (dc, points, color, outline = true) => {
    fillNativePolygons(dc, [points], { color });
    if (outline) strokePolygon(dc, points, { color, style: 0, width: 1 }, true);
  };
  const check = (dc, rect, subtype, flags) => {
    const box = square(rect),
      width = Math.max(integer((box[2] - box[0] + 8) / 16), 1);
    // Checkboxes give FLAT precedence over MONO, unlike push buttons.
    const inner = edge(dc, box, true, flags & FLAT ? flags & ~MONO : flags, false, width);
    if (!(flags & TRANSPARENT)) {
      if (flags & (INACTIVE | PUSHED)) fill(dc, inner, colors[15]);
      else if (subtype === 8 && flags & CHECKED) checkedFill(dc, inner);
      else fill(dc, inner, colors[5]);
    }
    if (flags & CHECKED) {
      const [l, t, r, b] = inner,
        w = r - l,
        h = b - t;
      const x = l + integer(w / 3),
        y = b - 1,
        left = l + 1;
      const points = [
        [r - 1, t],
        [r - 1, t + integer(h / 3)],
        [x, y],
        [left, y - (x - left)],
        [left, y - (x - left) - integer(h / 3)],
        [x, y - integer(h / 3)],
      ];
      poly(dc, points, colors[flags & INACTIVE || subtype === 8 ? 16 : 8], false);
    }
    return rect;
  };
  const scroll = (dc, rect, subtype, flags) => {
    const [l, t, r, b] = square(rect),
      diam = Math.min(r - l, b - t) - 2;
    if (subtype === 8) {
      // A size grip fills the complete rectangle; it does not draw borders or
      // adjust the caller's RECT. MONO and FLAT both use black grip stripes.
      const mono = !!(flags & (MONO | FLAT)),
        [left, top, right, bottom] = rect,
        light = colors[mono ? 6 : 20],
        shadow = colors[mono ? 6 : 16],
        d46 = integer((46 * diam) / 750),
        d93 = integer((93 * diam) / 750);
      fill(dc, [left, top, right, bottom], colors[mono ? 5 : 15]);
      for (const scale of [586, 398, 210]) {
        const inset = integer((scale * diam) / 750),
          y = bottom - inset - 1,
          x = right - inset - 1;
        poly(
          dc,
          [
            [right - 1, y],
            [right - 1, y + d46],
            [x + d46, bottom - 1],
            [x, bottom - 1],
          ],
          light,
        );
        poly(
          dc,
          [
            [right - 1, y + d46 + 1 + d93],
            [right - 1, y + d46 + 1],
            [x + d46 + 1, bottom - 1],
            [x + d46 + 1 + d93, bottom - 1],
          ],
          shadow,
        );
      }
      return rect;
    }
    if (subtype === 5) subtype = 1;
    // Tiny scroll controls retain Wine's minimum arrow size.
    const tri = Math.max(2, integer((290 * diam) / 1000) - 1);
    let tip, points;
    if (subtype === 0 || subtype === 1) {
      tip = [
        l + integer((470 * diam) / 1000) + 2,
        subtype === 0
          ? b - (integer((687 * diam) / 1000) + 1)
          : t + integer((687 * diam) / 1000) + 1,
      ];
      const y = tip[1] + (subtype === 0 ? tri : -tri);
      points = [[tip[0] - tri, y], [tip[0] + tri, y], tip];
    } else {
      tip = [
        subtype === 2
          ? r - (integer((687 * diam) / 1000) + 1)
          : l + integer((687 * diam) / 1000) + 1,
        t + integer((470 * diam) / 1000) + 2,
      ];
      const x = tip[0] + (subtype === 2 ? tri : -tri);
      points = [[x, tip[1] - tri], [x, tip[1] + tri], tip];
    }
    let out = rect;
    if (!(flags & (0xff00 & ~ADJUST))) {
      const inner = edge(dc, rect, false, 0, false, 1, true);
      if (flags & ADJUST) out = inner;
    } else out = push(dc, rect, flags);
    if (flags & INACTIVE) poly(dc, points, colors[20]);
    if (flags & INACTIVE || !(flags & PUSHED)) points = points.map(([x, y]) => [x - 1, y - 1]);
    poly(dc, points, colors[flags & INACTIVE ? 16 : 18]);
    return out;
  };
  const menu = (dc, rect, subtype) => {
    fill(dc, rect, 0xffffff);
    const [l, t, r, b] = square(rect),
      diam = Math.min(r - l, b - t);
    let points;
    if (subtype === 0) {
      const i = integer((187 * diam) / 750),
        x = l + integer((468 * diam) / 750),
        y = t + integer((352 * diam) / 750) + 1;
      points = [
        [x - i, y - i],
        [x - i, y + i],
        [x, y],
      ];
    } else {
      const x0 = l + integer((253 * diam) / 1000),
        y0 = t + integer((445 * diam) / 1000);
      const x1 = l + integer((409 * diam) / 1000),
        y1 = y0 + x1 - x0;
      const x2 = l + integer((690 * diam) / 1000),
        y2 = y1 - (x2 - x1),
        thick = integer((3 * diam) / 16);
      points = [
        [x0, y0],
        [x1, y1],
        [x2, y2],
        [x2, y2 + thick],
        [x1, y1 + thick],
        [x0, y0 + thick],
      ];
    }
    poly(dc, points, 0);
    return rect;
  };
  return {
    'user32.dll!DrawFrameControl': (r, a) => {
      const type = a(2) >>> 0,
        flags = a(3) >>> 0,
        subtype = flags & 255;
      if (type < 1 || type > 4) return success(0, 4);
      const supported =
        type === 4
          ? [0, 8, 16].includes(subtype)
          : type === 3
            ? subtype < 4 || subtype === 5 || subtype === 8
            : type === 2
              ? subtype < 2
              : false;
      if (!supported) {
        if (type === 4 && ![1, 2, 4].includes(subtype)) return success(0, 4);
        return failure(r, 120, 0, 4);
      }
      const dc = getDc(r, stateFor(r), a(0));
      if (!dc) return failure(r, 6, 0, 4);
      const pointer = a(1) >>> 0;
      if (!pointer) return failure(r, 87, 0, 4);
      let rect;
      try {
        r.check(
          pointer,
          16,
          !!(flags & ADJUST) && ((type === 3 && subtype !== 8) || (type === 4 && subtype === 16)),
        );
        rect = [0, 4, 8, 12].map((offset) => r.read32(pointer + offset) | 0);
      } catch {
        return failure(r, 87, 0, 4);
      }
      const out =
        type === 4
          ? subtype === 16
            ? push(dc, rect, flags)
            : check(dc, rect, subtype, flags)
          : type === 3
            ? scroll(dc, rect, subtype, flags)
            : menu(dc, rect, subtype);
      if (out !== rect) out.forEach((value, i) => r.write32(pointer + i * 4, value));
      return success(1, 4);
    },
  };
}
