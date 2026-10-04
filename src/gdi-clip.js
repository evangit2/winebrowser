// Disjoint rectangular pieces of a GDI clip region, in client coordinates.
export function clipPieces(dc, surface) {
  return dc.clipRects ?? [dc.clip ?? [0, 0, surface.width, surface.height]];
}
export function normalizeClip(pieces) {
  const result = pieces.filter(([l, t, r, b]) => r > l && b > t).map((rect) => rect.slice());
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < result.length && !merged; i++)
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i],
          b = result[j];
        if (
          (a[0] === b[0] && a[2] === b[2] && (a[3] === b[1] || b[3] === a[1])) ||
          (a[1] === b[1] && a[3] === b[3] && (a[2] === b[0] || b[2] === a[0]))
        ) {
          result[i] = [
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.max(a[2], b[2]),
            Math.max(a[3], b[3]),
          ];
          result.splice(j, 1);
          merged = true;
          break;
        }
      }
  }
  return result;
}
export function setClipPieces(dc, pieces) {
  dc.clipRects = normalizeClip(pieces);
  dc.clip = dc.clipRects.length
    ? [
        Math.min(...dc.clipRects.map((r) => r[0])),
        Math.min(...dc.clipRects.map((r) => r[1])),
        Math.max(...dc.clipRects.map((r) => r[2])),
        Math.max(...dc.clipRects.map((r) => r[3])),
      ]
    : [0, 0, 0, 0];
  return dc.clipRects.length > 1 ? 3 : dc.clipRects.length ? 2 : 1; // COMPLEX/SIMPLE/NULLREGION
}
export function subtractClip(pieces, [l, t, r, b]) {
  const result = [];
  for (const [x0, y0, x1, y1] of pieces) {
    const left = Math.max(l, x0),
      top = Math.max(t, y0),
      right = Math.min(r, x1),
      bottom = Math.min(b, y1);
    if (right <= left || bottom <= top) {
      result.push([x0, y0, x1, y1]);
      continue;
    }
    result.push(
      [x0, y0, x1, top],
      [x0, bottom, x1, y1],
      [x0, top, left, bottom],
      [right, top, x1, bottom],
    );
  }
  return normalizeClip(result);
}
export function intersectClip(pieces, [l, t, r, b]) {
  return normalizeClip(
    pieces.map(([x0, y0, x1, y1]) => [
      Math.max(l, x0),
      Math.max(t, y0),
      Math.min(r, x1),
      Math.min(b, y1),
    ]),
  );
}
