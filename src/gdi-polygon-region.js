// Integer scan conversion, independently implemented from directed edge
// intersections. An edge contributes ceil(x) at integral y; horizontal edges
// and the bottom vertex are excluded, as required by GDI region coverage.
export const MAX_REGION_POINTS = 4096;
export const MAX_REGION_SCANLINES = 32768;
const MAX_EDGE_WORK = 4 * 1024 * 1024;

export function polygonRegion(polygons, mode, maxRects) {
  const edges = [];
  let work = 0;
  for (const points of polygons) {
    if (points.length < 2) continue;
    for (let i = 0; i < points.length; i++) {
      const first = points[i],
        second = points[(i + 1) % points.length];
      if (first[1] === second[1]) continue;
      const [top, bottom] = first[1] < second[1] ? [first, second] : [second, first];
      const height = bottom[1] - top[1],
        dx = bottom[0] - top[0];
      // Vertical edges can span the whole signed coordinate range without
      // scanning each row. Sloped edges need bounded integer scan conversion.
      if (dx && (height > MAX_REGION_SCANLINES || (work += height) > MAX_EDGE_WORK)) return null;
      edges.push({ top, bottom, height, dx, winding: first[1] < second[1] ? 1 : -1 });
    }
  }
  const events = [...new Set(edges.flatMap((e) => [e.top[1], e.bottom[1]]))].sort((a, b) => a - b);
  const output = [];
  let previous = [];
  for (let event = 0; event + 1 < events.length; event++) {
    const start = events[event],
      end = events[event + 1];
    const active = edges.filter((e) => e.top[1] <= start && e.bottom[1] >= end);
    const step = active.some((e) => e.dx) ? 1 : end - start;
    for (let y = start; y < end; y += step) {
      const crossings = active
        .map((e) => [e.top[0] + Math.ceil((e.dx * (y - e.top[1])) / e.height), e.winding])
        .sort((a, b) => a[0] - b[0]);
      let coverage = 0;
      const intervals = [];
      for (let i = 0; i < crossings.length;) {
        const left = crossings[i][0];
        while (i < crossings.length && crossings[i][0] === left) {
          coverage += mode === 1 ? 1 : crossings[i][1];
          i++;
        }
        if (i === crossings.length || (mode === 1 ? !(coverage % 2) : !coverage)) continue;
        const right = crossings[i][0];
        if (intervals.at(-1)?.[1] === left) intervals.at(-1)[1] = right;
        else intervals.push([left, right]);
      }
      if (
        previous.length === intervals.length &&
        intervals.every(
          ([l, r], i) => previous[i][0] === l && previous[i][2] === r && previous[i][3] === y,
        )
      ) {
        for (const piece of previous) piece[3] = y + step;
      } else {
        previous = intervals.map(([l, r]) => [l, y, r, y + step]);
        output.push(...previous);
        if (output.length > maxRects) return null;
      }
    }
  }
  return output;
}
