import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reflectDXBCInputSignature } from '../src/dxbc-signature.js';

const fixtureURL = new URL('../demos/d3d12-cube/shaders/cube.vs.dxbc', import.meta.url);

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function chunk(bytes, wanted) {
  const data = view(bytes);
  const count = data.getUint32(28, true);
  for (let i = 0; i < count; i++) {
    const offset = data.getUint32(32 + i * 4, true);
    const name = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (name === wanted) return { offset, body: offset + 8 };
  }
  throw Error(`missing ${wanted}`);
}

test('reflects the cube SM5 input semantics and registers', async () => {
  const bytes = new Uint8Array(await readFile(fixtureURL));
  assert.deepEqual(reflectDXBCInputSignature(bytes), [
    {
      semanticName: 'POSITION',
      semanticIndex: 0,
      register: 0,
      mask: 15,
      usedMask: 15,
      systemValue: 0,
    },
    {
      semanticName: 'COLOR',
      semanticIndex: 0,
      register: 1,
      mask: 15,
      usedMask: 15,
      systemValue: 0,
    },
    {
      semanticName: 'SV_VertexID',
      semanticIndex: 0,
      register: 2,
      mask: 1,
      usedMask: 1,
      systemValue: 6,
    },
  ]);
});

test('uses declared registers independently of ISGN record order', async () => {
  const bytes = new Uint8Array(await readFile(fixtureURL));
  const data = view(bytes);
  const { body } = chunk(bytes, 'ISGN');
  const records = body + data.getUint32(body + 4, true);
  data.setUint32(records + 16, 1, true);
  data.setUint32(records + 24 + 16, 0, true);
  const first = bytes.slice(records, records + 24);
  bytes.copyWithin(records, records + 24, records + 48);
  bytes.set(first, records + 24);
  assert.deepEqual(
    reflectDXBCInputSignature(bytes)
      .slice(0, 2)
      .map(({ semanticName, register }) => [semanticName, register]),
    [
      ['COLOR', 0],
      ['POSITION', 1],
    ],
  );
});

test('rejects duplicate semantics and unsupported ISG1 without checksum dependence', async () => {
  const original = new Uint8Array(await readFile(fixtureURL));
  const duplicate = original.slice();
  const duplicateView = view(duplicate);
  const { offset, body } = chunk(duplicate, 'ISGN');
  const records = body + duplicateView.getUint32(body + 4, true);
  duplicateView.setUint32(records + 24, duplicateView.getUint32(records, true), true);
  assert.throws(() => reflectDXBCInputSignature(duplicate), /duplicate semantic POSITION0/);

  const isg1 = original.slice();
  isg1.set(new TextEncoder().encode('ISG1'), offset);
  assert.throws(() => reflectDXBCInputSignature(isg1), /ISG1 input signatures are unsupported/);
});

test('rejects malformed container, chunk, record, and string bounds', async () => {
  const original = new Uint8Array(await readFile(fixtureURL));
  const cases = [];
  const total = original.slice();
  view(total).setUint32(24, total.length + 4, true);
  cases.push(total);
  const chunkOffset = original.slice();
  view(chunkOffset).setUint32(32, original.length - 4, true);
  cases.push(chunkOffset);
  const name = original.slice();
  const { body } = chunk(name, 'ISGN');
  const data = view(name);
  const records = body + data.getUint32(body + 4, true);
  data.setUint32(records, data.getUint32(chunk(name, 'ISGN').offset + 4, true), true);
  cases.push(name);
  const count = original.slice();
  const countBody = chunk(count, 'ISGN').body;
  view(count).setUint32(countBody, 129, true);
  cases.push(count);
  for (const bytes of cases)
    assert.throws(() => reflectDXBCInputSignature(bytes), /Invalid or unsupported DXBC/);
});
