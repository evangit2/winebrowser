import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { GuestMemory } from '../src/memory.js';

function machine(code) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set([...code, 0xeb, 0], 0x1000);
  const regions = [
    { start: 0x1000, end: 0x2000, exec: true },
    { start: 0x8000, end: 0x9000, write: true },
  ];
  const guest = new GuestMemory(memory, regions);
  const cpu = new CPU(iced, {
    memory,
    stackTop: 0x9000,
    executableRanges: [[0x1000, 0x1000 + code.length + 2]],
    read32: (a) => guest.read32(a),
    write32: (a, v) => guest.write32(a, v),
    read: (a, w) => guest.read(a, w),
    write: (a, v, w) => guest.write(a, v, w),
    check: (a, n, write) => guest.check(a, n, write),
  });
  return { cpu, guest };
}

test('REP return hints and BND returns preserve the ordinary 32-bit stack ABI with MPX disabled', () => {
  for (const prefix of [0xf2, 0xf3]) {
    for (const popBytes of [0, 8]) {
      const { cpu, guest } = machine([prefix, ...(popBytes ? [0xc2, popBytes, 0] : [0xc3])]);
      cpu.r[4].value = 0x8800;
      guest.write32(0x8800, 0x12345678);
      cpu.r[1].value = 99;
      const flags = { ...cpu.f };
      assert.equal(cpu.step(0x1000) >>> 0, 0x12345678);
      assert.equal(cpu.r[4].value, 0x8804 + popBytes);
      assert.equal(cpu.r[1].value, 99, 'the prefix does not repeat the return');
      assert.deepEqual(cpu.f, flags);
    }
  }
  const bad = machine([0xf2, 0x40]);
  assert.throws(() => bad.cpu.step(0x1000), /Repeat prefix unsupported/);
});

test('MPX-disabled BND conditional and indirect branches use normal control flow', () => {
  const { cpu } = machine([0xf2, 0x72, 2]);
  cpu.f.cf = 1;
  assert.equal(cpu.step(0x1000), 0x1005);
  cpu.f.cf = 0;
  assert.equal(cpu.step(0x1000), 0x1003);
  const indirect = machine([0xf2, 0xff, 0xe0]);
  indirect.cpu.r[0].value = 0x12345678;
  assert.equal(indirect.cpu.step(0x1000) >>> 0, 0x12345678);
});

test('memory fences preserve ordered private guest-memory writes and register state', () => {
  for (const operation of [0xe8, 0xf0, 0xf8]) {
    const { cpu, guest } = machine([
      0xc7,
      0x05,
      0x00,
      0x88,
      0,
      0,
      42,
      0,
      0,
      0,
      0x0f,
      0xae,
      operation,
      0xa1,
      0x00,
      0x88,
      0,
      0,
    ]);
    cpu.r[1].value = 77;
    cpu.step(0x1000);
    assert.equal(guest.read32(0x8800), 42);
    assert.equal(cpu.r[0].value, 42);
    assert.equal(cpu.r[1].value, 77);
  }
});

test('PUSHF/PUSHFD encode flags and POPF/POPFD preserve privileged bits at CPL3', () => {
  for (const width of [2, 4]) {
    const { cpu, guest } = machine([...(width === 2 ? [0x66] : []), 0x9c]);
    cpu.f = { cf: 1, pf: 1, zf: 1, sf: 1, of: 1 };
    cpu.af = 1;
    cpu.df = 1;
    cpu.controlFlags = 0x244000;
    cpu.step(0x1000);
    assert.equal(cpu.r[4].value, 0x9000 - width);
    assert.equal(guest.read(cpu.r[4].value, width), width === 2 ? 0x4ed7 : 0x244ed7);
    const other = machine([...(width === 2 ? [0x66] : []), 0x9d]);
    other.cpu.r[4].value -= width;
    other.guest.write(other.cpu.r[4].value, 0x244cd5 | 0x3000 | 0x30000, width);
    other.cpu.step(0x1000);
    assert.deepEqual(other.cpu.f, cpu.f);
    assert.equal(other.cpu.df, 1);
    assert.equal(other.cpu.af, 1);
    assert.equal(other.cpu.controlFlags, width === 2 ? 0x4000 : 0x244000);
    assert.equal(other.cpu.r[4].value, 0x9000);
  }
});

test('16-bit POPF leaves the ID and AC flags intact and rejects single-step without consuming the stack', () => {
  const { cpu, guest } = machine([0x66, 0x9d]);
  cpu.r[4].value = 0x8ffe;
  cpu.controlFlags = 0x240000;
  guest.write(0x8ffe, 2, 2);
  cpu.step(0x1000);
  assert.equal(cpu.controlFlags, 0x240000);
  cpu.r[4].value = 0x8ffe;
  guest.write(0x8ffe, 0x101, 2);
  const flags = { ...cpu.f };
  assert.throws(() => cpu.step(0x1000), /single-step/);
  assert.equal(cpu.r[4].value, 0x8ffe);
  assert.deepEqual(cpu.f, flags);
});

test('PUSHA/PUSHAD store the original stack pointer and POPA/POPAD skip its saved slot', () => {
  for (const width of [2, 4]) {
    const prefix = width === 2 ? [0x66] : [];
    const { cpu, guest } = machine([...prefix, 0x60, 0xeb, 0, ...prefix, 0x61]);
    const initial = [
      0x12340001, 0x23450002, 0x34560003, 0x45670004, 0x9000, 0x56780005, 0x67890006, 0x78900007,
    ];
    initial.forEach((v, i) => (cpu.r[i].value = v));
    const next = cpu.step(0x1000);
    const stack = 0x9000 - 8 * width;
    assert.equal(cpu.r[4].value, stack);
    for (let i = 0; i < 8; i++)
      assert.equal(
        guest.read(stack + i * width, width),
        width === 4 ? initial[7 - i] : initial[7 - i] & 0xffff,
      );
    guest.write(stack + 3 * width, 0xdeadbeef, width);
    for (let i = 0; i < 8; i++) if (i !== 4) cpu.r[i].value = 0xabcd0000;
    cpu.step(next);
    for (let i = 0; i < 8; i++)
      assert.equal(
        cpu.r[i].value >>> 0,
        i === 4 ? 0x9000 : width === 4 ? initial[i] : (0xabcd0000 | (initial[i] & 0xffff)) >>> 0,
      );
  }
});

test('stack-state memory faults do not partially overwrite registers, stack or flags', () => {
  for (const opcode of [0x60, 0x61, 0x9c, 0x9d]) {
    const { cpu, guest } = machine([opcode]);
    cpu.r[4].value = opcode === 0x60 || opcode === 0x9c ? 0x8001 : 0x8ffe;
    const regs = cpu.r.map((r) => r.value),
      flags = { ...cpu.f },
      before = guest.data.slice();
    assert.throws(() => cpu.step(0x1000), /Guest (read|write) violation/);
    assert.deepEqual(
      cpu.r.map((r) => r.value),
      regs,
    );
    assert.deepEqual(cpu.f, flags);
    assert.deepEqual(guest.data, before);
  }
});
