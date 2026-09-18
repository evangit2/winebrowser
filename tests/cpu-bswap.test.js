import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;

function machine(code) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(code, CODE);
  const view = new DataView(memory.buffer);
  let writes = 0;
  const cpu = new CPU(iced, {
    memory,
    read32: (address) => view.getUint32(address, true),
    write32: (address, value) => {
      writes++;
      view.setUint32(address, value, true);
    },
    executableRanges: [[CODE, CODE + code.length]],
    stackTop: 0xf000,
  });
  return { cpu, writes: () => writes };
}

test('BSWAP reverses all four bytes for every 32-bit register without changing flags', () => {
  const values = [
    0x12345678, 0x80000001, 0x00010203, 0xff00aa55, 0x01234567, 0xdeadbeef, 0, 0xffffffff,
  ];
  for (let register = 0; register < 8; register++) {
    const { cpu, writes } = machine([0x0f, 0xc8 + register]);
    const before = values.map(
      (value, index) => (index === register ? value : value ^ 0xa5a5a5a5) >>> 0,
    );
    before.forEach((value, index) => {
      cpu.r[index].value = value;
    });
    cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };

    assert.equal(cpu.step(CODE), CODE + 2);
    const value = before[register];
    const reversed =
      ((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | (value >>> 24);
    assert.equal(cpu.r[register].value >>> 0, reversed >>> 0, `register ${register}`);
    for (let other = 0; other < 8; other++) {
      if (other !== register)
        assert.equal(cpu.r[other].value >>> 0, before[other], `register ${other}`);
    }
    assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
    assert.equal(writes(), 0, 'BSWAP must not touch the stack, including for ESP');
  }
});

test('two BSWAP instructions restore the original value', () => {
  const { cpu } = machine([0x0f, 0xca, 0x0f, 0xca]); // bswap edx twice
  for (const value of [0x00000000, 0x12345678, 0x80000001, 0xffffffff]) {
    cpu.r[2].value = value;
    assert.equal(cpu.step(CODE), CODE + 4);
    assert.equal(cpu.r[2].value >>> 0, value);
  }
});

test('16-bit BSWAP is explicitly rejected before changing state', () => {
  const { cpu } = machine([0x66, 0x0f, 0xca]); // undefined bswap dx
  cpu.r[2].value = 0x12345678;
  assert.throws(() => cpu.step(CODE), /BSWAP requires a 32-bit register.*16-bit form is undefined/);
  assert.equal(cpu.r[2].value >>> 0, 0x12345678);
});
