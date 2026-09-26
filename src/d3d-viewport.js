export const defaultViewport = (width, height) => ({ x: 0, y: 0, width, height, minZ: 0, maxZ: 1 });
const uint = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

export function validRegion(v, width, height) {
  return (
    !!v &&
    [v.x, v.y, v.width, v.height].every(uint) &&
    v.x + v.width <= width &&
    v.y + v.height <= height
  );
}

export function validViewport(v, width, height) {
  return (
    validRegion(v, width, height) &&
    Number.isFinite(v.minZ) &&
    Number.isFinite(v.maxZ) &&
    v.minZ >= 0 &&
    v.maxZ <= 1 &&
    v.minZ <= v.maxZ
  );
}

export function setViewport(r, pointer, state) {
  try {
    r.check(pointer, 24);
  } catch {
    return 0x8876086c;
  }
  const v = {
    x: r.read32(pointer),
    y: r.read32(pointer + 4),
    width: r.read32(pointer + 8),
    height: r.read32(pointer + 12),
    minZ: r.view.getFloat32(pointer + 16, true),
    maxZ: r.view.getFloat32(pointer + 20, true),
  };
  if (!validViewport(v, state.width, state.height)) return 0x8876086c;
  state.viewport = v;
  return 0;
}

export function getViewport(r, pointer, state) {
  try {
    r.check(pointer, 24, true);
  } catch {
    return 0x8876086c;
  }
  const v = state.viewport;
  [v.x, v.y, v.width, v.height].forEach((n, i) => r.write32(pointer + i * 4, n));
  const depth = new Uint32Array(Float32Array.of(v.minZ, v.maxZ).buffer);
  r.write32(pointer + 16, depth[0]);
  r.write32(pointer + 20, depth[1]);
  return 0;
}

export function clearRegions(r, pointer, count, v) {
  if (!!pointer !== !!count) return null;
  if (count > 256) throw Error('D3D clear rectangle limit exceeded');
  if (!count) return [{ x: v.x, y: v.y, width: v.width, height: v.height }];
  try {
    r.check(pointer, count * 16);
  } catch {
    return null;
  }
  const regions = [];
  for (let i = 0; i < count; i++) {
    const p = pointer + i * 16;
    const x = Math.max(v.x, r.read32(p) | 0),
      y = Math.max(v.y, r.read32(p + 4) | 0);
    const right = Math.min(v.x + v.width, r.read32(p + 8) | 0);
    const bottom = Math.min(v.y + v.height, r.read32(p + 12) | 0);
    if (right > x && bottom > y) regions.push({ x, y, width: right - x, height: bottom - y });
  }
  return regions;
}
