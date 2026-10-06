import { clipPieces, setClipPieces } from './gdi-clip.js';
import { paintRect } from './gdi-raster.js';

export const MAX_REGION_RECTS = 256;
const validCoordinate = (value) => value >= -0x4000000 && value < 0x4000000;
const ordered = ([l, t, r, b]) => [Math.min(l, r), Math.min(t, b), Math.max(l, r), Math.max(t, b)];
const nonempty = ([l, t, r, b]) => l < r && t < b;
const overlaps = (a, b) =>
  Math.max(a[0], b[0]) < Math.min(a[2], b[2]) && Math.max(a[1], b[1]) < Math.min(a[3], b[3]);
const type = (pieces) => (pieces.length > 1 ? 3 : pieces.length ? 2 : 1);
const bounds = (pieces) =>
  pieces.length
    ? [
        Math.min(...pieces.map((p) => p[0])),
        Math.min(...pieces.map((p) => p[1])),
        Math.max(...pieces.map((p) => p[2])),
        Math.max(...pieces.map((p) => p[3])),
      ]
    : [0, 0, 0, 0];
const shifted = (pieces, x, y) => pieces.map(([l, t, r, b]) => [l + x, t + y, r + x, b + y]);

// Canonical ordered bands make shape equality and RGNDATA independent of the
// original decomposition. Sweep coverage from both inputs, merge adjacent
// intervals and extend identical consecutive bands without overlapping pixels.
export function combineRegions(first, second, mode) {
  const a = first.filter(nonempty),
    b = second.filter(nonempty);
  const ys = [...new Set([...a, ...b].flatMap((p) => [p[1], p[3]]))].sort((x, y) => x - y);
  const output = [];
  let previous = [];
  for (let row = 0; row + 1 < ys.length; row++) {
    const top = ys[row],
      bottom = ys[row + 1],
      edges = [];
    for (const [set, index] of [
      [a, 0],
      [b, 1],
    ])
      for (const [l, t, r, end] of set)
        if (t <= top && end >= bottom) edges.push([l, index, 1], [r, index, -1]);
    edges.sort((x, y) => x[0] - y[0]);
    const coverage = [0, 0],
      intervals = [];
    for (let i = 0; i < edges.length;) {
      const left = edges[i][0];
      while (i < edges.length && edges[i][0] === left) {
        coverage[edges[i][1]] += edges[i][2];
        i++;
      }
      if (i === edges.length) break;
      const right = edges[i][0],
        insideA = coverage[0] > 0,
        insideB = coverage[1] > 0;
      const inside =
        mode === 1
          ? insideA && insideB
          : mode === 2
            ? insideA || insideB
            : mode === 3
              ? insideA !== insideB
              : insideA && !insideB;
      if (inside) {
        const last = intervals.at(-1);
        if (last?.[1] === left) last[1] = right;
        else intervals.push([left, right]);
      }
    }
    if (
      intervals.length === previous.length &&
      intervals.every(
        ([l, r], i) => previous[i][0] === l && previous[i][2] === r && previous[i][3] === top,
      )
    ) {
      for (const piece of previous) piece[3] = bottom;
    } else {
      previous = intervals.map(([l, r]) => [l, top, r, bottom]);
      output.push(...previous);
      if (output.length > MAX_REGION_RECTS) return null;
    }
  }
  return output;
}
const canonical = (pieces) => combineRegions(pieces, [], 2);

