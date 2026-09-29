// Binary encoding for the deliberately small Wasm block ABI.
const uleb = (n) => {
  const a = [];
  do {
    let b = n & 127;
    n >>>= 7;
    a.push(b | (n ? 128 : 0));
  } while (n);
  return a;
};
const sleb = (n) => {
  n |= 0;
  const a = [];
  for (;;) {
    const b = n & 127;
    n >>= 7;
    const done = (n === 0 && !(b & 64)) || (n === -1 && b & 64);
    a.push(b | (done ? 0 : 128));
    if (done) return a;
  }
};
const str = (s) => {
  const a = [...new TextEncoder().encode(s)];
  return [...uleb(a.length), ...a];
};
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, data) => [id, ...uleb(data.length), ...data];
const constant = (n) => [0x41, ...sleb(n)];
const get = (r) => [0x23, r];
const set = (r) => [0x24, r];
const local = (n) => [0x20, n];
const call = (n) => [0x10, n];
// General registers occupy global indices 0..7. FS follows the active guest
// context so compiled blocks remain reusable across thread switches.
export const FS_BASE_GLOBAL = 8;
// The guest address of the instruction currently executing. Memory-touching
// instructions record it before their access, so a checked access fault can be
// attributed to one guest instruction and offered to the exception chain.
export const INSTRUCTION_IP_GLOBAL = 9;
// Numeric indices are shared with the CPU lowering code. Guest memory is accessed
// through checked host calls rather than exposing the decoder's Wasm memory.
export const Host = Object.freeze({
  load: 0,
  store: 1,
  push: 2,
  pop: 3,
  flags: 4,
  condition: 5,
  shift: 6,
  wideMath: 7,
  bitTest: 8,
  simd: 9,
  bitScan: 10,
  cmpxchg: 11,
  string: 12,
  direction: 13,
  popStore: 14,
  x87: 15,
  flagByte: 16,
  cpuid: 17,
  timestamp: 18,
  rotate: 19,
  rotateStore: 20,
  xadd: 21,
  stackFlags: 22,
  stackRegisters: 23,
  doubleShift: 24,
  doubleShiftStore: 25,
  cmpxchg8b: 26,
  // BT/BTS/BTR/BTC with a memory bit base: address + signed bit offset /
  // operand width selects the enclosing unit across the whole bit string.
  bitMemory: 27,
});
const signatures = [
  [2, 1],
  [3, 0],
  [1, 0],
  [0, 1],
  [5, 0],
  [1, 1],
  [4, 1],
  [3, 1],
  [3, 0],
  [5, 0],
  [3, 1],
  [7, 0],
  [6, 1],
  [1, 0],
  [2, 0],
  [6, 0],
  [2, 1],
  [2, 0],
  [0, 0],
  [4, 1],
  [5, 0],
  [8, 0],
  [2, 0],
  [2, 0],
  [5, 1],
  [6, 0],
  [1, 0],
  [4, 0],
];
const hostNames = Object.keys(Host);
export function moduleBytes(code) {
  const types = signatures.map(([n, r]) => [
    0x60,
    ...vec(Array(n).fill([0x7f])),
    ...vec(r ? [[0x7f]] : []),
  ]);
  types.push([0x60, 0, 1, 0x7f]);
  const imports = hostNames.map((name, i) => [...str('h'), ...str(name), 0, i]);
  for (let i = 0; i < 8; i++) imports.push([...str('h'), ...str('r' + i), 3, 0x7f, 1]);
  imports.push([...str('h'), ...str('fsBase'), 3, 0x7f, 1]);
  imports.push([...str('h'), ...str('instructionIp'), 3, 0x7f, 1]);
  const body = [1, 3, 0x7f, ...code, 0x0b];
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, vec(types)),
    ...section(2, vec(imports)),
    ...section(3, [1, hostNames.length]),
    ...section(7, [1, ...str('run'), 0, hostNames.length]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

export { constant, get, set, local, call };
