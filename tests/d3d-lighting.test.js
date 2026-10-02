import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fvfLayout } from '../src/d3d-fvf.js';
import {
  normalMatrix,
  validLighting,
  lightingSnapshot,
  initLighting,
} from '../src/d3d-lighting.js';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const raceMatrices = JSON.parse(
  await readFile(new URL('../evidence/hamsterball-race-normal-transform.json', import.meta.url)),
);
test('FVF optional normals, colors and UVs retain the native packed offsets', () => {
  assert.deepEqual(fvfLayout(0x1d2).attributes, [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 3, offset: 12, format: 'float32x3' },
    { shaderLocation: 1, offset: 24, format: 'unorm8x4' },
    { shaderLocation: 4, offset: 28, format: 'unorm8x4' },
    { shaderLocation: 2, offset: 32, format: 'float32x2' },
  ]);
  assert.equal(fvfLayout(0x1d2).size, 40);
  assert.equal(fvfLayout(0x112).size, 32);
  assert.equal(fvfLayout(2).size, 12);
  // XYZRHW (0x4) is supported; invalid combinations and other bits are not.
  for (const fvf of [0, 6, 0x902, 0x10002, 0x100000002, NaN]) assert.equal(fvfLayout(fvf), null);
  assert.equal(fvfLayout(4).rhw, true);
  assert.equal(fvfLayout(4).size, 16);
  assert.equal(fvfLayout(0x144).size, 28);
});
test('FVF sized coordinates retain all eight packed sets and reject stray size bits', () => {
  const layout = fvfLayout(0xe4e40842);
  assert.deepEqual(
    layout.texcoords.map(({ offset, components, format }) => [offset, components, format]),
    [
      [16, 2, 'float32x2'],
      [24, 3, 'float32x3'],
      [36, 4, 'float32x4'],
      [52, 1, 'float32'],
      [56, 2, 'float32x2'],
      [64, 3, 'float32x3'],
      [76, 4, 'float32x4'],
      [92, 1, 'float32'],
    ],
  );
  assert.equal(layout.size, 96);
  assert.equal(layout.uv, 16);
  assert.equal(fvfLayout(0x10142).uvSize, 3);
  assert.equal(fvfLayout(0x50142), null);
  assert.equal(fvfLayout(0x0902), null);
});
test('normal inverse transpose preserves orthogonality through shear, scale and camera rotation', () => {
  const world = [2, 1, 0, 0, 0, 3, 1, 0, 0.5, 0, 0.5, 0, 7, 8, 9, 1],
    view = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 4, 5, 6, 1];
  const normal = normalMatrix(world, view);
  const apply = (m, v) => [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2]);
  const n = apply(normal, [0, 0, 1]);
  for (const tangent of [
    [1, 0, 0],
    [0, 1, 0],
  ]) {
    const t = apply(view, apply(world, tangent));
    assert.ok(Math.abs(n.reduce((s, v, i) => s + v * t[i], 0)) < 1e-6);
  }
  assert.deepEqual([...normalMatrix(identity, identity)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  const singular = [...identity];
  singular[0] = 0;
  assert.deepEqual([...normalMatrix(singular, identity)], [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  assert.deepEqual([...normalMatrix(Array(16).fill(0), identity)], Array(12).fill(0));
});
test('projective normals include translation and homogeneous terms of the full inverse', () => {
  // The z/w block is [[2, 2], [1/4, 1]], whose determinant is 3/2.
  // Inverting only the spatial 3x3 would incorrectly return 1/2 for z.
  const projective = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0.25, 0, 0, 2, 1];
  const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, Math.fround(2 / 3), 0];
  assert.deepEqual([...normalMatrix(projective, identity)], expected);
  assert.deepEqual([...normalMatrix(identity, projective)], expected);
  // Its upper 3x3 can be singular while the full matrix is invertible.
  const swapped = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0];
  assert.deepEqual([...normalMatrix(swapped, identity)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...normalMatrix(swapped, swapped)], [...normalMatrix(identity, identity)]);
});
test('singular normals preserve Wine modelview transpose and reject nonfinite input', () => {
  const singular = [2, 1, 0, 0.5, 0, 0, 0, 0, 0, 0, 3, 0, 4, 0, 0, 1];
  assert.deepEqual([...normalMatrix(singular, identity)], [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 3, 0]);
  const invalid = [...identity];
  invalid[3] = NaN;
  assert.throws(() => normalMatrix(invalid, identity), /Invalid/);
  invalid[3] = Infinity;
  assert.throws(() => normalMatrix(invalid, identity), /Invalid/);
  assert.throws(() => normalMatrix(identity.slice(1), identity), /Invalid/);
});
test('captured native race matrix accepts a homogeneous value one Float32 step below one', () => {
  const { world, view } = raceMatrices;
  assert.equal(world[15], Math.fround(1 - 2 ** -24));
  const canonical = [...world];
  canonical[15] = 1;
  // A block triangular matrix's spatial inverse does not depend on its
  // translation or nonzero homogeneous diagonal; this is an independent
  // comparison with the established affine path, without changing guest state.
  assert.deepEqual([...normalMatrix(world, view)], [...normalMatrix(canonical, view)]);
  assert.equal(world[15], Math.fround(1 - 2 ** -24));
});
test('lighting defaults, snapshots and validation keep unsupported data out of the GPU', () => {
  const state = initLighting(),
    snapshot = lightingSnapshot(state);
  assert.equal(snapshot.states[146], 2);
  assert.equal(snapshot.states[143], 0);
  assert.equal(validLighting(snapshot), true);
  state.material[0] = 1;
  state.lightState[146] = 0;
  assert.equal(snapshot.material[0], 0);
  assert.equal(snapshot.states[146], 2);
  const bad = { ...snapshot, states: { ...snapshot.states, 146: 4 } };
  assert.equal(validLighting(bad), false);
  assert.equal(validLighting({ ...snapshot, lights: Array(9).fill(new Float32Array(26)) }), false);
  snapshot.material[16] = NaN;
  assert.equal(validLighting(snapshot), false);
  state.lightState[137] = 0;
  assert.equal(lightingSnapshot(state), null);
});
