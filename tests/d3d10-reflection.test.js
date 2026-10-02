import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dxbcChunks, reflectShader } from '../src/d3d10-reflection.js';
const shader = new Uint8Array(await readFile('demos/d3d10-cube/shaders/cube.vs.dxbc'));

test('reflection reports the program version and actual RDEF variable types', () => {
  const chunks = dxbcChunks(shader);
  const program = chunks.get('SHDR') ?? chunks.get('SHEX');
  const d = reflectShader(shader);
  assert.equal(
    d.version,
    new DataView(program.buffer, program.byteOffset, program.byteLength).getUint32(0, true),
  );
  assert.equal(d.constantBuffers[0].size, 64);
  assert.deepEqual(
    d.variables[0].map((v) => [v.name, v.offset, v.size]),
    [
      ['row0', 0, 16],
      ['row1', 16, 16],
      ['row2', 32, 16],
      ['row3', 48, 16],
    ],
  );
  assert.deepEqual(d.variables[0][0].type, {
    class: 1,
    type: 3,
    rows: 1,
    columns: 4,
    elements: 0,
    members: [],
  });
});

function mutateFirstType(change) {
  const bytes = shader.slice();
  const body = dxbcChunks(bytes).get('RDEF');
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const bufferRecord = view.getUint32(4, true);
  const variableRecord = view.getUint32(bufferRecord + 8, true);
  change(view, variableRecord, view.getUint32(variableRecord + 16, true), body.length);
  return bytes;
}

test('reflection rejects out-of-bounds and recursive guest type metadata', () => {
  assert.throws(
    () =>
      reflectShader(
        mutateFirstType((v, record, _type, size) => {
          v.setUint32(record + 16, size - 8, true);
        }),
      ),
    /type record is out of bounds/,
  );
  assert.throws(
    () =>
      reflectShader(
        mutateFirstType((v, record, type) => {
          v.setUint16(type + 10, 1, true);
          v.setUint32(type + 12, record, true);
          v.setUint32(record + 4, type, true);
        }),
      ),
    /recursive type exceeds the limit/,
  );
  assert.throws(
    () =>
      reflectShader(
        mutateFirstType((v, record, _type, size) => {
          v.setUint32(record + 20, size - 4, true);
        }),
      ),
    /variable default value is out of bounds/,
  );
});
