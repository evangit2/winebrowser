import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

function machine(code) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set([...code, 0xeb, 0], 0x1000);
  const view = new DataView(memory.buffer);
  return new CPU(iced, {
    memory,
    read32: (a) => view.getUint32(a, true),
    write32: (a, v) => view.setUint32(a, v, true),
    read: (a, width) => (width === 2 ? view.getUint16(a, true) : view.getUint32(a, true)),
    executableRanges: [[0x1000, 0x1000 + code.length + 2]],
    stackTop: 0xf000,
  });
}

test('BSF/BSR find low/high bits across the full dword and set ZF for zero', () => {
  for (const reverse of [false, true]) {
    const cpu = machine([0x0f, reverse ? 0xbd : 0xbc, 0xc2]); // eax,edx
    for (let bit = 0; bit < 32; bit++) {
      cpu.r[2].value = 1 << bit;
      cpu.step(0x1000);
      assert.equal(cpu.r[0].value, bit);
      assert.equal(cpu.f.zf, 0);
    }
    cpu.r[2].value = 0x80008008;
    cpu.step(0x1000);
    assert.equal(cpu.r[0].value, reverse ? 31 : 3);
    cpu.r[2].value = 0;
    cpu.step(0x1000);
    assert.equal(cpu.f.zf, 1);
  }
});

test('16-bit scans ignore upper source bits and preserve upper destination bits', () => {
  for (const reverse of [false, true]) {
    const cpu = machine([0x66, 0x0f, reverse ? 0xbd : 0xbc, 0xc2]);
    cpu.r[0].value = 0xabcd0000;
    cpu.r[2].value = 0xffff0088;
    cpu.step(0x1000);
    assert.equal(cpu.r[0].value >>> 0, reverse ? 0xabcd0007 : 0xabcd0003);
    cpu.r[2].value = 0xffff0000;
    cpu.step(0x1000);
    assert.equal(cpu.f.zf, 1);
  }
});

test('bit scans read memory before overwriting a destination used in its address', () => {
  for (const narrow of [false, true]) {
    const cpu = machine([...(narrow ? [0x66] : []), 0x0f, 0xbd, 0x00]); // (e)ax,[(e)ax]
    cpu.r[0].value = 0x2000;
    cpu.write32(0x2000, 0xffff0800);
    cpu.step(0x1000);
    assert.equal(cpu.r[0].value, narrow ? 11 : 31);
  }
});
