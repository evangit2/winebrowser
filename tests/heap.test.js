import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestHeap } from '../src/heap.js';
test('heap reuses freed blocks, coalesces neighbors and applies zero-fill on reuse', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const h = new GuestHeap(memory, 0x1000, 0x1040);
  const a = h.allocate(17),
    b = h.allocate(17);
  assert.throws(() => h.allocate(1), /exhausted/);
  new Uint8Array(memory.buffer).fill(255, a, a + 32);
  assert.equal(h.free(a), true);
  assert.equal(h.free(a), false);
  assert.equal(h.allocate(24, true), a);
  assert.deepEqual([...new Uint8Array(memory.buffer, a, 24)], Array(24).fill(0));
  h.free(a);
  h.free(b);
  assert.equal(h.allocate(64), 0x1000);
  assert.equal(h.free(0x1001), false);
});
