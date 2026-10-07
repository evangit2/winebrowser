import { clippedBounds, paintRect } from './gdi-raster.js';

// Directed edge crossings use native integral-row, ceil(x), half-open coverage.
// Only visible destination rows are scanned, even for extreme guest coordinates.
export function fillNativePolygons(dc, polygons, brush) {
  if (!brush || brush.null) return false;
  const edges = [];
  let minY = Infinity,
    maxY = -Infinity;
  for (const points of polygons)
    for (let i = 0; i < points.length; i++) {
      const first = points[i],
        second = points[(i + 1) % points.length];
      if (first[1] === second[1]) continue;
      const [top, bottom] = first[1] < second[1] ? [first, second] : [second, first];
      edges.push({
        top,
        bottom,
        height: bottom[1] - top[1],
        dx: bottom[0] - top[0],
        direction: first[1] < second[1] ? 1 : -1,
      });
      minY = Math.min(minY, top[1]);
      maxY = Math.max(maxY, bottom[1]);
    }
  if (!edges.length) return false;
  const bounds = clippedBounds(dc.surface, 0, minY, dc.surface.width, maxY, dc),
    winding = dc.polyFillMode === 2;
  let changed = false;
  for (let y = bounds[1]; y < bounds[3]; y++) {
    const crossings = [];
    for (const e of edges)
      if (y >= e.top[1] && y < e.bottom[1]) {
        const product = e.dx * (y - e.top[1]);
        let offset;
        if (Number.isSafeInteger(product)) offset = Math.ceil(product / e.height);
        else {
          const numerator = BigInt(e.dx) * BigInt(y - e.top[1]),
            denominator = BigInt(e.height);
          offset = Number(
            numerator / denominator + (numerator > 0n && numerator % denominator ? 1n : 0n),
          );
        }
        crossings.push([e.top[0] + offset, e.direction]);
      }
    crossings.sort((a, b) => a[0] - b[0]);
    let coverage = 0;
    for (let i = 0; i < crossings.length;) {
      const left = crossings[i][0];
      while (i < crossings.length && crossings[i][0] === left) {
        coverage += winding ? crossings[i][1] : 1;
        i++;
      }
      if (i === crossings.length || (winding ? !coverage : !(coverage % 2))) continue;
      if (paintRect(dc.surface, left, y, crossings[i][0], y + 1, brush, 'copy', dc)) changed = true;
    }
  }
  return changed;
}
export function createPathApis({
  stateFor,
  getDc,
  success,
  failure,
  allocateHandle,
  shapePen,
  shapeBrush,
  strokePolygon,
  readPoints,
}) {
  const fillMode = (r, a, set) => {
    const dc = getDc(r, stateFor(r), a(0)),
      argc = set ? 2 : 1;
    if (!dc) return failure(r, 6, 0, argc);
    const previous = dc.polyFillMode ?? 1;
    if (set) {
      const mode = a(1) | 0;
      if (mode !== 1 && mode !== 2) return failure(r, 87, 0, argc);
      dc.polyFillMode = mode;
    }
    return success(previous, argc);
  };
  const grouped = (r, a, filled) => {
    const state = stateFor(r),
      dc = getDc(r, state, a(0));
    if (!dc) return failure(r, 6, 0, 4);
    const groups = a(3) >>> 0;
    if (!groups) return success(1, 4);
    if (groups > 512) return failure(r, 8, 0, 4);
    if (!a(1) || !a(2)) return failure(r, 87, 0, 4);
    r.check(a(2), groups * 4);
    const counts = [];
    let total = 0;
    for (let i = 0; i < groups; i++) {
      const n = r.read32(a(2) + i * 4);
      if (n < 2) return success(0, 4);
      if (n > 1024 || (total += n) > 1024) return failure(r, 8, 0, 4);
      counts.push(n);
    }
    const points = readPoints(r, a(1), total),
      polygons = [];
    let at = 0;
    for (const n of counts) {
      polygons.push(points.slice(at, at + n));
      at += n;
    }
    if (filled) fillNativePolygons(dc, polygons, shapeBrush(r, state, dc));
    const pen = shapePen(r, state, dc);
    for (const p of polygons) strokePolygon(dc, p, pen, filled);
    return success(1, 4);
  };
  const indirectPen = (r, a) => {
    if (!a(0)) return failure(r, 87, 0, 1);
    r.check(a(0), 16);
    const style = r.read32(a(0)),
      width = Math.abs(r.read32(a(0) + 4) | 0),
      color = r.read32(a(0) + 12);
    if (style !== 5 && (style !== 0 || width > 1 || color >>> 16 === 0x10ff))
      return failure(r, 120, 0, 1);
    const state = stateFor(r),
      allocated = allocateHandle(r, state, 1);
    if (!allocated.result) return allocated;
    state.pens.set(allocated.result, {
      kind: 'pen',
      stock: false,
      style,
      width: style === 5 ? 1 : width,
      color: style === 5 ? 0 : color,
    });
    return allocated;
  };
  return {
    'gdi32.dll!GetPolyFillMode': (r, a) => fillMode(r, a, false),
    'gdi32.dll!SetPolyFillMode': (r, a) => fillMode(r, a, true),
    'gdi32.dll!PolyPolygon': (r, a) => grouped(r, a, true),
    'gdi32.dll!PolyPolyline': (r, a) => grouped(r, a, false),
    'gdi32.dll!CreatePenIndirect': indirectPen,
  };
}
