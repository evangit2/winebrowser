import test from 'node:test';
import assert from 'node:assert/strict';
import { validBlending, colorTarget, blendKey, needsBlendFeedback } from '../src/d3d-blending.js';

test('blending rejects malformed worker snapshots and unknown states', () => {
  for (const blend of [
    null,
    [],
    1,
    { 19: 0 },
    { 19: 16 },
    { 20: 12 },
    { 207: 13 },
    { 171: 6 },
    { 193: -1 },
    { 193: 2 ** 32 },
    { 168: 16 },
    { 27: true },
    { 999: 0 },
  ])
    assert.equal(validBlending(blend), false, JSON.stringify(blend));
  assert.equal(validBlending(undefined), true);
  assert.equal(validBlending({ 19: 5, 20: 6, 27: 1 }), true);
});
test('blend constants stay dynamic while pipeline-affecting states distinguish variants', () => {
  assert.equal(blendKey({ blend: { 193: 0xff102030 } }), blendKey({ blend: { 193: 0 } }));
  assert.notEqual(blendKey({ blend: { 168: 3 } }), blendKey({ blend: { 168: 15 } }));
  assert.notEqual(blendKey({ blend: { 27: 0 } }), blendKey({ blend: { 27: 1 } }));
});
test('RGB565 feedback is required only for enabled RGB writes', () => {
  for (const format of [21, 22, 23])
    for (const mask of [0, 1, 8, 15])
      for (const enable of [0, 1])
        assert.equal(
          needsBlendFeedback({ colorFormat: format }, { blend: { 27: enable, 168: mask } }),
          format === 23 && !!enable && !!(mask & 7),
        );
});
test('MIN/MAX ignore factors, legacy BOTH overrides destination, XRGB has opaque destination alpha', () => {
  const target = (blend, format = 21) =>
    colorTarget({ colorFormat: format }, { blend: { 27: 1, ...blend } }, 'rgba8unorm');
  for (const op of [4, 5]) {
    const result = target({ 19: 5, 20: 6, 171: op });
    assert.equal(result.blend.color.srcFactor, 'one');
    assert.equal(result.blend.color.dstFactor, 'one');
  }
  assert.deepEqual(target({ 19: 13, 20: 1 }).blend.color, {
    operation: 'add',
    srcFactor: 'one-minus-src-alpha',
    dstFactor: 'src-alpha',
  });
  assert.equal(target({ 19: 7 }, 22).blend.color.srcFactor, 'one');
  assert.equal(target({ 19: 11 }, 22).blend.color.srcFactor, 'zero');
  assert.equal(target({ 19: 11 }).blend.alpha.srcFactor, 'one');
});
