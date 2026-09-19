import createSoftFloat from '../../public/runtime/softfloat/softfloat.js';
import assert from 'node:assert/strict';

const sf = await createSoftFloat();
const allocations = [];
const alloc = (size) => {
  const p = sf._malloc(size);
  allocations.push(p);
  return p;
};
const state = alloc(4),
  a = alloc(10),
  b = alloc(10),
  out = alloc(10),
  scalar = alloc(8),
  result = alloc(4);
const view = () => new DataView(sf.HEAPU8.buffer);
const ext = (p, significand, signExp) => {
  view().setBigUint64(p, significand, true);
  view().setUint16(p + 8, signExp, true);
};
const readExt = (p) => [view().getBigUint64(p, true), view().getUint16(p + 8, true)];
const init = (rounding, precision = 64) =>
  assert.equal(sf._wb_sf_init(state, 4, rounding, precision, 1), 0);

// 1 + 2^-63 is representable in ext80 and is lost by JavaScript binary64.
assert.equal(1 + 2 ** -63, 1);
init(0, 64);
ext(a, 0x8000000000000000n, 0x3fff);
ext(b, 0x8000000000000000n, 0x3fc0);
assert.equal(sf._wb_sf_binary(state, 4, 0, out, 10, a, 10, b, 10), 0);
assert.deepEqual(readExt(out), [0x8000000000000001n, 0x3fff]);
assert.equal(sf.HEAPU8[state + 3], 0);

// x87 PC53 rounds that same result to one and reports inexact.
init(0, 53);
assert.equal(sf._wb_sf_binary(state, 4, 0, out, 10, a, 10, b, 10), 0);
assert.deepEqual(readExt(out), [0x8000000000000000n, 0x3fff]);
assert.equal(sf.HEAPU8[state + 3], 1);

// At PC24, upward rounding of the halfway increment advances one float32 ULP.
init(3, 24);
ext(b, 0x8000000000000000n, 0x3fe7); // 2^-24
assert.equal(sf._wb_sf_binary(state, 4, 0, out, 10, a, 10, b, 10), 0);
assert.deepEqual(readExt(out), [0x8000010000000000n, 0x3fff]);
assert.equal(sf.HEAPU8[state + 3], 1);

// Signed 64-bit conversion travels through bytes, without a JS number.
init(0, 64);
view().setBigInt64(scalar, 0x7fffffffffffffffn, true);
assert.equal(sf._wb_sf_from_i64(state, 4, out, 10, scalar, 8), 0);
assert.equal(sf._wb_sf_to_i64(state, 4, scalar, 8, out, 10), 0);
assert.equal(view().getBigInt64(scalar, true), 0x7fffffffffffffffn);

// Raw IEEE float encodings round-trip without host floating-point arithmetic.
view().setBigUint64(scalar, 0x400921fb54442d18n, true);
assert.equal(sf._wb_sf_from_f64(state, 4, out, 10, scalar, 8), 0);
assert.equal(sf._wb_sf_to_f64(state, 4, scalar, 8, out, 10), 0);
assert.equal(view().getBigUint64(scalar, true), 0x400921fb54442d18n);
view().setUint32(scalar, 0x3eaaaaab, true);
assert.equal(sf._wb_sf_from_f32(state, 4, out, 10, scalar, 4), 0);
assert.equal(sf._wb_sf_to_f32(state, 4, scalar, 4, out, 10), 0);
assert.equal(view().getUint32(scalar, true), 0x3eaaaaab);

// Integer conversions honor each state's rounding control.
ext(a, 0xc000000000000000n, 0x3fff); // 1.5
init(0, 64);
assert.equal(sf._wb_sf_to_i32(state, 4, result, 4, a, 10), 0);
assert.equal(view().getInt32(result, true), 2);
assert.equal(sf.HEAPU8[state + 3], 1);
init(1, 64);
assert.equal(sf._wb_sf_to_i32(state, 4, result, 4, a, 10), 0);
assert.equal(view().getInt32(result, true), 1);

// sqrt(4), quiet comparison, classification, and divide-by-zero flags.
ext(a, 0x8000000000000000n, 0x4001);
assert.equal(sf._wb_sf_sqrt(state, 4, out, 10, a, 10), 0);
assert.deepEqual(readExt(out), [0x8000000000000000n, 0x4000]);
ext(b, 0x8000000000000000n, 0x4000);
assert.equal(sf._wb_sf_compare(state, 4, result, 4, out, 10, b, 10), 0);
assert.equal(view().getInt32(result, true), 0);
ext(a, 0xc000000000000001n, 0x7fff);
assert.equal(sf._wb_sf_classify(a, 10), 16);
ext(a, 0x8000000000000000n, 0x3fff);
ext(b, 0n, 0);
assert.equal(sf._wb_sf_binary(state, 4, 3, out, 10, a, 10, b, 10), 0);
assert.equal(sf._wb_sf_classify(out, 10), 8);
assert.equal(sf.HEAPU8[state + 3], 8);

assert.equal(sf._wb_sf_binary(state, 4, 0, 0xfffffff0, 10, a, 10, b, 10), -1);
for (const p of allocations) sf._free(p);
console.log('SoftFloat ext80 adapter tests passed');
