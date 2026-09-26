import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { GuestMemory } from '../src/memory.js';
const CODE = 0x1000;
function machine(width, kind, { memoryOperand = false, sourceRegister = 3 } = {}) {
  const code = [
    ...(width === 16 ? [0x66] : []),
    width === 8 ? 0xf6 : 0xf7,
    (memoryOperand ? 0x05 : 0xc0 | sourceRegister) | ((4 + kind) << 3),
    ...(memoryOperand ? [0, 0x20, 0, 0] : []),
  ];
  const memory = new WebAssembly.Memory({ initial: 1 }),
    data = new Uint8Array(memory.buffer),
    view = new DataView(memory.buffer);
  data.set(code, CODE);
  const guest = new GuestMemory(memory, [
    { start: CODE, end: CODE + code.length, exec: true },
    { start: 0x2000, end: 0x2004, read: true, write: false },
  ]);
  const cpu = new CPU(iced, {
    memory,
    executableRanges: [[CODE, CODE + code.length]],
    read32: (a) => guest.read32(a),
    write32: (a, v) => guest.write32(a, v),
    read: (a, w) => guest.read(a, w),
    write: (a, v, w) => guest.write(a, v, w),
    check: (a, n, w) => guest.check(a, n, w),
  });
  return { cpu, view, code, guest };
}
const sentinelA = 0xa1b20000,
  sentinelD = 0xc3d40000;
const cases = [
  // width, MUL/IMUL/DIV/IDIV, EAX, EDX, operand, EAX result, EDX result, carry
  [8, 0, sentinelA | 0xff, 0x12345678, 2, sentinelA | 0x1fe, 0x12345678, 1],
  [8, 0, sentinelA | 0x7f, 0x12345678, 2, sentinelA | 0xfe, 0x12345678, 0],
  [8, 1, sentinelA | 0x80, 0x12345678, 1, sentinelA | 0xff80, 0x12345678, 0],
  [8, 1, sentinelA | 0x80, 0x12345678, 0xff, sentinelA | 0x80, 0x12345678, 1],
  [8, 1, sentinelA | 0xff, 0x12345678, 1, sentinelA | 0xffff, 0x12345678, 0],
  [16, 0, sentinelA | 0xffff, sentinelD, 0xffff, sentinelA | 1, sentinelD | 0xfffe, 1],
  [16, 1, sentinelA | 0x8000, sentinelD, 1, sentinelA | 0x8000, sentinelD | 0xffff, 0],
  [16, 1, sentinelA | 0x8000, sentinelD, 0xffff, sentinelA | 0x8000, sentinelD, 1],
  [32, 0, 0xffffffff, 0x12345678, 2, 0xfffffffe, 1, 1],
  [32, 1, 0x80000000, 0x12345678, 0xffffffff, 0x80000000, 0, 1],
  [32, 1, 0xfffffffe, 0x12345678, 3, 0xfffffffa, 0xffffffff, 0],
  [8, 2, sentinelA | 0x1000, 0x12345678, 17, sentinelA | 0x10f0, 0x12345678, null],
  [8, 2, sentinelA | 0xfeff, 0x12345678, 255, sentinelA | 0xfeff, 0x12345678, null],
  [8, 3, sentinelA | 0xffeb, 0x12345678, 4, sentinelA | 0xfffb, 0x12345678, null],
  [8, 3, sentinelA | 0xffeb, 0x12345678, 0xfc, sentinelA | 0xff05, 0x12345678, null],
  [8, 3, sentinelA | 21, 0x12345678, 0xfc, sentinelA | 0x01fb, 0x12345678, null],
  [16, 2, sentinelA, sentinelD | 1, 3, sentinelA | 21845, sentinelD | 1, null],
  [16, 3, sentinelA | 0xffeb, sentinelD | 0xffff, 4, sentinelA | 0xfffb, sentinelD | 0xffff, null],
  [16, 3, sentinelA | 21, sentinelD, 0xfffc, sentinelA | 0xfffb, sentinelD | 1, null],
  [32, 2, 0, 1, 3, 1431655765, 1, null],
  [32, 3, 0xffffffeb, 0xffffffff, 4, 0xfffffffb, 0xffffffff, null],
  [32, 3, 21, 0, 0xfffffffc, 0xfffffffb, 1, null],
];
test('all one-operand arithmetic widths preserve register halves and produce exact signed/unsigned results', () => {
  for (const [width, kind, a, d, b, resultA, resultD, carry] of cases)
    for (const memoryOperand of [false, true]) {
      const { cpu, view, code } = machine(width, kind, { memoryOperand });
      cpu.r[0].value = a | 0;
      cpu.r[2].value = d | 0;
      cpu.r[3].value = b | 0;
      view.setUint32(0x2000, b >>> 0, true);
      const before = { cf: 0, of: 1, zf: 1, sf: 1, pf: 0 };
      cpu.f = { ...before };
      cpu.af = 1;
      assert.equal(cpu.step(CODE), CODE + code.length);
      assert.equal(cpu.r[0].value >>> 0, resultA >>> 0, `${width}/${kind} EAX`);
      assert.equal(cpu.r[2].value >>> 0, resultD >>> 0, `${width}/${kind} EDX`);
      assert.equal(cpu.r[3].value >>> 0, b >>> 0);
      assert.deepEqual(cpu.f, carry === null ? before : { ...before, cf: carry, of: carry });
      assert.equal(cpu.af, 1);
    }
});

