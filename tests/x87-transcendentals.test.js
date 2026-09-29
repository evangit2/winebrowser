import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fyl2x, f2xm1, fscale } from '../src/x87-transcendentals.js';
import iced from 'iced-x86';
import { probeX87Log } from '../scripts/lib/x87-log-probe.js';
import { probeX87Exp } from '../scripts/lib/x87-exp-probe.js';
import { probeX87Scale } from '../scripts/lib/x87-scale-probe.js';
const scaleVectors = JSON.parse(
  await readFile(new URL('./fixtures/x87-scale-vectors.json', import.meta.url)),
).vectors;
const expVectors = JSON.parse(
  await readFile(new URL('./fixtures/x87-exp-vectors.json', import.meta.url)),
).vectors;

const decode = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const one80 = '0000000000000080ff3f',
  two80 = '00000000000000800040';
const encode = (bytes) => Buffer.from(bytes).toString('hex');
const { vectors } = JSON.parse(
  await readFile(new URL('./fixtures/x87-log-vectors.json', import.meta.url)),
);
test('native PE32 FYL2X loop executes every oracle case through translated x86', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('./fixtures/x87/logarithm.exe', import.meta.url)),
  );
  const result = await probeX87Log(iced, { files: new Map([['logarithm.exe', bytes]]) });
  assert.equal(result.status, 'passed', result.failure);
});
test('FYL2X matches an independent 320-digit Decimal oracle across ext80 range and rounding modes', () => {
  for (const v of vectors) {
    const result = fyl2x(decode(v.x), decode(v.y), v.mode);
    assert.equal(encode(result.bytes), v.output, `${v.name}, mode ${v.mode}`);
    assert.equal(result.flags, v.flags, `${v.name} flags, mode ${v.mode}`);
    assert.equal(result.roundedUp, v.roundedUp, `${v.name} C1, mode ${v.mode}`);
  }
});

test('FYL2X handles signed zeros, infinities, invalid formats and NaNs without narrowing', () => {
  const zero = '00000000000000000000',
    negzero = '00000000000000000080',
    one = '0000000000000080ff3f',
    negone = '0000000000000080ffbf',
    half = '0000000000000080fe3f',
    inf = '0000000000000080ff7f',
    ninf = '0000000000000080ffff',
    indefinite = '00000000000000c0ffff',
    snan = '0100000000000080ff7f',
    qnan = '01000000000000c0ff7f';
  for (const [x, y, output, flags] of [
    [zero, one, ninf, 4],
    [negzero, negone, inf, 4],
    [zero, zero, indefinite, 1],
    [negone, one, indefinite, 1],
    [inf, zero, indefinite, 1],
    [inf, one, inf, 0],
    [one, inf, indefinite, 1],
    [half, inf, ninf, 0],
    [zero, inf, ninf, 0],
    [half, zero, negzero, 0],
    [half, negzero, zero, 0],
    [one, negone, negzero, 0],
    [snan, one, qnan, 1],
    [qnan, one, qnan, 0],
    [one, snan, qnan, 1],
    ['0100000000000000ff3f', one, indefinite, 1],
  ]) {
    const result = fyl2x(decode(x), decode(y), 0);
    assert.equal(encode(result.bytes), output, `${x}, ${y}`);
    assert.equal(result.flags, flags, `${x}, ${y}`);
  }
});

// Encode a binary64 value as an ext80 (x87 long double) byte sequence. The
// significand gains the 11 explicit integer/low bits, so exact doubles (and the
// results of simple arithmetic on them) round-trip without loss.
function doubleToExt80(value) {
  const bytes = new Uint8Array(10),
    view = new DataView(bytes.buffer),
    scratch = new DataView(new ArrayBuffer(8));
  if (value === 0) {
    if (Object.is(value, -0)) view.setUint16(8, 0x8000, true);
    return bytes;
  }
  scratch.setFloat64(0, value, true);
  // Binary64 is stored little-endian, so the high word (sign and exponent) is
  // the second 32-bit field.
  const high = scratch.getUint32(4, true),
    low = scratch.getUint32(0, true),
    negative = !!(high & 0x80000000),
    exponentBits = (high >>> 20) & 0x7ff;
  if (exponentBits === 0) return bytes;
  const mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low),
    significand = ((1n << 52n) | mantissa) << 11n,
    exponent = exponentBits - 1023 + 16383;
  view.setBigUint64(0, significand, true);
  view.setUint16(8, (exponent | (negative ? 0x8000 : 0)) & 0xffff, true);
  return bytes;
}

