import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { sincos } from '../src/x87-transcendentals.js';
import { probeX87Trig } from '../scripts/lib/x87-trig-probe.js';

const decode = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
const encode = (bytes) => Buffer.from(bytes).toString('hex');
const { vectors } = JSON.parse(
  await readFile(new URL('./fixtures/x87-trig-vectors.json', import.meta.url)),
);
test('sine/cosine agree with the independent Decimal/Chudnovsky oracle across rounding and argument ranges', () => {
  for (const v of vectors) {
    const result = sincos(decode(v.x), v.mode);
    for (const name of ['sine', 'cosine']) {
      const expected = v[name],
        actual = result[name],
        label = `${v.name} ${name}, mode ${v.mode}`;
      assert.equal(encode(actual.bytes), expected.output, label);
      assert.equal(actual.flags, expected.flags, label + ' exceptions');
      assert.equal(actual.roundedUp, expected.roundedUp, label + ' C1');
    }
  }
});
test('native PE32 trig loop executes FSIN, FCOS and FSINCOS over every oracle case', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('./fixtures/x87/trigonometry.exe', import.meta.url)),
  );
  const result = await probeX87Trig(iced, { files: new Map([['trigonometry.exe', bytes]]) });
  assert.equal(result.status, 'passed', result.failure);
});
test('trig handles signed zeros, finite range rejection and exceptional values', () => {
  for (const input of ['00000000000000000000', '00000000000000000080']) {
    const result = sincos(decode(input), 0);
    assert.equal(encode(result.sine.bytes), input);
    assert.equal(encode(result.cosine.bytes), '0000000000000080ff3f');
    assert.equal(result.sine.flags | result.cosine.flags, 0);
  }
  for (const input of ['00000000000000803e40', '00000000000000803ec0', 'fffffffffffffffffe7f']) {
    const bytes = decode(input),
      before = bytes.slice();
    assert.deepEqual(sincos(bytes, 0), { outOfRange: true });
    assert.deepEqual(bytes, before);
  }
  for (const [input, output, flags] of [
    ['0000000000000080ff7f', '00000000000000c0ffff', 1],
    ['0000000000000080ffff', '00000000000000c0ffff', 1],
    ['0100000000000080ff7f', '01000000000000c0ff7f', 1],
    ['01000000000000c0ff7f', '01000000000000c0ff7f', 0],
    ['0100000000000000ff3f', '00000000000000c0ffff', 1],
  ]) {
    const result = sincos(decode(input), 0);
    for (const name of ['sine', 'cosine']) {
      assert.equal(encode(result[name].bytes), output);
      assert.equal(result[name].flags, flags);
    }
  }
});
