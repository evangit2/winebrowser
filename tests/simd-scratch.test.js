import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { SIMDFloat } from '../src/simd-float.js';
const a = Uint32Array.from([0x3f800000, 0x40000000, 0x40800000, 0x3f000000]);
const b = Uint32Array.from([0x40000000, 0x3f800000, 0x3f000000, 0x40800000]);
const initialize = async () => {
  const cpu = new CPU(iced, {
    memory: new WebAssembly.Memory({ initial: 1 }),
    read32: () => 0,
    write32() {},
    check: (address) => address >>> 0,
  });
  await cpu.initialize();
  return cpu;
};
test('SIMD scratch never aliases returned scalar or packed values', async () => {
  const cpu = await initialize(),
    service = new SIMDFloat(() => cpu.x87.sf);
  try {
    const min = service.execute(11, false, a.subarray(0, 1), b.subarray(0, 1));
    const max = service.execute(12, false, a.subarray(0, 1), b.subarray(0, 1));
    const packed = service.packed(11, false, a, b);
    service.packed(0, false, b, b);
    service.execute(13, false, a, b, 0);
    assert.deepEqual(Array.from(min), [0x3f800000, 0]);
    assert.deepEqual(Array.from(max), [0x40000000, 0]);
    assert.deepEqual(Array.from(packed), [0x3f800000, 0x3f800000, 0x3f000000, 0x3f000000]);
    assert.deepEqual(Array.from(a), [0x3f800000, 0x40000000, 0x40800000, 0x3f000000]);
  } finally {
    service.dispose();
    cpu.dispose();
  }
});
test('SIMD scratch refreshes its view after actual SoftFloat Wasm memory growth', async () => {
  const cpu = await initialize(),
    service = new SIMDFloat(() => cpu.x87.sf);
  let allocation = 0;
  try {
    const expected = Array.from(service.packed(0, false, a, b));
    const before = cpu.x87.sf.HEAPU8.buffer;
    allocation = cpu.x87.sf._malloc(before.byteLength + 1024);
    assert.ok(allocation, 'large native allocation succeeds');
    assert.notEqual(cpu.x87.sf.HEAPU8.buffer, before, 'native allocator grew Wasm memory');
    assert.deepEqual(Array.from(service.packed(0, false, a, b)), expected);
  } finally {
    if (allocation) cpu.x87.sf._free(allocation);
    service.dispose();
    cpu.dispose();
  }
});
