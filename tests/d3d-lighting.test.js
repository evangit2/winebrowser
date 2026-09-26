import test from 'node:test';
import assert from 'node:assert/strict';
import { fvfLayout } from '../src/d3d-fvf.js';
import {
  normalMatrix,
  validLighting,
  lightingSnapshot,
  initLighting,
} from '../src/d3d-lighting.js';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
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
  for (const fvf of [0, 6, 0x202, 0x10002, 0x100000002, NaN]) assert.equal(fvfLayout(fvf), null);
  assert.equal(fvfLayout(4).rhw, true);
  assert.equal(fvfLayout(4).size, 16);
  assert.equal(fvfLayout(0x144).size, 28);
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
  assert.throws(() => normalMatrix(singular, identity), /invertible/);
  assert.throws(() => normalMatrix(Array(16).fill(0), identity), /affine/);
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