function ext80ToNumber(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, 10);
  const significand = view.getBigUint64(0, true),
    field = view.getUint16(8, true),
    exponent = field & 0x7fff || 1;
  if (significand === 0n) return field & 0x8000 ? -0 : 0;
  const value = Number(significand) * Math.pow(2, exponent - 16383 - 63);
  return field & 0x8000 ? -value : value;
}

test('FPATAN agrees with Math.atan2 across all quadrants and rounding modes', async () => {
  const { fpatan } = await import('../src/x87-transcendentals.js');
  const cases = [
    [1, 1],
    [1, -1],
    [-1, -1],
    [-1, 1],
    [0.75, 0.5],
    [36, 7],
    [7, 36],
    [1, 0],
    [-1, 0],
    [0, -1],
    [0, 1],
    [2, -0.25],
    [-2, -0.25],
    [0.125, 512],
    [-3.5, 0.0625],
  ];
  for (const [yValue, xValue] of cases) {
    const y = doubleToExt80(yValue),
      x = doubleToExt80(xValue),
      want = Math.atan2(yValue, xValue);
    for (const mode of [0, 1, 2, 3]) {
      const got = ext80ToNumber(fpatan(y, x, mode).bytes);
      assert.ok(
        Math.abs(got - want) <= Math.abs(want) * 1e-15 + 1e-300,
        `atan2(${yValue}, ${xValue}) mode ${mode}: got ${got}, want ${want}`,
      );
    }
  }
  // x87 defines atan2 of two positive zeros as +0.
  assert.equal(
    Buffer.from(fpatan(doubleToExt80(0), doubleToExt80(0), 0).bytes).toString('hex'),
    '00000000000000000000',
  );
});

test('FPATAN preserves signed zeros and the pi branches on the axes', async () => {
  const { fpatan } = await import('../src/x87-transcendentals.js');
  const hex = (bytes) => Buffer.from(bytes).toString('hex');
  // atan2(-0, +1) = -0, atan2(-0, -1) = -pi, atan2(+0, -1) = +pi.
  assert.equal(hex(fpatan(doubleToExt80(-0), doubleToExt80(1), 0).bytes), '00000000000000000080');
  const negPi = ext80ToNumber(fpatan(doubleToExt80(-0), doubleToExt80(-1), 0).bytes),
    posPi = ext80ToNumber(fpatan(doubleToExt80(0), doubleToExt80(-1), 0).bytes);
  assert.ok(Math.abs(negPi + Math.PI) < 1e-15, `got ${negPi}`);
  assert.ok(Math.abs(posPi - Math.PI) < 1e-15, `got ${posPi}`);
  // A finite argument sets only the precision (inexact) flag, never invalid.
  assert.equal(fpatan(doubleToExt80(1), doubleToExt80(1), 0).flags & 0x01, 0);
});

test('F2XM1 matches an independent high-precision Decimal oracle for |x| < 1', () => {
  for (const v of expVectors) {
    const result = f2xm1(decode(v.x), v.mode);
    const label = `${v.name}, mode ${v.mode}`;
    assert.equal(encode(result.bytes), v.output, label);
    assert.equal(result.flags, v.flags, label + ' exceptions');
    assert.equal(result.roundedUp, v.roundedUp, label + ' C1');
  }
});

test('native PE32 F2XM1 loop executes every Decimal vector through translated x86', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('./fixtures/x87/exponential.exe', import.meta.url)),
  );
  const result = await probeX87Exp(iced, { files: new Map([['exponential.exe', bytes]]) });
  assert.equal(result.status, 'passed', result.failure);
});

