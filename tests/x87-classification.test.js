import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { classifyExtendedFloat } from '../src/x87-classification.js';
test('bit classifier matches the independent SoftFloat adapter for every sign/exponent and special significands', async () => {
  const memory = new WebAssembly.Memory({ initial: 1 }),
    view = new DataView(memory.buffer),
    cpu = new CPU(iced, {
      memory,
      read32: (a) => view.getUint32(a, true),
      write32: (a, v) => view.setUint32(a, v, true),
      executableRanges: [[0x1000, 0x1001]],
    });
  await cpu.initialize();
  try {
    const sf = cpu.x87.sf,
      p = cpu.x87.p + 4,
      bytes = new Uint8Array(10),
      v = new DataView(bytes.buffer);
    for (const significand of [
      0n,
      1n,
      0x8000000000000000n,
      0x4000000000000000n,
      0x8000000000000001n,
      0xffffffffffffffffn,
    ]) {
      v.setBigUint64(0, significand, true);
      for (let signExp = 0; signExp < 65536; signExp++) {
        v.setUint16(8, signExp, true);
        sf.HEAPU8.set(bytes, p);
        assert.equal(
          classifyExtendedFloat(bytes),
          sf._wb_sf_classify(p, 10),
          `sign/exponent ${signExp}, significand ${significand}`,
        );
      }
    }
    let seed = 0x12345678;
    for (let sample = 0; sample < 10000; sample++) {
      for (let i = 0; i < 10; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        bytes[i] = seed & 255;
      }
      sf.HEAPU8.set(bytes, p);
      assert.equal(classifyExtendedFloat(bytes), sf._wb_sf_classify(p, 10));
    }
  } finally {
    cpu.dispose();
  }
});
