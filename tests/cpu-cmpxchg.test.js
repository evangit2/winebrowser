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

const reg = (cpu, index) => cpu.r[index].value >>> 0;

test('CMPXCHG register success writes source and sets subtraction flags', () => {
  const { cpu } = machine([0x0f, 0xb1, 0xcb]); // cmpxchg ebx, ecx
  cpu.r[0].value = 0x12345678;
  cpu.r[1].value = 0x87654321;
  cpu.r[3].value = 0x12345678;
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };

  cpu.step(CODE);

  assert.equal(reg(cpu, 3), 0x87654321);
  assert.equal(reg(cpu, 0), 0x12345678);
  assert.deepEqual(cpu.f, { cf: 0, zf: 1, sf: 0, of: 0, pf: 1 });
});

test('CMPXCHG mismatch copies old destination to EAX and preserves destination', () => {
  const { cpu } = machine([0x0f, 0xb1, 0xcb]); // cmpxchg ebx, ecx
  cpu.r[0].value = 0x100;
  cpu.r[1].value = 0x87654321;
  cpu.r[3].value = 0x80;

  cpu.step(CODE);

  assert.equal(reg(cpu, 3), 0x80);
  assert.equal(reg(cpu, 0), 0x80);
  assert.deepEqual(cpu.f, { cf: 0, zf: 0, sf: 0, of: 0, pf: 0 });
});

test('CMPXCHG sets overflow for signed accumulator subtraction at dword width', () => {
  const { cpu } = machine([0x0f, 0xb1, 0xcb]); // cmpxchg ebx, ecx
  cpu.r[0].value = 0x80000000;
  cpu.r[1].value = 0x76543210;
  cpu.r[3].value = 1;

  cpu.step(CODE);

  assert.equal(reg(cpu, 0), 1);
  assert.equal(reg(cpu, 3), 1);
  assert.deepEqual(cpu.f, { cf: 0, zf: 0, sf: 0, of: 1, pf: 1 });
});

test('byte and word register destinations preserve unaffected bits on both outcomes', () => {
  const byte = machine([0x0f, 0xb0, 0xdc]); // cmpxchg ah, bl
  byte.cpu.r[0].value = 0x12345555; // AH matches AL.
  byte.cpu.r[3].value = 0xabcdefee;
  byte.cpu.step(CODE);
  assert.equal(reg(byte.cpu, 0), 0x1234ee55);
  assert.deepEqual(byte.cpu.f, { cf: 0, zf: 1, sf: 0, of: 0, pf: 1 });

  const word = machine([0x66, 0x0f, 0xb1, 0xd1]); // cmpxchg cx, dx
  word.cpu.r[0].value = 0x12345555; // AX mismatches CX.
  word.cpu.r[1].value = 0x76540080;
  word.cpu.r[2].value = 0xbeef;
  word.cpu.step(CODE);
  assert.equal(reg(word.cpu, 0), 0x12340080);
  assert.equal(reg(word.cpu, 1), 0x76540080);
  assert.deepEqual(word.cpu.f, { cf: 0, zf: 0, sf: 0, of: 0, pf: 0 });
});

test('byte mismatch updates AL while preserving the rest of EAX', () => {
  const { cpu } = machine([0x0f, 0xb0, 0xdc]); // cmpxchg ah, bl
  cpu.r[0].value = 0x12345544; // AL mismatches AH.
  cpu.r[3].value = 0xee;

  cpu.step(CODE);

  assert.equal(reg(cpu, 0), 0x12345555);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 0, pf: 0 });
});

test('CMPXCHG memory match stores source and snapshots [EAX] before writes', () => {
  const { cpu, view } = machine([0x0f, 0xb1, 0x08]); // cmpxchg dword ptr [eax], ecx
  cpu.r[0].value = 0x2000;
  cpu.r[1].value = 0x76543210;
  view.setUint32(0x2000, 0x2000, true);

  cpu.step(CODE);

  assert.equal(view.getUint32(0x2000, true), 0x76543210);
  assert.equal(reg(cpu, 0), 0x2000);
  assert.deepEqual(cpu.f, { cf: 0, zf: 1, sf: 0, of: 0, pf: 1 });
});

