import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { GuestMemory } from '../src/memory.js';

function machine(writable = true) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let cpu;
  const guest = new GuestMemory(
    memory,
    [
      { start: 0x1000, end: 0x8000, exec: true, write: writable },
      { start: 0x8000, end: 0x10000, write: true },
    ],
    {
      onCodeWrite: (address, size) => cpu.invalidateRange(address, size),
    },
  );
  cpu = new CPU(iced, {
    memory,
    executableRanges: [[0x1000, 0x8000, writable]],
    stackTop: 0xf000,
    read32: (a) => guest.read32(a),
    write32: (a, v) => guest.write32(a, v),
    read: (a, w) => guest.read(a, w),
    write: (a, v, w) => guest.write(a, v, w),
    check: (a, n, write) => guest.check(a, n, write),
  });
  return { cpu, guest };
}

test('writable x86 code is decoded after a store replaces the following instruction', () => {
  const { cpu, guest } = machine();
  // mov byte [0x1007],0xb8; <invalid old instruction>; immediate 42; jmp next
  guest.data.set([0xc6, 0x05, 7, 0x10, 0, 0, 0xb8, 0x0f, 42, 0, 0, 0, 0xeb, 0], 0x1000);
  assert.equal(cpu.step(0x1000), 0x1007);
  assert.equal(cpu.step(0x1007), 0x100e);
  assert.equal(cpu.r[0].value, 42);
});

test('code writes invalidate overlapping cached blocks but preserve unrelated blocks', () => {
  const { cpu, guest } = machine();
  guest.data.set([0xb8, 1, 0, 0, 0, 0xeb, 0], 0x1100);
  guest.data.set([0xb8, 2, 0, 0, 0, 0xeb, 0], 0x1200);
  cpu.step(0x1100);
  cpu.step(0x1200);
  const kept = cpu.cache.get(0x1200);
  guest.write32(0x1101, 42);
  assert.equal(cpu.cache.has(0x1100), false);
  assert.equal(cpu.cache.get(0x1200), kept);
  cpu.step(0x1100);
  assert.equal(cpu.r[0].value, 42);
  guest.write32(0x8000, 13);
  assert.equal(cpu.cache.size, 2);
});

test('writes to a trailing page evict a block that started on the preceding page', () => {
  const { cpu, guest } = machine();
  guest.data.set([0xb8, 1, 0, 0, 0, 0xeb, 0], 0x1ffd);
  cpu.step(0x1ffd);
  guest.write(0x2000, 1, 1);
  assert.equal(cpu.cache.has(0x1ffd), false);
  assert.equal(cpu.cachePages.size, 0);
  cpu.step(0x1ffd);
  assert.equal(cpu.r[0].value, 0x10001);
});

test('read-only code still rejects writes and retains its compiled block', () => {
  const { cpu, guest } = machine(false);
  guest.data.set([0xb8, 1, 0, 0, 0, 0xeb, 0], 0x1000);
  cpu.step(0x1000);
  const block = cpu.cache.get(0x1000);
  assert.throws(() => guest.write32(0x1001, 2), /write violation/);
  assert.equal(cpu.cache.get(0x1000), block);
  cpu.step(0x1000);
  assert.equal(cpu.r[0].value, 1);
});

test('the bounded block cache evicts old translations and can recompile them', () => {
  const { cpu, guest } = machine(false);
  for (let i = 0; i < 4097; i++) {
    const address = 0x1000 + i * 4;
    guest.data.set([0xb0, i & 255, 0xeb, 0], address);
    cpu.step(address);
  }
  assert.equal(cpu.cache.size, 4096);
  assert.equal(cpu.cache.has(0x1000), false);
  assert.equal(cpu.step(0x1000), 0x1004);
  assert.equal(cpu.r[0].value, 0);
  assert.equal(cpu.cache.size, 4096);
  cpu.clearCache();
  assert.equal(cpu.cachePages.size, 0);
});
