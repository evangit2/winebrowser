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
