import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { fprem } from '../src/x87-transcendentals.js';
const { vectors } = JSON.parse(
  await readFile(new URL('./fixtures/x87-remainder-vectors.json', import.meta.url)),
);
const hex = (bytes) => Buffer.from(bytes).toString('hex');

test('FPREM and FPREM1 agree with an independent rational oracle for ext80 results and quotient bits', () => {
  for (const v of vectors) {
    let a = Buffer.from(v.a, 'hex'),
      b = Buffer.from(v.b, 'hex'),
      result,
      steps = 0,
      flags = 0;
    do {
      result = fprem(a, b, v.nearest);
      a = result.bytes;
      flags |= result.flags;
      assert.ok(++steps <= 2048, `partial reduction terminates ${v.a} / ${v.b}`);
    } while (result.partial);
    assert.equal(hex(result.bytes), v.result, `${v.a} / ${v.b}, nearest=${v.nearest}`);
    assert.equal(flags, v.status & 0x3f);
    if (result.condition !== null) assert.equal(result.condition, v.status & 0x4700);
  }
});

async function machine(nearest) {
  const memory = new WebAssembly.Memory({ initial: 1 }),
    view = new DataView(memory.buffer);
  new Uint8Array(memory.buffer).set([0xd9, nearest ? 0xf5 : 0xf8, 0xeb, 0xfc], 0x1000);
  const cpu = new CPU(iced, {
    memory,
    read32: (a) => view.getUint32(a, true),
    write32: (a, v) => view.setUint32(a, v, true),
    executableRanges: [[0x1000, 0x1004]],
  });
  await cpu.initialize();
  return cpu;
}

test('compiled remainder instructions preserve ST1, TOP and integer flags across control modes and partial loops', async () => {
  for (const nearest of [false, true]) {
    const cpu = await machine(nearest);
    try {
      for (const v of vectors.filter((v) => v.nearest === nearest))
        for (const pc of [0, 2, 3])
          for (const rc of [0, 1, 2, 3]) {
            cpu.x87.reset();
            cpu.x87.control = 0x7f | (pc << 8) | (rc << 10);
            cpu.x87.top = 3;
            cpu.x87.tags[3] = cpu.x87.tags[4] = 0;
            cpu.x87.values[3].set(Buffer.from(v.a, 'hex'));
            cpu.x87.values[4].set(Buffer.from(v.b, 'hex'));
            cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
            cpu.af = 1;
            cpu.df = 1;
            let steps = 0;
            do {
              cpu.step(0x1000);
              assert.ok(++steps <= 2048);
            } while (cpu.x87.status & 0x400);
            assert.equal(hex(cpu.x87.values[3]), v.result);
            assert.equal(hex(cpu.x87.values[4]), v.b);
            assert.equal(cpu.x87.top, 3);
            assert.equal(cpu.x87.status & 0x3f, v.status & 0x3f);
            if (!(v.status & 1) && !/7fff$|ffff$/.test(v.a))
              assert.equal(cpu.x87.status & 0x4700, v.status & 0x4700);
            assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
            assert.equal(cpu.af, 1);
            assert.equal(cpu.df, 1);
          }
    } finally {
      cpu.dispose();
    }
  }
});

test('unmasked invalid/denormal and empty-stack remainders fail before replacing operands', async () => {
  const cpu = await machine(false);
  try {
    for (const [a, b, mask] of [
      ['0000000000000080ff7f', '0000000000000080ff3f', 1],
      ['01000000000000000000', '0000000000000080ff3f', 2],
    ]) {
      cpu.x87.reset();
      cpu.x87.control &= ~mask;
      cpu.x87.tags[0] = cpu.x87.tags[1] = 0;
      cpu.x87.values[0].set(Buffer.from(a, 'hex'));
      cpu.x87.values[1].set(Buffer.from(b, 'hex'));
      assert.throws(() => cpu.step(0x1000), /Unmasked x87 exception/);
      assert.equal(hex(cpu.x87.values[0]), a);
      assert.equal(hex(cpu.x87.values[1]), b);
    }
    cpu.x87.reset();
    cpu.x87.control &= ~1;
    assert.throws(() => cpu.step(0x1000), /Unmasked x87 exception/);
    assert.equal(cpu.x87.top, 0);
    assert.equal(cpu.x87.tags[0], 3);
  } finally {
    cpu.dispose();
  }
});