test('CMPXCHG memory mismatch still checks write access and uses captured [EAX] address', () => {
  let writeChecks = 0;
  const { cpu, view } = machine([0x0f, 0xb1, 0x08], {
    check(address, size, isWrite) {
      if (isWrite) writeChecks++;
      return address;
    },
  });
  cpu.r[0].value = 0x2000;
  cpu.r[1].value = 0x76543210;
  view.setUint32(0x2000, 0x80, true);

  cpu.step(CODE);

  assert.equal(writeChecks, 1);
  assert.equal(view.getUint32(0x2000, true), 0x80);
  assert.equal(reg(cpu, 0), 0x80);
});

test('byte CMPXCHG memory access stays at the requested width', () => {
  const { cpu, view } = machine([0x0f, 0xb0, 0x18]); // cmpxchg byte ptr [eax], bl
  cpu.r[0].value = 0x2000;
  cpu.r[3].value = 0x123456aa;
  view.setUint8(0x2000, 0x00);

  cpu.step(CODE);

  assert.equal(view.getUint8(0x2000), 0xaa);
  assert.equal(reg(cpu, 0), 0x2000);
});

test('CMPXCHG memory source can alias EAX', () => {
  const { cpu, view } = machine([0x0f, 0xb1, 0x02]); // cmpxchg dword ptr [edx], eax
  cpu.r[0].value = 0x12345678;
  cpu.r[2].value = 0x3000;
  view.setUint32(0x3000, 0x12345678, true);

  cpu.step(CODE);

  assert.equal(view.getUint32(0x3000, true), 0x12345678);
  assert.equal(reg(cpu, 0), 0x12345678);
  assert.deepEqual(cpu.f, { cf: 0, zf: 1, sf: 0, of: 0, pf: 1 });
});

test('CMPXCHG handles the accumulator register as its own destination', () => {
  const { cpu } = machine([0x0f, 0xb1, 0xc8]); // cmpxchg eax, ecx
  cpu.r[0].value = 0x12345678;
  cpu.r[1].value = 0xabcdef01;

  cpu.step(CODE);

  assert.equal(reg(cpu, 0), 0xabcdef01);
  assert.deepEqual(cpu.f, { cf: 0, zf: 1, sf: 0, of: 0, pf: 1 });
});

test('write-protection fault on CMPXCHG mismatch leaves CPU flags and registers unchanged', () => {
  const { cpu, view } = machine([0x0f, 0xb1, 0x08], {
    check(address, size, isWrite) {
      if (isWrite) throw Error('read-only guest memory');
      return address;
    },
  });
  cpu.r[0].value = 0x2000;
  cpu.r[1].value = 0x76543210;
  view.setUint32(0x2000, 0x80, true);
  cpu.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };

  assert.throws(() => cpu.step(CODE), /read-only guest memory/);
  assert.equal(reg(cpu, 0), 0x2000);
  assert.equal(reg(cpu, 1), 0x76543210);
  assert.equal(view.getUint32(0x2000, true), 0x80);
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });
});

test('LOCK CMPXCHG is accepted only with a memory destination', () => {
  const memoryForm = machine([0xf0, 0x0f, 0xb1, 0x08]); // lock cmpxchg [eax], ecx
  memoryForm.cpu.r[0].value = 0x2000;
  memoryForm.cpu.r[1].value = 7;
  memoryForm.view.setUint32(0x2000, 0x2000, true);
  memoryForm.cpu.step(CODE);
  assert.equal(memoryForm.view.getUint32(0x2000, true), 7);

  const registerForm = machine([0xf0, 0x0f, 0xb1, 0xcb]); // lock cmpxchg ebx, ecx
  assert.throws(() => registerForm.cpu.step(CODE), /LOCK prefix requires|Invalid or truncated/);
});
