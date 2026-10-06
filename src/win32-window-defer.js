import { setWindowPos } from './win32-window-position.js';

const states = new WeakMap();
const MAX_BATCHES = 64,
  MAX_POSITIONS = 512,
  PUBLIC_FLAGS = 0x67ff;
const result = (value, argc) => ({ result: value >>> 0, argc });
function state(r) {
  let value = states.get(r);
  if (!value) states.set(r, (value = { next: 0x74000000, batches: new Map() }));
  return value;
}
function begin(r, a) {
  const count = a(0) | 0,
    s = state(r);
  if (count < 0) return r.windows.fail(87, 1);
  if (count > MAX_POSITIONS || s.batches.size >= MAX_BATCHES) return r.windows.fail(8, 1);
  const handle = s.next++;
  s.batches.set(handle, { positions: new Map(), parent: undefined });
  return result(handle, 1);
}
function defer(r, a) {
  const s = state(r),
    handle = a(0) >>> 0,
    batch = s.batches.get(handle);
  if (!batch) return r.windows.fail(6, 8);
  const position = Array.from({ length: 7 }, (_, i) => a(i + 1) >>> 0),
    [hwnd, after, , , , , flags] = position,
    window = r.windows.windows.get(hwnd);
  if (!window) return r.windows.fail(1400, 8);
  if (flags & ~PUBLIC_FLAGS) return r.windows.fail(87, 8);
  if (
    !(flags & 4) &&
    ![0, 1, 0xffffffff, 0xfffffffe].includes(after) &&
    r.windows.windows.get(after)?.parentId !== window.parentId
  )
    return r.windows.fail(1400, 8);
  if (batch.parent !== undefined && batch.parent !== window.parentId) return r.windows.fail(87, 8);
  const previous = batch.positions.get(hwnd);
  if (previous) {
    // Wine merges repeat HWNDs in their original insertion order. Geometry and
    // z-order use the last request that does not ignore that component; the
    // suppression flags intersect and show/hide/frame changes accumulate.
    if (!(flags & 4)) previous[1] = after;
    if (!(flags & 2)) [previous[2], previous[3]] = [position[2], position[3]];
    if (!(flags & 1)) [previous[4], previous[5]] = [position[4], position[5]];
    previous[6] &= flags | ~(1 | 2 | 4 | 8 | 16 | 256 | 512);
    previous[6] |= flags & (32 | 64 | 128);
  } else {
    if (batch.positions.size >= MAX_POSITIONS) return r.windows.fail(8, 8);
    batch.positions.set(hwnd, position);
    batch.parent = window.parentId;
  }
  return result(handle, 8);
}
async function end(r, a) {
  const s = state(r),
    handle = a(0) >>> 0,
    batch = s.batches.get(handle);
  if (!batch) return r.windows.fail(6, 1);
  // Consume before entering application procedures, including reentrant End
  // calls. Failures cannot leave an active batch or silently skip a move.
  s.batches.delete(handle);
  for (const position of batch.positions.values()) {
    const moved = await setWindowPos(r, (i) => position[i]);
    if (!moved.result) return result(0, 1);
  }
  return result(1, 1);
}
export const windowDeferApis = {
  'user32.dll!BeginDeferWindowPos': begin,
  'user32.dll!DeferWindowPos': defer,
  'user32.dll!EndDeferWindowPos': end,
};
