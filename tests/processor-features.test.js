import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_PROCESSOR_FEATURES,
  guestProcessorFeaturePresent,
} from '../src/processor-features.js';
import { ntServices } from '../src/wine-nt.js';

const service = ntServices.NtWow64IsProcessorFeaturePresent;
const query = (feature) => service.call(null, () => feature);

test('Wine processor feature query returns a Boolean for the conservative i386 guest profile', () => {
  assert.equal(service.argc, 1);
  assert.equal(GUEST_PROCESSOR_FEATURES.architecture, 'i386');
  assert.deepEqual(GUEST_PROCESSOR_FEATURES.advertised, []);
  for (const feature of [3, 6, 8, 10, 13, 17, 36, 39, 40]) {
    assert.equal(query(feature), 0, `feature ${feature} was incorrectly advertised`);
    assert.equal(guestProcessorFeaturePresent(feature), 0);
  }
});

test('unknown and out-of-range processor features remain absent', () => {
  for (const feature of [0, 1, 2, 4, 63, 64, 88, 89, 255, 0xffffffff])
    assert.equal(query(feature), 0, `feature ${feature} was incorrectly advertised`);
});
