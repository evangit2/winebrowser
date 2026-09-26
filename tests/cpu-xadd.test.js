import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;

function machine(code, { check } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(code, CODE);
  const view = new DataView(memory.buffer);
  const read = (address, width) =>
    width === 1
      ? view.getUint8(address)
      : width === 2
        ? view.getUint16(address, true)
        : view.getUint32(address, true);
  const write = (address, value, width) => {
    if (width === 1) view.setUint8(address, value);
    else if (width === 2) view.setUint16(address, value, true);
    else view.setUint32(address, value, true);
  };
  const cpu = new CPU(iced, {
    memory,
    read32: (address) => view.getUint32(address, true),
    write32: (address, value) => view.setUint32(address, value, true),
    read,
    write,
    check,
    executableRanges: [[CODE, CODE + code.length]],
  });
  return { cpu, view };
}

test('XADD exchanges the original destination into source and stores the sum', () => {
  const { cpu } = machine([0x0f, 0xc1, 0xcb]); // xadd ebx,ecx
  cpu.r[3].value = 0x7fffffff;
  cpu.r[1].value = 1;
  cpu.step(CODE);
  assert.equal(cpu.r[3].value >>> 0, 0x80000000);
  assert.equal(cpu.r[1].value >>> 0, 0x7fffffff);
  assert.deepEqual(cpu.f, { cf: 0, zf: 0, sf: 1, of: 1, pf: 1 });
  assert.equal(cpu.af, 1);
});

test('byte/word XADD preserve unaffected fields and handle fields in one register', () => {
  const byte = machine([0x0f, 0xc0, 0xc4]); // xadd ah,al
  byte.cpu.r[0].value = 0x12340203;
  byte.cpu.step(CODE);
  assert.equal(byte.cpu.r[0].value >>> 0, 0x12340502);
  assert.deepEqual(byte.cpu.f, { cf: 0, zf: 0, sf: 0, of: 0, pf: 1 });

  const word = machine([0x66, 0x0f, 0xc1, 0xd1]); // xadd cx,dx
  word.cpu.r[1].value = 0xaaaaffff;
  word.cpu.r[2].value = 0xbbbb0001;
  word.cpu.step(CODE);
  assert.equal(word.cpu.r[1].value >>> 0, 0xaaaa0000);
  assert.equal(word.cpu.r[2].value >>> 0, 0xbbbbffff);
  assert.deepEqual(word.cpu.f, { cf: 1, zf: 1, sf: 0, of: 0, pf: 1 });
});

test('XADD with the same register leaves the architectural sum in that register', () => {
  const { cpu } = machine([0x0f, 0xc1, 0xdb]); // xadd ebx,ebx
  cpu.r[3].value = 0x40000000;
  cpu.step(CODE);
  assert.equal(cpu.r[3].value >>> 0, 0x80000000);
  assert.deepEqual(cpu.f, { cf: 0, zf: 0, sf: 1, of: 1, pf: 1 });
});

test('LOCK XADD memory captures an aliased address/source and checks write access once', () => {
  let writeChecks = 0;
  const { cpu, view } = machine([0xf0, 0x0f, 0xc1, 0x09], {
    check(address, size, write) {
      if (write) {
        writeChecks++;
        assert.deepEqual([address, size], [0x2000, 4]);
      }
      return address;
    },
  }); // lock xadd [ecx],ecx
  cpu.r[1].value = 0x2000;
  view.setUint32(0x2000, 7, true);
  cpu.step(CODE);
  assert.equal(view.getUint32(0x2000, true), 0x2007);
  assert.equal(cpu.r[1].value >>> 0, 7);
  assert.equal(writeChecks, 1);
});

test('XADD memory write faults before changing memory, source, or flags', () => {
  const { cpu, view } = machine([0xf0, 0x0f, 0xc1, 0x08], {
    check(address, size, write) {
      if (write) throw Error('read-only XADD destination');
      return address;
    },
  });
  cpu.r[0].value = 0x2000;
  cpu.r[1].value = 5;
  view.setUint32(0x2000, 7, true);
  cpu.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };
  cpu.af = 1;
  assert.throws(() => cpu.step(CODE), /read-only XADD destination/);
  assert.equal(view.getUint32(0x2000, true), 7);
  assert.equal(cpu.r[1].value >>> 0, 5);
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });
  assert.equal(cpu.af, 1);
});

test('LOCK XADD rejects a register destination', () => {
  const { cpu } = machine([0xf0, 0x0f, 0xc1, 0xcb]);
  assert.throws(() => cpu.step(CODE), /Invalid or truncated|LOCK prefix/);
});
