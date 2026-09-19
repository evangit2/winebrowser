import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;

function machine(code) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(code, CODE);
  const view = new DataView(memory.buffer);
  const cpu = new CPU(iced, {
    memory,
    read32: (address) => view.getUint32(address, true),
    write32: (address, value) => view.setUint32(address, value, true),
    read: (address, width) =>
      width === 1
        ? view.getUint8(address)
        : width === 2
          ? view.getUint16(address, true)
          : view.getUint32(address, true),
    write: (address, value, width) => {
      if (width === 1) view.setUint8(address, value);
      else if (width === 2) view.setUint16(address, value, true);
      else view.setUint32(address, value, true);
    },
    executableRanges: [[CODE, CODE + code.length]],
  });
  return { cpu, view };
}

test('REPNE SCASB stops after the first match and reports CMP flags', () => {
  const { cpu, view } = machine([0xf2, 0xae]);
  new Uint8Array(cpu.memory.buffer).set([0x61, 0x62, 0x63, 0x64], 0x2000);
  cpu.r[0].value = 0x12340063;
  cpu.r[7].value = 0x2000;
  cpu.r[1].value = 4;
  assert.equal(cpu.step(CODE), CODE + 2);
  assert.deepEqual([cpu.r[7].value >>> 0, cpu.r[1].value >>> 0], [0x2003, 1]);
  assert.equal(cpu.f.zf, 1);
  assert.equal(cpu.f.cf, 0);
  assert.equal(cpu.instructions, 3);
});

test('REPE SCASW stops on mismatch and STD SCASD walks backward', () => {
  const word = machine([0xf3, 0x66, 0xaf]);
  word.view.setUint16(0x2200, 0x1234, true);
  word.view.setUint16(0x2202, 0x1234, true);
  word.view.setUint16(0x2204, 0x1235, true);
  word.cpu.r[0].value = 0xabcd1234;
  word.cpu.r[7].value = 0x2200;
  word.cpu.r[1].value = 5;
  assert.equal(word.cpu.step(CODE), CODE + 3);
  assert.deepEqual([word.cpu.r[7].value >>> 0, word.cpu.r[1].value >>> 0], [0x2206, 2]);
  assert.equal(word.cpu.f.zf, 0);
  assert.equal(word.cpu.f.cf, 1);

  const dword = machine([0xfd, 0xaf]); // std; scasd
  dword.view.setUint32(0x3004, 0x01020304, true);
  dword.cpu.r[0].value = 0x01020304;
  dword.cpu.r[7].value = 0x3004;
  dword.cpu.r[1].value = 9;
  assert.equal(dword.cpu.step(CODE), CODE + 2);
  assert.equal(dword.cpu.r[7].value >>> 0, 0x3000);
  assert.equal(dword.cpu.r[1].value >>> 0, 9, 'unprefixed SCAS does not consume ECX');
  assert.equal(dword.cpu.f.zf, 1);
});

test('REP SCAS uses bounded chunks and zero count touches neither memory nor flags', () => {
  const chunked = machine([0xf2, 0xae]);
  new Uint8Array(chunked.cpu.memory.buffer, 0x4000, 1025).fill(0);
  chunked.cpu.r[0].value = 1;
  chunked.cpu.r[7].value = 0x4000;
  chunked.cpu.r[1].value = 1025;
  assert.equal(chunked.cpu.step(CODE), CODE);
  assert.deepEqual([chunked.cpu.r[7].value >>> 0, chunked.cpu.r[1].value >>> 0], [0x4400, 1]);
  assert.equal(chunked.cpu.step(CODE), CODE + 2);
  assert.equal(chunked.cpu.r[1].value >>> 0, 0);
  assert.equal(chunked.cpu.instructions, 1025);

  const zero = machine([0xf2, 0xae]).cpu;
  zero.r[7].value = 0xffffffff;
  zero.r[1].value = 0;
  zero.f = { cf: 1, zf: 1, sf: 1, of: 1, pf: 0 };
  zero.af = 1;
  assert.equal(zero.step(CODE), CODE + 2);
  assert.equal(zero.r[7].value >>> 0, 0xffffffff);
  assert.deepEqual(zero.f, { cf: 1, zf: 1, sf: 1, of: 1, pf: 0 });
  assert.equal(zero.af, 1);
});

test('a faulting REPNE SCAS iteration preserves completed progress and flags', () => {
  const { cpu, view } = machine([0xf2, 0xae]);
  view.setUint8(0xfffe, 1);
  view.setUint8(0xffff, 2);
  cpu.r[0].value = 3;
  cpu.r[7].value = 0xfffe;
  cpu.r[1].value = 3;
  assert.throws(() => cpu.step(CODE), /range violation/);
  assert.deepEqual([cpu.r[7].value >>> 0, cpu.r[1].value >>> 0], [0x10000, 1]);
  assert.equal(cpu.f.zf, 0);
  assert.equal(cpu.f.cf, 0, 'flags remain from the last completed comparison (3 - 2)');
});
