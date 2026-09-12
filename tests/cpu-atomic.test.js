import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;
const STACK = 0xf000;

function machine(code) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(code, CODE);
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
    executableRanges: [[CODE, CODE + code.length]],
    stackTop: STACK,
  });
  return { cpu, memory, view };
}

test('LOCK ADD performs the memory update and arithmetic flags at the operand width', () => {
  const { cpu, view } = machine([0xf0, 0x01, 0x18]); // lock add dword ptr [eax], ebx
  cpu.r[0].value = 0x2000;
  cpu.r[3].value = 1;
  view.setUint32(0x2000, 0x7fffffff, true);

  cpu.step(CODE);

  assert.equal(view.getUint32(0x2000, true), 0x80000000);
  assert.deepEqual(cpu.f, { cf: 0, zf: 0, sf: 1, of: 1, pf: 1 });
});

test('LOCK NOT and LOCK XCHG accept memory operands and preserve their semantics', () => {
  const { cpu, view } = machine([
    0xf0,
    0xf7,
    0x10, // lock not dword ptr [eax]
    0xf0,
    0x87,
    0x00, // lock xchg dword ptr [eax], eax
  ]);
  cpu.r[0].value = 0x2000;
  view.setUint32(0x2000, 0x12345678, true);
  cpu.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };

  cpu.step(CODE);

  assert.equal(view.getUint32(0x2000, true), 0x2000);
  assert.equal(cpu.r[0].value >>> 0, 0xedcba987);
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });
});

test('LOCK on a register-destination form is rejected as invalid by iced', () => {
  const { cpu } = machine([0xf0, 0x01, 0xc8]); // lock add eax, ecx (illegal)
  assert.throws(() => cpu.step(CODE), /Invalid or truncated x86 instruction/);
});

test('shared WebAssembly memory is rejected until host atomics are supported', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  assert.throws(
    () => new CPU(iced, { memory }),
    /Shared WebAssembly\.Memory is unsupported until host atomics are implemented/,
  );
});

test('PAUSE is a no-op and leaves guest flags and registers untouched', () => {
  const { cpu } = machine([0xf3, 0x90]); // pause
  cpu.r[0].value = 0x12345678;
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };

  cpu.step(CODE);

  assert.equal(cpu.r[0].value >>> 0, 0x12345678);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
});
