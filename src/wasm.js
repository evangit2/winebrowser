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