export function createRegionApis({
  stateFor,
  getDc,
  getBrush,
  readRect,
  allocateHandle,
  success,
  failure,
}) {
  const fail = (r, error, argc, value = 0) => failure(r, error, value, argc);
  const lookup = (r, handle) => stateFor(r).regions.get(handle >>> 0);
  const allocate = (r, pieces, argc) => {
    if (!pieces) return fail(r, 8, argc);
    const state = stateFor(r),
      handle = allocateHandle(r, state, argc);
    if (handle.result) state.regions.set(handle.result, { pieces });
    return handle;
  };
  const makeRect = (r, rect, argc) => {
    if (!rect || !rect.every(validCoordinate)) return fail(r, 87, argc);
    const piece = ordered(rect);
    return allocate(r, nonempty(piece) ? [piece] : [], argc);
  };
  const select = (r, a, extended) => {
    const argc = extended ? 3 : 2,
      dc = getDc(r, stateFor(r), a(0));
    if (!dc) return fail(r, 6, argc);
    const mode = extended ? a(2) >>> 0 : 5;
    if (mode < 1 || mode > 5) return fail(r, 87, argc);
    if (!a(1)) {
      if (mode !== 5) return fail(r, 87, argc);
      delete dc.clip;
      delete dc.clipRects;
      return success(2, argc);
    }
    const region = lookup(r, a(1));
    if (!region) return fail(r, 6, argc);
    const pieces =
      mode === 5 ? region.pieces : combineRegions(clipPieces(dc, dc.surface), region.pieces, mode);
    if (!pieces) return fail(r, 8, argc);
    return success(setClipPieces(dc, pieces), argc);
  };
  const draw = (r, a, frame) => {
    const argc = frame ? 5 : 3,
      state = stateFor(r),
      dc = getDc(r, state, a(0)),
      region = lookup(r, a(1)),
      brush = getBrush(state, a(2));
    if (!dc || !region || !brush) return fail(r, 6, argc);
    let pieces = region.pieces;
    if (frame) {
      if (!pieces.length) return success(0, argc);
      const x = Math.abs(a(3) | 0),
        y = Math.abs(a(4) | 0);
      if (x >= 0x4000000 || y >= 0x4000000) return fail(r, 87, argc);
      // Wine subtracts the intersection with four axial translations. Shared
      // internal rectangle boundaries therefore never become frame edges.
      let inner = pieces;
      for (const [dx, dy] of [
        [-x, 0],
        [x, 0],
        [0, -y],
        [0, y],
      ]) {
        inner = combineRegions(inner, shifted(pieces, dx, dy), 1);
        if (!inner) return fail(r, 8, argc);
      }
      pieces = combineRegions(pieces, inner, 4);
      if (!pieces) return fail(r, 8, argc);
    }
    for (const [l, t, right, bottom] of pieces)
      paintRect(dc.surface, l, t, right, bottom, brush, 'copy', dc);
    return success(1, argc);
  };
  return {
    'gdi32.dll!CreateRectRgn': (r, a) =>
      makeRect(
        r,
        [0, 1, 2, 3].map((i) => a(i) | 0),
        4,
      ),
    'gdi32.dll!CreateRectRgnIndirect': (r, a) => makeRect(r, a(0) ? readRect(r, a(0)) : null, 1),
    'gdi32.dll!SetRectRgn': (r, a) => {
      const region = lookup(r, a(0)),
        rect = [1, 2, 3, 4].map((i) => a(i) | 0);
      if (!region) return fail(r, 6, 5);
      if (!rect.every(validCoordinate)) return fail(r, 87, 5);
      const piece = ordered(rect);
      region.pieces = nonempty(piece) ? [piece] : [];
      return success(1, 5);
    },
    'gdi32.dll!CombineRgn': (r, a) => {
      const dest = lookup(r, a(0)),
        first = lookup(r, a(1)),
        mode = a(3) >>> 0;
      if (mode < 1 || mode > 5) return fail(r, 87, 4);
      const second = mode === 5 ? null : lookup(r, a(2));
      if (!dest || !first || (mode !== 5 && !second)) return fail(r, 6, 4);
      const pieces =
        mode === 5
          ? first.pieces.map((p) => p.slice())
          : combineRegions(first.pieces, second.pieces, mode);
      if (!pieces) return fail(r, 8, 4);
      dest.pieces = pieces;
      return success(type(pieces), 4);
    },
    'gdi32.dll!GetRgnBox': (r, a) => {
      const region = lookup(r, a(0));
      if (!region) return fail(r, 6, 2);
      if (!a(1)) return fail(r, 87, 2);
      r.check(a(1), 16, true);
      bounds(region.pieces).forEach((v, i) => r.write32(a(1) + i * 4, v));
      return success(type(region.pieces), 2);
    },
    'gdi32.dll!OffsetRgn': (r, a) => {
      const region = lookup(r, a(0));
      if (!region) return fail(r, 6, 3);
      const pieces = shifted(region.pieces, a(1) | 0, a(2) | 0);
      if (!pieces.every((p) => p.every(validCoordinate))) return fail(r, 87, 3);
      region.pieces = pieces;
      return success(type(pieces), 3);
    },
    'gdi32.dll!EqualRgn': (r, a) => {
      const first = lookup(r, a(0)),
        second = lookup(r, a(1));
      if (!first || !second) return fail(r, 6, 2);
      return success(
        +(
          first.pieces.length === second.pieces.length &&
          first.pieces.every((p, i) => p.every((v, j) => v === second.pieces[i][j]))
        ),
        2,
      );
    },
    'gdi32.dll!PtInRegion': (r, a) => {
      const region = lookup(r, a(0));
      if (!region) return fail(r, 6, 3);
      const x = a(1) | 0,
        y = a(2) | 0;
      return success(
        +region.pieces.some(([l, t, right, bottom]) => x >= l && y >= t && x < right && y < bottom),
        3,
      );
    },
    'gdi32.dll!RectInRegion': (r, a) => {
      const region = lookup(r, a(0)),
        rect = a(1) ? readRect(r, a(1)) : null;
      if (!region) return fail(r, 6, 2);
      if (!rect) return fail(r, 87, 2);
      return success(+region.pieces.some((p) => overlaps(p, ordered(rect))), 2);
    },
    'gdi32.dll!SelectClipRgn': (r, a) => select(r, a, false),
    'gdi32.dll!ExtSelectClipRgn': (r, a) => select(r, a, true),
    'gdi32.dll!GetClipRgn': (r, a) => {
      const dc = getDc(r, stateFor(r), a(0)),
        region = lookup(r, a(1));
      if (!dc || !region) return fail(r, 6, 2, 0xffffffff);
      if (!dc.clip) return success(0, 2);
      const pieces = canonical(clipPieces(dc, dc.surface));
      if (!pieces) return fail(r, 8, 2, 0xffffffff);
      region.pieces = pieces;
      return success(1, 2);
    },
    'gdi32.dll!RectVisible': (r, a) => {
      const dc = getDc(r, stateFor(r), a(0)),
        rect = a(1) ? readRect(r, a(1)) : null;
      if (!dc) return fail(r, 6, 2);
      if (!rect) return fail(r, 87, 2);
      const [l, t, right, bottom] = ordered(rect),
        visible = [
          Math.max(0, l),
          Math.max(0, t),
          Math.min(dc.surface.width, right),
          Math.min(dc.surface.height, bottom),
        ];
      return success(+clipPieces(dc, dc.surface).some((p) => overlaps(p, visible)), 2);
    },
    'gdi32.dll!FillRgn': (r, a) => draw(r, a, false),
    'gdi32.dll!FrameRgn': (r, a) => draw(r, a, true),
    'gdi32.dll!GetRegionData': (r, a) => {
      const region = lookup(r, a(0));
      if (!region) return fail(r, 6, 3);
      const size = 32 + region.pieces.length * 16,
        out = a(2);
      if (!out) return success(size, 3);
      if (a(1) >>> 0 < size) return fail(r, 122, 3);
      r.check(out, size, true);
      [
        32,
        1,
        region.pieces.length,
        size - 32,
        ...bounds(region.pieces),
        ...region.pieces.flat(),
      ].forEach((v, i) => r.write32(out + i * 4, v));
      return success(size, 3);
    },
    'gdi32.dll!ExtCreateRegion': (r, a) => {
      const count = a(1) >>> 0,
        pointer = a(2);
      if (!pointer || count < 32) return fail(r, 87, 3);
      r.check(pointer, 32);
      const n = r.read32(pointer + 8);
      if (
        r.read32(pointer) < 32 ||
        r.read32(pointer + 4) !== 1 ||
        n > 1024 ||
        n > Math.floor((count - 32) / 16)
      )
        return fail(r, 87, 3);
      if (a(0)) {
        r.check(a(0), 24);
        const matrix = Array.from({ length: 6 }, (_, i) => r.view.getFloat32(a(0) + i * 4, true));
        if (matrix.some((v, i) => v !== [1, 0, 0, 1, 0, 0][i])) return fail(r, 120, 3);
      }
      r.check(pointer + 32, n * 16);
      const pieces = Array.from({ length: n }, (_, i) => readRect(r, pointer + 32 + i * 16));
      if (!pieces.every((p) => p && p.every(validCoordinate))) return fail(r, 87, 3);
      return allocate(r, canonical(pieces), 3);
    },
  };
}