test('F2XM1 returns 2^0-1 = 0, exact endpoints, and #IA outside [-1, 1]', () => {
  const zero = '00000000000000000000',
    negzero = '00000000000000000080',
    one = '0000000000000080ff3f',
    negone = '0000000000000080ffbf',
    inf = '0000000000000080ff7f',
    indefinite = '00000000000000c0ffff',
    snan = '0100000000000080ff7f',
    qnan = '01000000000000c0ff7f';
  for (const input of [zero, negzero]) {
    const result = f2xm1(decode(input), 0);
    assert.equal(encode(result.bytes), zero, '2^0 - 1 is +0 for either zero sign');
    assert.equal(result.flags, 0);
  }
  // The exact endpoints of the domain.
  assert.equal(encode(f2xm1(decode(one), 0).bytes), one, '2^1 - 1 = 1');
  assert.equal(encode(f2xm1(decode(negone), 0).bytes), '0000000000000080febf', '2^-1 - 1 = -0.5');
  // Outside the domain, infinities and invalid encodings raise #IA and
  // produce the x87 indefinite QNaN.
  for (const input of [inf, '0000000000000080ff7f', 'fffffffffffffffffe7f', '0100000000000000ff3f']) {
    const result = f2xm1(decode(input), 0);
    assert.equal(encode(result.bytes), indefinite, input);
    assert.equal(result.flags, 1, input);
  }
  // A signaling NaN is quieted and raises #IA; a quiet NaN propagates cleanly.
  const quieted = f2xm1(decode(snan), 0);
  assert.equal(encode(quieted.bytes), qnan, 'SNaN is quieted');
  assert.equal(quieted.flags, 1, 'SNaN raises #IA');
  assert.equal(encode(f2xm1(decode(qnan), 0).bytes), qnan);
  assert.equal(f2xm1(decode(qnan), 0).flags, 0);
});

test('FSCALE matches an independent exact-rational oracle across scale, rounding and NaN cases', () => {
  for (const v of scaleVectors) {
    const result = fscale(decode(v.a), decode(v.b), (v.control >>> 10) & 3);
    const label = `${v.name}, control 0x${v.control.toString(16)}`;
    assert.equal(encode(result.bytes), v.output, label);
    assert.equal(result.flags, v.flags, label + ' exceptions');
    assert.equal(result.roundedUp, v.roundedUp, label + ' C1');
  }
});

test('native PE32 FSCALE loop executes every exact-rational vector through translated x86', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('./fixtures/x87/scale.exe', import.meta.url)),
  );
  const result = await probeX87Scale(iced, { files: new Map([['scale.exe', bytes]]) });
  assert.equal(result.status, 'passed', result.failure);
});

test('FSCALE truncates ST(1) toward zero and scales by exact powers of two', () => {
  // Multipliers strictly between 0 and 1 and between -1 and 0 truncate to zero,
  // including the largest subnormal and the smallest denormal.
  for (const b of [
    '0000000000000080fe3f',
    '0000000000000080febf',
    'fffffffffffffffffe3f',
    'fffffffffffffffffebf',
    '01000000000000000000',
    '00000000000000800000',
  ])
    assert.equal(encode(fscale(decode(one80), decode(b), 0).bytes), one80, `scale ${b}`);
  // The whole significand shifts with the exponent, so the low bit survives a
  // doubling exactly; no precision-control narrowing applies to FSCALE.
  const lowbit = '0100000000000080ff3f';
  assert.equal(encode(fscale(decode(lowbit), decode(one80), 0).bytes), '01000000000000800040');
  assert.equal(encode(fscale(decode(lowbit), decode(two80), 0).bytes), '01000000000000800140');
  assert.equal(
    encode(fscale(decode(lowbit), decode('0000000000000080ffbf'), 0).bytes),
    '0100000000000080fe3f',
  );
});

test('FSCALE drives signed zeros and infinities per the scale table', () => {
  const negzero = '00000000000000000080',
    inf = '0000000000000080ff7f',
    ninf = '0000000000000080ffff',
    indefinite = '00000000000000c0ffff';
  assert.equal(encode(fscale(decode(one80), decode(inf), 0).bytes), inf);
  assert.equal(encode(fscale(decode(one80), decode(ninf), 0).bytes), '0'.repeat(20));
  assert.equal(encode(fscale(decode(negzero), decode(inf), 0).bytes), indefinite);
  assert.equal(encode(fscale(decode(negzero), decode(ninf), 0).bytes), negzero);
  assert.equal(encode(fscale(decode(inf), decode(ninf), 0).bytes), indefinite);
  assert.equal(encode(fscale(decode(inf), decode(inf), 0).bytes), inf);
  assert.equal(encode(fscale(decode(ninf), decode(inf), 0).bytes), ninf);
  // Overflow and underflow keep the shared #O/#U and C1 accounting.
  const overflow = fscale(decode('fffffffffffffffffe7f'), decode(one80), 0);
  assert.equal(encode(overflow.bytes), inf);
  assert.equal(overflow.flags, 0x28);
  assert.equal(overflow.roundedUp, true);
});
