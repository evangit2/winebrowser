import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

function machine(code, fsBase = 0) {
  const memory = new WebAssembly.Memory({ initial: 3 }),
    data = new Uint8Array(memory.buffer);
  data.set([...code, 0xeb, 0], 0x1000);
  const view = new DataView(memory.buffer),
    reads = [];
  const cpu = new CPU(iced, {
    memory,
    fsBase,
    executableRanges: [[0x1000, 0x1000 + code.length + 2]],
    read32: (a) => view.getUint32(a, true),
    write32: (a, v) => view.setUint32(a, v, true),
    read: (a, width) => {
      reads.push([a, width]);
      if (a + width > data.length) throw Error('checked byte access failed');
      return data[a];
    },
  });
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
  cpu.af = 1;
  cpu.df = 1;
  return { cpu, data, reads };
}

for (const [code, base, offset] of [
  [[0xd7], 0x2000, 0x20ff],
  [[0x66, 0xd7], 0x2000, 0x20ff],
  [[0xd7], 0xffffff10, 0xf],
  [[0x67, 0xd7], 0x1ff80, 0x7f],
])
  test(`XLAT ${code} wraps its address and preserves upper EAX, other registers and flags`, () => {
    const { cpu, data, reads } = machine(code);
    try {
      cpu.r.forEach((r, i) => {
        r.value = i * 0x1234;
      });
      cpu.r[0].value = 0xa1b2c3ff;
      cpu.r[3].value = base;
      const registers = cpu.r.map((r) => r.value),
        flags = cpu.captureContext();
      data[offset] = 0x42;
      cpu.step(0x1000);
      assert.equal(cpu.r[0].value >>> 0, 0xa1b2c342);
      assert.deepEqual(reads, [[offset, 1]]);
      assert.deepEqual(
        cpu.r.slice(1).map((r) => r.value),
        registers.slice(1),
      );
      assert.deepEqual(cpu.f, flags.flags);
      assert.equal(cpu.af, 1);
      assert.equal(cpu.df, 1);
    } finally {
      cpu.dispose();
    }
  });

test('XLAT FS follows the current segment base without recompilation, after 16-bit offset wrapping', () => {
  const { cpu, data, reads } = machine([0x64, 0x67, 0xd7], 0x20000);
  try {
    cpu.r[3].value = 0x1fff0;
    cpu.r[0].value = 0x20;
    data[0x20010] = 7;
    cpu.step(0x1000);
    assert.equal(cpu.r[0].value, 7);
    cpu.fsBase = 0x10000;
    cpu.r[0].value = 0x20;
    data[0x10010] = 9;
    cpu.step(0x1000);
    assert.equal(cpu.r[0].value, 9);
    assert.equal(cpu.compilations, 1);
    assert.deepEqual(reads, [
      [0x20010, 1],
      [0x10010, 1],
    ]);
  } finally {
    cpu.dispose();
  }
});

test('XLAT faults before modifying AL, reports the exact instruction, and rejects LOCK/GS', () => {
  const { cpu } = machine([0x90, 0xd7]);
  try {
    cpu.r[0].value = 0x123456ff;
    cpu.r[3].value = 0x30000;
    assert.throws(() => cpu.step(0x1000), /checked byte access failed/);
    assert.equal(cpu.r[0].value, 0x123456ff);
    assert.equal(cpu.instructionIp, 0x1001);
  } finally {
    cpu.dispose();
  }
  for (const code of [
    [0xf0, 0xd7],
    [0x65, 0xd7],
  ]) {
    const { cpu } = machine(code);
    try {
      assert.throws(() => cpu.compile(0x1000), /Invalid|Unsupported/);
    } finally {
      cpu.dispose();
    }
  }
});
