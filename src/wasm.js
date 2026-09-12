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
const signatures = [
  [1, 1],
  [2, 0],
  [1, 0],
  [0, 1],
  [4, 0],
  [1, 1],
]; // load, store, push, pop, flags, condition
export function moduleBytes(code) {
  const types = signatures.map(([n, r]) => [
    0x60,
    ...vec(Array(n).fill([0x7f])),
    ...vec(r ? [[0x7f]] : []),
  ]);
  types.push([0x60, 0, 1, 0x7f]);
  const imports = ['load', 'store', 'push', 'pop', 'flags', 'condition'].map((name, i) => [
    ...str('h'),
    ...str(name),
    0,
    i,
  ]);
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
    ...section(3, [1, 6]),
    ...section(7, [1, ...str('run'), 0, 6]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}

export { constant, get, set, local, call };
