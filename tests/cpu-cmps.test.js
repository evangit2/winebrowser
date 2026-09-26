import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { GuestMemory } from '../src/memory.js';
const CODE = 0x1000;
function machine(code, { fsBase = 0 } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 }),
    data = new Uint8Array(memory.buffer),
    view = new DataView(memory.buffer);
  data.set(code, CODE);
  const guest = new GuestMemory(memory, [
    { start: CODE, end: CODE + code.length, exec: true },
    { start: 0x2000, end: 0x8000, read: true, write: false, exec: false },
  ]);
  const cpu = new CPU(iced, {
    memory,
    fsBase,
    executableRanges: [[CODE, CODE + code.length]],
    read32: (a) => guest.read32(a),
    write32: (a, v) => guest.write32(a, v),
    read: (a, w) => guest.read(a, w),
    write: (a, v, w) => guest.write(a, v, w),
    check: (a, n, w) => guest.check(a, n, w),
  });
  return { cpu, view, data, guest };
}
const expectedFlags = (left, right, bits) => {
  const a = BigInt(left),
    b = BigInt(right),
    value = BigInt.asUintN(bits, a - b);
  const signed = BigInt.asIntN(bits, a) - BigInt.asIntN(bits, b);
  const parity = [...Number(value & 255n).toString(2)].filter((x) => x === '1').length % 2 === 0;
  return {
    f: {
      cf: Number(a < b),
      zf: Number(value === 0n),
      sf: Number(value >= 1n << BigInt(bits - 1)),
      of: Number(signed < -(1n << BigInt(bits - 1)) || signed >= 1n << BigInt(bits - 1)),
      pf: Number(parity),
    },
    af: Number((a & 15n) < (b & 15n)),
  };
};

test('CMPS byte/word/dword compares source minus destination with all arithmetic flags', () => {
  for (const width of [1, 2, 4]) {
    const code = [...(width === 2 ? [0x66] : []), width === 1 ? 0xa6 : 0xa7],
      { cpu, view } = machine(code);
    const mask = 2 ** (8 * width) - 1,
      sign = 2 ** (8 * width - 1);
    const values =
      width === 1
        ? Array.from({ length: 256 }, (_, i) => i)
        : [0, 1, 15, 16, 127, 128, 255, 256, sign - 1, sign, sign + 1, mask];
    const put = (p, v) =>
      width === 1
        ? view.setUint8(p, v)
        : width === 2
          ? view.setUint16(p, v, true)
          : view.setUint32(p, v, true);
    for (const left of values)
      for (const right of values) {
        put(0x2000, left);
        put(0x4000, right);
        cpu.r[6].value = 0x2000;
        cpu.r[7].value = 0x4000;
        cpu.r[1].value = 29;
        cpu.r[0].value = 0x12345678;
        assert.equal(cpu.step(CODE), CODE + code.length);
        const expected = expectedFlags(left, right, width * 8);
        assert.deepEqual(cpu.f, expected.f, `${width}: ${left} - ${right}`);
        assert.equal(cpu.af, expected.af);
        assert.deepEqual(
          [cpu.r[6].value, cpu.r[7].value, cpu.r[1].value, cpu.r[0].value],
          [0x2000 + width, 0x4000 + width, 29, 0x12345678],
        );
      }
  }
});

test('REPE and REPNE stop after mismatch/match for all widths, independent of entry ZF', () => {
  for (const width of [1, 2, 4])
    for (const repeat of [0xf3, 0xf2])
      for (const backwards of [false, true]) {
        const code = [repeat, ...(width === 2 ? [0x66] : []), width === 1 ? 0xa6 : 0xa7],
          { cpu, view } = machine(code);
        const put = (p, v) =>
          width === 1
            ? view.setUint8(p, v)
            : width === 2
              ? view.setUint16(p, v, true)
              : view.setUint32(p, v, true);
        const delta = backwards ? -width : width;
        for (let i = 0; i < 4; i++) {
          put(0x2100 + delta * i, 42);
          put(0x4100 + delta * i, (i === 2) === (repeat === 0xf3) ? 43 : 42);
        }
        cpu.r[6].value = 0x2100;
        cpu.r[7].value = 0x4100;
        cpu.r[1].value = 4;
        cpu.df = Number(backwards);
        cpu.f.zf = Number(repeat === 0xf2);
        assert.equal(cpu.step(CODE), CODE + code.length);
        assert.deepEqual(
          [cpu.r[6].value, cpu.r[7].value, cpu.r[1].value],
          [0x2100 + 3 * delta, 0x4100 + 3 * delta, 1],
        );
        assert.equal(cpu.f.zf, Number(repeat === 0xf2));
        assert.equal(cpu.instructions, 3);
      }
});

