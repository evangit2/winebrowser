import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIndexSnapshot } from '../src/d3d12-indices.js';

function command(width, values, overrides = {}) {
  // Nonzero byteOffset catches accidental reads from the backing buffer start.
  const bytes = new Uint8Array(
    new ArrayBuffer(values.length * width + 5),
    3,
    values.length * width,
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  values.forEach((value, i) =>
    width === 2 ? view.setUint16(i * width, value, true) : view.setUint32(i * width, value, true),
  );
  return {
    indices: bytes,
    indexFormat: width === 2 ? 'uint16' : 'uint32',
    indexCount: values.length,
    firstIndex: 0,
    baseVertex: 0,
    ...overrides,
  };
}

for (const width of [2, 4]) {
  test(`D3D12 ${width * 8}-bit indices honor the draw subrange and signed base vertex`, () => {
    const draw = command(width, [65535, 5, 3, 4, 65535], {
      firstIndex: 1,
      indexCount: 3,
      baseVertex: -3,
    });
    assert.doesNotThrow(() => validateIndexSnapshot(draw, 3));
    assert.throws(() => validateIndexSnapshot({ ...draw, firstIndex: 0 }, 3), /outside/);
    assert.throws(() => validateIndexSnapshot({ ...draw, baseVertex: -4 }, 3), /outside/);
    assert.throws(() => validateIndexSnapshot({ ...draw, baseVertex: -2 }, 3), /outside/);
    assert.throws(() => validateIndexSnapshot({ ...draw, indexCount: 8 }, 3), /snapshot/);
  });
}

test('index validation rejects malformed views and integer overflow without wrapping', () => {
  const draw = command(4, [0xffffffff]);
  assert.throws(() => validateIndexSnapshot(draw), /outside/);
  assert.throws(() => validateIndexSnapshot({ ...draw, baseVertex: 0x80000000 }), /snapshot/);
  assert.throws(() => validateIndexSnapshot({ ...draw, firstIndex: NaN }), /snapshot/);
  assert.throws(() => validateIndexSnapshot({ ...draw, indexFormat: 'float32' }), /snapshot/);
  assert.throws(() => validateIndexSnapshot({ ...draw, indices: new Uint8Array(3) }), /snapshot/);
  assert.throws(() => validateIndexSnapshot({ ...draw, indexCount: 65536 }), /snapshot/);
  assert.throws(() => validateIndexSnapshot(command(2, [0]), 0), /outside/);
});
