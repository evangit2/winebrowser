import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedDeclarationVertices } from '../src/d3d9-fixed-declaration.js';

test('fixed processing retains NORMAL=3 while ignoring tangent and binormal inputs', () => {
  const elements = [
    [0, 12, 2, 0],
    [12, 8, 1, 5],
    [20, 12, 2, 6],
    [32, 12, 2, 7],
    [44, 12, 2, 3],
  ].map(([offset, size, type, usage]) => ({ offset, size, type, usage, usageIndex: 0 }));
  const state = { fvf: 0, vertexDeclaration: { state: { elements } } };
  const vertices = new Uint8Array(3 * 68),
    source = new DataView(vertices.buffer);
  for (let i = 0; i < 3; i++) {
    [i, 2, 3, 0.25, 0.75].forEach((v, j) => source.setFloat32(i * 68 + j * 4, v, true));
    for (let j = 20; j < 44; j += 4) source.setFloat32(i * 68 + j, NaN, true);
    [0, 0, 1].forEach((v, j) => source.setFloat32(i * 68 + 44 + j * 4, v, true));
  }
  const before = vertices.slice();
  const draw = fixedDeclarationVertices(state, vertices, 68, 3);
  assert.equal(draw.state.fvf, 0x112);
  assert.equal(draw.state.vertexDeclaration, null);
  assert.equal(state.vertexDeclaration.state.elements, elements, 'guest binding is retained');
  assert.equal(draw.stride, 32);
  const packed = new DataView(draw.vertices.buffer);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(
      Array.from({ length: 8 }, (_, j) => packed.getFloat32(i * 32 + j * 4, true)),
      [i, 2, 3, 0, 0, 1, 0.25, 0.75],
    );
  assert.deepEqual(vertices, before);
  // Unused semantics still obey the declared input footprint.
  assert.throws(
    () => fixedDeclarationVertices(state, vertices, 52, 3),
    /Unsupported fixed-function/,
  );
  const invalid = {
    ...state,
    vertexDeclaration: {
      state: {
        elements: [...elements, { offset: 56, size: 4, type: 0, usage: 255, usageIndex: 0 }],
      },
    },
  };
  assert.throws(
    () => fixedDeclarationVertices(invalid, vertices, 68, 3),
    /Unsupported fixed-function/,
  );
});
