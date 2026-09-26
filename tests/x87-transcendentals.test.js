import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fyl2x } from '../src/x87-transcendentals.js';
import iced from 'iced-x86';
import { probeX87Log } from '../scripts/lib/x87-log-probe.js';

const decode = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
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
