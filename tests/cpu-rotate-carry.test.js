import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;

function machine(code, check) {
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
    check,
  });
  return { cpu, view };
}

test('RCL and RCR rotate through carry and define OF for a one-bit count', () => {
  const rcr = machine([0xd1, 0xdb]).cpu; // rcr ebx,1
  rcr.r[3].value = 0;
  rcr.f = { cf: 1, zf: 1, sf: 1, of: 0, pf: 0 };
  rcr.af = 1;
  rcr.step(CODE);
  assert.equal(rcr.r[3].value >>> 0, 0x80000000);
  assert.deepEqual(rcr.f, { cf: 0, zf: 1, sf: 1, of: 1, pf: 0 });
  assert.equal(rcr.af, 1);

  const rcl = machine([0xd1, 0xd3]).cpu; // rcl ebx,1
  rcl.r[3].value = 0x80000000;
  rcl.f = { cf: 1, zf: 0, sf: 0, of: 0, pf: 1 };
  rcl.step(CODE);
  assert.equal(rcl.r[3].value >>> 0, 1);
  assert.deepEqual(rcl.f, { cf: 1, zf: 0, sf: 0, of: 1, pf: 1 });
});

test('RCL/RCR mask counts, use width-plus-carry rotation, and preserve undefined flags', () => {
  const zero = machine([0xc0, 0xd0, 0x09]).cpu; // rcl al,9 -> effective count zero
  zero.r[0].value = 0x12345680;
  zero.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };
  zero.step(CODE);
  assert.equal(zero.r[0].value >>> 0, 0x12345680);
  assert.deepEqual(zero.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });

  const masked = machine([0xc1, 0xd3, 0x21]).cpu; // rcl ebx,33 -> count one
  masked.r[3].value = 0x40000000;
  masked.f.cf = 0;
  masked.step(CODE);
  assert.equal(masked.r[3].value >>> 0, 0x80000000);
  assert.equal(masked.f.cf, 0);
  assert.equal(masked.f.of, 1);

  const multiple = machine([0xc0, 0xd8, 0x02]).cpu; // rcr al,2
  multiple.r[0].value = 1;
  multiple.f = { cf: 0, zf: 1, sf: 1, of: 1, pf: 0 };
  multiple.step(CODE);
  assert.equal(multiple.r[0].value & 0xff, 0x80);
  assert.equal(multiple.f.cf, 0);
  assert.equal(multiple.f.of, 1, 'OF is undefined for count > 1 and retained internally');
  assert.deepEqual(
    { zf: multiple.f.zf, sf: multiple.f.sf, pf: multiple.f.pf },
    { zf: 1, sf: 1, pf: 0 },
  );
  const wrapped = machine([0xc0, 0xd0, 10]).cpu; // rcl al,10 rotates once, OF remains undefined
  wrapped.r[0].value = 0x40;
  wrapped.f.cf = wrapped.f.of = 0;
  wrapped.step(CODE);
  assert.equal(wrapped.r[0].value, 0x80);
  assert.equal(
    wrapped.f.of,
    0,
    'Only a masked count of one defines OF, not a count modulo width+1',
  );
});

test('RCR supports checked memory operands', () => {
  const { cpu, view } = machine([0xd1, 0x1d, 0x00, 0x20, 0x00, 0x00]); // rcr dword [2000h],1
  view.setUint32(0x2000, 2, true);
  cpu.f.cf = 1;
  cpu.step(CODE);
  assert.equal(view.getUint32(0x2000, true), 0x80000001);
  assert.equal(cpu.f.cf, 0);
});

test('ROL/ROR match independent bit-by-bit rotation for every CL count at each width', () => {
  for (const width of [8, 16, 32]) {
    for (const right of [false, true]) {
      const cpu = machine([
        ...(width === 16 ? [0x66] : []),
        width === 8 ? 0xd2 : 0xd3,
        right ? 0xcb : 0xc3,
      ]).cpu;
      const mask = (1n << BigInt(width)) - 1n;
      for (let count = 0; count < 256; count++) {
        for (const value of [0, 1, 0x80000000, 0xaaaa8181, 0xffffffff]) {
          let expected = BigInt(value) & mask,
            carry = 1;
          for (let n = 0; n < (count & 31); n++) {
            carry = Number(right ? expected & 1n : expected >> BigInt(width - 1));
            expected = right
              ? (expected >> 1n) | (BigInt(carry) << BigInt(width - 1))
              : ((expected << 1n) | BigInt(carry)) & mask;
          }
          cpu.r[3].value = value;
          cpu.r[1].value = count;
          cpu.f = { cf: 1, of: 1, sf: 1, zf: 1, pf: 0 };
          cpu.af = 1;
          cpu.step(CODE);
          assert.equal(BigInt(cpu.r[3].value >>> 0), (BigInt(value) & ~mask) | expected);
          assert.equal(cpu.f.cf, carry);
          const msb = Number(expected >> BigInt(width - 1));
          assert.equal(
            cpu.f.of,
            (count & 31) === 1
              ? msb ^ (right ? Number((expected >> BigInt(width - 2)) & 1n) : carry)
              : 1,
          );
          assert.deepEqual([cpu.f.zf, cpu.f.sf, cpu.f.pf, cpu.af], [1, 1, 0, 1]);
        }
      }
      cpu.dispose();
    }
  }
});

test('ROL/ROR support immediate memory and aliased byte/CL operands; faults preserve flags', () => {
  const { cpu, view } = machine([0x66, 0xc1, 0x00, 1]); // rol word [eax],1
  cpu.r[0].value = 0x2000;
  view.setUint32(0x2000, 0xabcd8001, true);
  cpu.step(CODE);
  assert.equal(view.getUint32(0x2000, true), 0xabcd0003);
  assert.equal(cpu.f.cf, 1);
  const alias = machine([0xd2, 0xc9]).cpu; // ror cl,cl
  alias.r[1].value = 0x12345681;
  alias.step(CODE);
  assert.equal(alias.r[1].value >>> 0, 0x123456c0);
  const fault = machine([0xd1, 0x08], (_address, _size, write) => {
    if (write) throw Error('read-only rotate');
  });
  fault.cpu.r[0].value = 0x2000;
  fault.view.setUint32(0x2000, 1, true);
  fault.cpu.f = { cf: 0, of: 0, sf: 0, zf: 1, pf: 1 };
  assert.throws(() => fault.cpu.step(CODE), /read-only rotate/);
  assert.equal(fault.view.getUint32(0x2000, true), 1);
  assert.deepEqual(fault.cpu.f, { cf: 0, of: 0, sf: 0, zf: 1, pf: 1 });
});

test('a memory write fault leaves rotate flags and storage unchanged', () => {
  const { cpu, view } = machine([0xd1, 0x1d, 0x00, 0x20, 0x00, 0x00], (address, size, write) => {
    if (write && address === 0x2000 && size === 4) throw Error('test write protection');
    return address;
  });
  view.setUint32(0x2000, 2, true);
  cpu.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };
  assert.throws(() => cpu.step(CODE), /test write protection/);
  assert.equal(view.getUint32(0x2000, true), 2);
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });
});
