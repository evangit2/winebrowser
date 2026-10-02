import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { GuestMemory } from '../src/memory.js';

function machine(bytes) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set([...bytes, 0xeb, 0], 0x1000);
  const guest = new GuestMemory(memory, [
    { start: 0x1000, end: 0x2000, exec: true },
    { start: 0x8000, end: 0x9000, write: true },
  ]);
  const cpu = new CPU(iced, {
    memory,
    stackTop: 0x9000,
    executableRanges: [[0x1000, 0x1000 + bytes.length + 2]],
    read32: (p) => guest.read32(p),
    write32: (p, n) => guest.write32(p, n),
    read: (p, n) => guest.read(p, n),
    write: (p, n, width) => guest.write(p, n, width),
    check: (p, n, write) => guest.check(p, n, write),
  });
  return { cpu, guest };
}

test('native context captures read flat selectors without changing registers, flags or FS base', () => {
  for (const [segment, selector] of [
    [0, 0x23],
    [1, 0x1b],
    [2, 0x23],
    [3, 0x23],
    [4, 0x3b],
    [5, 0x23],
  ]) {
    const { cpu, guest } = machine([0x8c, 0x05 | (segment << 3), 0x00, 0x88, 0, 0]);
    guest.write32(0x8800, 0xaabbccdd);
    cpu.r[0].value = 42;
    const flags = { ...cpu.f },
      fsBase = cpu.fsBase;
    cpu.step(0x1000);
    assert.equal(
      guest.read32(0x8800),
      (0xaabb0000 | selector) >>> 0,
      'word store preserves upper context bytes',
    );
    assert.equal(cpu.r[0].value, 42);
    assert.deepEqual(cpu.f, flags);
    assert.equal(cpu.fsBase, fsBase);
  }
  const { cpu } = machine([0x8c, 0xe8]); // MOV EAX, GS zero-extends the selector.
  cpu.r[0].value = -1;
  cpu.step(0x1000);
  assert.equal(cpu.r[0].value, 0x23);
  const write = machine([0x8e, 0xe8]);
  assert.throws(
    () => write.cpu.step(0x1000),
    /Unsupported register/,
    'selector rebasing remains explicit',
  );
});

test('native FXSAVE/FXRSTOR preserve x87 stack order, abridged tags, XMM lanes and MXCSR', async () => {
  const { cpu, guest } = machine([
    0x0f, 0xae, 0x05, 0x00, 0x88, 0, 0, 0x0f, 0xae, 0x0d, 0x00, 0x88, 0, 0,
  ]);
  await cpu.prepare(0x1000);
  cpu.x87.pushDouble(1);
  cpu.x87.pushDouble(0);
  cpu.x87.pushDouble(-2);
  cpu.simd.registers[2].set([0x12345678, 0x87654321, 1, 0xffffffff]);
  cpu.simd.mxcsr = 0x3f80;
  const x87 = cpu.x87.snapshot(),
    simd = cpu.simd.snapshot();
  cpu.step(0x1000);
  assert.deepEqual(cpu.x87.snapshot(), x87, 'FXSAVE does not reset live FPU state');
  assert.equal(guest.read(0x8800, 2), x87.control);
  assert.equal(guest.read32(0x8818), simd.mxcsr);
  assert.equal(guest.read32(0x881c), 0xffff);
  cpu.x87.reset();
  cpu.simd.registers.forEach((r) => r.fill(0));
  cpu.simd.mxcsr = 0x1f80;
  // Restore in a separately compiled block so the reset occurs between calls.
  cpu.step(0x1007);
  assert.deepEqual(cpu.x87.snapshot(), x87);
  assert.deepEqual(cpu.simd.snapshot(), simd);
  cpu.x87.dispose();
});
