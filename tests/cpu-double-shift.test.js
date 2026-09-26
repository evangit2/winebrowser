import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000,
  DATA = 0x2000;
function machine(code, denied) {
  const memory = new WebAssembly.Memory({ initial: 1 }),
    view = new DataView(memory.buffer);
  new Uint8Array(memory.buffer).set(code, CODE);
  const check = (a, n, write) => {
    if (a + n > memory.buffer.byteLength || denied?.(a, n, write))
      throw Error('double shift memory fault');
    return a;
  };
  const read = (a, n) => {
    check(a, n, false);
    return n === 2 ? view.getUint16(a, true) : view.getUint32(a, true);
  };
  const write = (a, v, n) => {
    check(a, n, true);
    if (n === 2) view.setUint16(a, v, true);
    else view.setUint32(a, v, true);
  };
  return {
    view,
    cpu: new CPU(iced, {
      memory,
      read,
      write,
      check,
      read32: (a) => read(a, 4),
      write32: (a, v) => write(a, v, 4),
      executableRanges: [[CODE, CODE + code.length]],
    }),
  };
}
const flags = { cf: 1, zf: 1, sf: 1, of: 1, pf: 0 };
// A bit string oracle deliberately independent from the emitter's JS shifts.
function expected(destination, source, count, width, left) {
  const bits = (v) => (v >>> 0).toString(2).padStart(32, '0').slice(-width);
  const d = bits(destination),
    s = bits(source),
    n = count & 31;
  if (!n) return { result: parseInt(d, 2), flags };
  const pair = left ? d + s : s + d;
  const resultBits = left ? pair.slice(n, n + width) : pair.slice(width - n, width * 2 - n);
  const result = parseInt(resultBits, 2);
  return {
    result,
    flags: {
      cf: Number(d[left ? n - 1 : width - n]),
      zf: Number(result === 0),
      sf: Number(resultBits[0]),
      pf: Number([...resultBits.slice(-8)].filter((x) => x === '1').length % 2 === 0),
      of: n === 1 ? Number(d[0] !== resultBits[0]) : flags.of,
    },
  };
}

test('SHLD/SHRD use the source register and masked imm8/CL counts in 16/32-bit forms', () => {
  for (const width of [16, 32])
    for (const left of [false, true])
      for (const immediate of [false, true])
        for (const count of [0, 1, 4, 8, 15, 16, 17, 31, 32, 33, 63, 255]) {
          if ((count & 31) > width) continue; // architecturally undefined
          for (const [destination, source] of [
            [0x81234567, 0xcafef00d],
            [0x00018000, 0x13570000],
            [0, 0],
          ]) {
            const opcode = (left ? 0xa4 : 0xac) + Number(!immediate);
            const { cpu } = machine([
              ...(width === 16 ? [0x66] : []),
              0x0f,
              opcode,
              0xd0,
              ...(immediate ? [count] : []),
            ]);
            cpu.r[0].value = destination;
            cpu.r[2].value = source;
            cpu.r[1].value = count;
            cpu.f = { ...flags };
            cpu.af = 1;
            cpu.df = 1;
            cpu.step(CODE);
            const e = expected(destination, source, count, width, left);
            assert.equal(
              cpu.r[0].value >>> 0,
              width === 16 ? ((destination & 0xffff0000) | e.result) >>> 0 : e.result,
            );
            assert.equal(cpu.r[2].value >>> 0, source >>> 0);
            assert.deepEqual(cpu.f, e.flags);
            assert.equal(cpu.af, 1);
            assert.equal(cpu.df, 1);
          }
        }
});

test('SHLD/SHRD memory forms write exactly the destination width and preserve source', () => {
  for (const width of [16, 32])
    for (const left of [false, true])
      for (const immediate of [false, true]) {
        const count = width - 1,
          opcode = (left ? 0xa4 : 0xac) + Number(!immediate);
        const { cpu, view } = machine([
          ...(width === 16 ? [0x66] : []),
          0x0f,
          opcode,
          0x10,
          ...(immediate ? [count] : []),
        ]);
        const address = DATA + 1;
        cpu.r[0].value = address;
        cpu.r[2].value = 0x81234567;
        cpu.r[1].value = count;
        view.setUint32(address, 0xfedcba98, true);
        view.setUint8(address - 1, 0x5a);
        view.setUint8(address + width / 8, 0x5b);
        const destination =
          width === 16 ? view.getUint16(address, true) : view.getUint32(address, true);
        const e = expected(destination, 0x81234567, count, width, left);
        cpu.f = { ...flags };
        cpu.step(CODE);
        assert.equal(
          width === 16 ? view.getUint16(address, true) : view.getUint32(address, true),
          e.result,
        );
        assert.deepEqual(cpu.f, e.flags);
        assert.equal(cpu.r[2].value >>> 0, 0x81234567);
        assert.equal(view.getUint8(address - 1), 0x5a);
        assert.equal(view.getUint8(address + width / 8), 0x5b);
      }
});

test('double shifts read aliased count/source/destination registers before writing', () => {
  for (const left of [false, true]) {
    const { cpu } = machine([0x0f, left ? 0xa5 : 0xad, 0xc9]); // ecx,ecx,cl
    cpu.r[1].value = 0x87654321;
    cpu.f = { ...flags };
    cpu.step(CODE);
    const e = expected(0x87654321, 0x87654321, 0x21, 32, left);
    assert.equal(cpu.r[1].value >>> 0, e.result);
    assert.deepEqual(cpu.f, e.flags);
  }
});

test('double-shift memory read/write faults preserve flags, registers and memory', () => {
  for (const readFault of [false, true])
    for (const count of [0, 1, 32])
      for (const left of [false, true]) {
        const { cpu, view } = machine(
          [0x0f, left ? 0xa4 : 0xac, 0x10, count],
          (a, n, write) => a === DATA && (readFault || write),
        );
        view.setUint32(DATA, 0x87654321, true);
        cpu.r[0].value = DATA;
        cpu.r[2].value = 0x12345678;
        cpu.f = { ...flags };
        cpu.af = 1;
        const registers = cpu.r.map((r) => r.value);
        assert.throws(() => cpu.step(CODE), /memory fault/);
        assert.deepEqual(cpu.f, flags);
        assert.equal(cpu.af, 1);
        assert.deepEqual(
          cpu.r.map((r) => r.value),
          registers,
        );
        assert.equal(view.getUint32(DATA, true), 0x87654321);
      }
});

test('LOCK double shifts are rejected', () => {
  for (const opcode of [0xa4, 0xac]) {
    const { cpu } = machine([0xf0, 0x0f, opcode, 0x10, 1]);
    assert.throws(() => cpu.step(CODE), /Unsupported|Invalid|LOCK/);
  }
});
