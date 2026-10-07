// Original WineBrowser contributors, MIT. Classic scrollbar raster and shared geometry.
// The separately licensed frame painter is LGPL-2.1-or-later; its source is retained.
import { createFrameControlPainter } from './gdi-frame-controls.js';
import { paintRect, drawLine } from './gdi-raster.js';
import { scrollbarGeometry } from './scrollbar-geometry.js';
const colors = [];
for (const [i, color] of [
  [5, 0xffffff],
  [6, 0],
  [8, 0],
  [15, 0xc0c0c0],
  [16, 0x808080],
  [18, 0],
  [20, 0xffffff],
  [21, 0x404040],
  [22, 0xe3e3e3],
])
  colors[i] = color;
const paint = createFrameControlPainter({
  colors,
  strokePolygon(dc, points, pen, close) {
    for (let i = 0; i < points.length - 1; i++)
      drawLine(dc.surface, ...points[i], ...points[i + 1], pen, dc);
    if (close) drawLine(dc.surface, ...points.at(-1), ...points[0], pen, dc);
  },
});
export function renderScrollbar(width, height, model) {
  const surface = { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
  const dc = { surface, fillMode: 1 };
  const vertical = model.vertical;
  const length = vertical ? height : width,
    cross = vertical ? width : height;
  const geometry = scrollbarGeometry(length, model, model.disabled);
  const rect = (start, end) => (vertical ? [0, start, cross, end] : [start, 0, end, cross]);
  const pattern = {
    width: 2,
    height: 2,
    pixels: new Uint8ClampedArray([
      192, 192, 192, 255, 255, 255, 255, 255, 255, 255, 255, 255, 192, 192, 192, 255,
    ]),
  };
  paintRect(surface, 0, 0, width, height, { pattern }, 'copy', dc);
  const subtype = vertical ? 0 : 2;
  for (let side = 0; side < 2; side++) {
    const flags =
      (subtype + side) |
      (model.disabled & (1 << side) ? 0x100 : 0) |
      (model.pressed === side ? 0x200 : 0);
    paint(dc, rect(side ? length - geometry.arrow : 0, side ? length : geometry.arrow), 3, flags);
  }
  // Native painting covers arrow-glyph spill in the track of tiny controls.
  paintRect(surface, ...rect(geometry.arrow, length - geometry.arrow), { pattern }, 'copy', dc);
  if (geometry.thumb) paint.edge(dc, rect(geometry.top, geometry.bottom), false, 0, false, 1, true);
  return surface.pixels;
}