test('zero-count comparisons do not access invalid memory or change flags; long repeats yield at 1024', () => {
  for (const prefix of [0xf3, 0xf2]) {
    const { cpu } = machine([prefix, 0xa6]);
    cpu.r[6].value = -1;
    cpu.r[7].value = -1;
    cpu.r[1].value = 0;
    cpu.f = { cf: 1, zf: 1, sf: 1, of: 1, pf: 0 };
    cpu.af = 1;
    assert.equal(cpu.step(CODE), CODE + 2);
    assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 1, of: 1, pf: 0 });
    assert.equal(cpu.af, 1);
    assert.deepEqual([cpu.r[6].value, cpu.r[7].value, cpu.r[1].value], [-1, -1, 0]);
  }
  const { cpu } = machine([0xf3, 0xa6]);
  cpu.r[6].value = 0x2000;
  cpu.r[7].value = 0x4000;
  cpu.r[1].value = 2050;
  assert.equal(cpu.step(CODE), CODE);
  assert.equal(cpu.r[1].value, 1026);
  assert.equal(cpu.step(CODE), CODE);
  assert.equal(cpu.r[1].value, 2);
  assert.equal(cpu.step(CODE), CODE + 2);
  assert.equal(cpu.r[1].value, 0);
  assert.equal(cpu.instructions, 2050);
  assert.equal(cpu.stringRestart, null);
});

test('source or destination faults preserve completed indices/count and restore pre-REP flags', () => {
  for (const sourceFault of [false, true])
    for (const repeat of [0xf3, 0xf2]) {
      const { cpu, data } = machine([repeat, 0xa6]);
      const source = sourceFault ? 0x7ffe : 0x2000,
        destination = sourceFault ? 0x4000 : 0x7ffe;
      data.fill(1, source, source + 2);
      data.fill(repeat === 0xf3 ? 1 : 2, destination, destination + 2);
      cpu.r[6].value = source;
      cpu.r[7].value = destination;
      cpu.r[1].value = 3;
      cpu.f = { cf: 0, zf: 1, sf: 1, of: 1, pf: 0 };
      cpu.af = 1;
      assert.throws(() => cpu.step(CODE), /read violation/);
      assert.deepEqual(
        [cpu.r[6].value, cpu.r[7].value, cpu.r[1].value],
        [source + 2, destination + 2, 1],
      );
      assert.deepEqual(cpu.f, { cf: 0, zf: 1, sf: 1, of: 1, pf: 0 });
      assert.equal(cpu.af, 1);
      assert.equal(cpu.stringRestart, null);
    }
});

test('comparison fault restart flags survive scheduler chunks and another guest context', () => {
  const { cpu, data } = machine([0xf3, 0xa6]);
  cpu.r[6].value = 0x7c00;
  cpu.r[7].value = 0x4000;
  cpu.r[1].value = 1025;
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
  cpu.af = 1;
  assert.equal(cpu.step(CODE), CODE);
  assert.equal(cpu.f.zf, 1);
  const suspended = cpu.captureContext();
  cpu.restoreContext({
    ...suspended,
    registers: [0, 1, 0, 0, 0, 0, 0x2000, 0x4000],
    stringRestart: null,
  });
  data[0x2000] = 1;
  assert.equal(cpu.step(CODE), CODE + 2);
  cpu.restoreContext(suspended);
  assert.throws(() => cpu.step(CODE), /read violation/);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
  assert.equal(cpu.af, 1);
  assert.deepEqual([cpu.r[6].value, cpu.r[7].value, cpu.r[1].value], [0x8000, 0x4400, 1]);
});

test('FS source uses the current TEB base while ES destination stays flat; invalid encodings fail', () => {
  const { cpu, view } = machine([0x64, 0xf3, 0x66, 0xa7], { fsBase: 0x2000 });
  view.setUint16(0x2020, 0x1234, true);
  view.setUint16(0x4020, 0x1234, true);
  cpu.r[6].value = 0x20;
  cpu.r[7].value = 0x4020;
  cpu.r[1].value = 1;
  assert.equal(cpu.step(CODE), CODE + 4);
  assert.equal(cpu.f.zf, 1);
  cpu.fsBase = 0x3000;
  cpu.r[6].value = 0x20;
  cpu.r[7].value = 0x4020;
  cpu.r[1].value = 1;
  view.setUint16(0x3020, 0x1235, true);
  assert.equal(cpu.step(CODE), CODE + 4);
  assert.equal(cpu.f.zf, 0);
  assert.equal(cpu.f.cf, 0);
  for (const [code, error] of [
    [[0x67, 0xf3, 0xa6], /16-bit/],
    [[0x65, 0xa6], /segment/],
    [[0xf0, 0xa6], /Invalid|LOCK/],
  ])
    assert.throws(() => machine(code).cpu.step(CODE), error);
  assert.throws(() => machine([0x64, 0xa6]).cpu.step(CODE), /TEB/);
});
