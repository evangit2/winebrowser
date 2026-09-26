// The graph keeps its thunk Map across unloads and rollback. Track allocation
// against that Map, not its current size, so a removed address is never reused.
const nextByMap = new WeakMap();
// Host thunks occupy their own address range so the dispatcher can skip the
// thunk lookup for ordinary guest and mapped-image addresses.
export const THUNK_BASE = 0x80000000;
export const THUNK_END = 0xf0000000;
const FIRST = THUNK_BASE;
const END = THUNK_END;

export function registerThunk(thunks, entry) {
  let next = nextByMap.get(thunks);
  if (next === undefined) {
    next = FIRST;
    for (const address of thunks.keys())
      if (address >= FIRST && address < END) next = Math.max(next, address + 16);
  }
  while (thunks.has(next)) next += 16;
  if (next >= END) throw Error('Host thunk address space exhausted');
  thunks.set(next, entry);
  nextByMap.set(thunks, next + 16);
  return next;
}
