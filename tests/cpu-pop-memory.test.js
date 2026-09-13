import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;
function machine(code, check = () => {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(code, CODE);
  const view = new DataView(memory.buffer);
  const cpu = new CPU(iced, {
    memory,
    read32(address) {
      check(address, 4, false);
      return view.getUint32(address, true);
    },
    write32(address, value) {
      check(address, 4, true);
      view.setUint32(address, value, true);
    },
    read(address, width) {
      check(address, width, false);
      return width === 1
        ? view.getUint8(address)
        : width === 2
          ? view.getUint16(address, true)
          : view.getUint32(address, true);
    },
    write(address, value, width) {
      check(address, width, true);
      if (width === 1) view.setUint8(address, value);
      else if (width === 2) view.setUint16(address, value, true);
      else view.setUint32(address, value, true);
    },
    check,
    executableRanges: [[CODE, CODE + code.length]],
    stackTop: 0x8000,
  });
  return { cpu, view };
}

test('POP r/m32 stores the old stack top to a register-based memory destination', () => {
  const { cpu, view } = machine([0x8f, 0x00]); // pop dword ptr [eax]
  cpu.r[0].value = 0x4000;
  view.setUint32(0x8000, 0x12345678, true);

  cpu.step(CODE);

  assert.equal(view.getUint32(0x4000, true), 0x12345678);
  assert.equal(cpu.r[4].value >>> 0, 0x8004);
  assert.equal(cpu.r[0].value >>> 0, 0x4000);
});

test('POP [ESP+disp] calculates its destination from the incremented ESP', () => {
  const { cpu, view } = machine([0x8f, 0x44, 0x24, 0x04]); // pop dword ptr [esp+4]
  view.setUint32(0x8000, 0xaabbccdd, true);

  cpu.step(CODE);

  assert.equal(cpu.r[4].value >>> 0, 0x8004);
  assert.equal(
    view.getUint32(0x8008, true),
    0xaabbccdd,
    'the target is new ESP plus four, not old ESP plus four',
  );
});

test('POP [ESP] overwrites the next stack slot after reading the old top', () => {
  const { cpu, view } = machine([0x8f, 0x04, 0x24]); // pop dword ptr [esp]
  view.setUint32(0x8000, 0xfeedface, true);
  view.setUint32(0x8004, 0x11111111, true);

  cpu.step(CODE);

  assert.equal(cpu.r[4].value >>> 0, 0x8004);
  assert.equal(view.getUint32(0x8000, true), 0xfeedface);
  assert.equal(view.getUint32(0x8004, true), 0xfeedface);
});

test('POP register forms retain POP ESP semantics', () => {
  const { cpu, view } = machine([0x5c]); // pop esp
  view.setUint32(0x8000, 0x9000, true);
  cpu.step(CODE);
  assert.equal(cpu.r[4].value >>> 0, 0x9000);
});

test('a stack read or destination write fault leaves ESP unchanged', () => {
  const blocked = new Set();
  const check = (address, size, write) => {
    if (blocked.has(`${address}:${write ? 'w' : 'r'}`)) throw Error('protected memory');
  };
  const stackFault = machine([0x8f, 0x00], check);
  stackFault.cpu.r[0].value = 0x4000;
  blocked.add('32768:r');
  assert.throws(() => stackFault.cpu.step(CODE), /protected memory/);
  assert.equal(stackFault.cpu.r[4].value >>> 0, 0x8000);

  blocked.clear();
  const storeFault = machine([0x8f, 0x00], check);
  storeFault.cpu.r[0].value = 0x4000;
  storeFault.view.setUint32(0x8000, 0x12345678, true);
  blocked.add('16384:w');
  assert.throws(() => storeFault.cpu.step(CODE), /protected memory/);
  assert.equal(storeFault.cpu.r[4].value >>> 0, 0x8000);
  assert.equal(storeFault.view.getUint32(0x4000, true), 0);
});

test('POP r/m16 remains explicitly unsupported', () => {
  const { cpu } = machine([0x66, 0x8f, 0x00]); // pop word ptr [eax]
  assert.throws(() => cpu.step(CODE), /16-bit POP unsupported/);
});