test('division by zero and signed/unsigned quotient overflow leave registers and flags unchanged', () => {
  for (const [width, kind, a, d, b] of [
    [8, 2, 0x100, 1, 1],
    [8, 2, 0xff00, 0, 255],
    [8, 3, 0xff80, 0, 255],
    [8, 3, 0x80, 0, 1],
    [16, 2, 0, 1, 1],
    [16, 3, 0x8000, 0xffff, 0xffff],
    [16, 3, 0x8000, 0, 1],
    [32, 2, 0, 1, 1],
    [32, 3, 0x80000000, 0xffffffff, 0xffffffff],
    ...[8, 16, 32].flatMap((width) => [2, 3].map((kind) => [width, kind, 123, 1, 0])),
  ]) {
    const { cpu } = machine(width, kind);
    cpu.r[0].value = a | 0;
    cpu.r[2].value = d | 0;
    cpu.r[3].value = b | 0;
    cpu.f = { cf: 1, of: 1, zf: 1, sf: 1, pf: 0 };
    cpu.af = 1;
    const regs = cpu.r.map((r) => r.value),
      flags = { ...cpu.f };
    assert.throws(() => cpu.step(CODE), b ? /divide overflow/ : /divide by zero/);
    assert.deepEqual(
      cpu.r.map((r) => r.value),
      regs,
    );
    assert.deepEqual(cpu.f, flags);
    assert.equal(cpu.af, 1);
  }
});

test('byte high-register operands are read before AX changes; word DX operands precede output writes', () => {
  const ah = machine(8, 0, { sourceRegister: 4 }); // MUL AH: AL=3, AH=5 -> AX=15
  ah.cpu.r[0].value = 0x12340503;
  ah.cpu.step(CODE);
  assert.equal(ah.cpu.r[0].value, 0x1234000f);
  const dx = machine(16, 1, { sourceRegister: 2 });
  dx.cpu.r[0].value = 0x1234fffd;
  dx.cpu.r[2].value = 0x5678fffe;
  dx.cpu.step(CODE);
  assert.equal(dx.cpu.r[0].value, 0x12340006);
  assert.equal(dx.cpu.r[2].value, 0x56780000);
});

test('faulting arithmetic memory reads do not change output registers or flags', () => {
  for (const width of [8, 16, 32])
    for (const kind of [0, 1, 2, 3]) {
      const { cpu, guest } = machine(width, kind, { memoryOperand: true });
      guest.regions.splice(1, 1);
      cpu.r[0].value = 0x11223344;
      cpu.r[2].value = 0x55667788;
      cpu.f = { cf: 1, of: 1, zf: 1, sf: 1, pf: 0 };
      cpu.af = 1;
      assert.throws(() => cpu.step(CODE), /read violation/);
      assert.equal(cpu.r[0].value, 0x11223344);
      assert.equal(cpu.r[2].value, 0x55667788);
      assert.deepEqual(cpu.f, { cf: 1, of: 1, zf: 1, sf: 1, pf: 0 });
      assert.equal(cpu.af, 1);
    }
});
