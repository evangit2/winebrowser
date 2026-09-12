import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;
const DATA = 0x2000;

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
    check:
      check ??
      ((address, size) => {
        if (address + size > memory.buffer.byteLength)
          throw Error(`range violation ${address}+${size}`);
        return address;
      }),
    executableRanges: [[CODE, CODE + code.length]],
  });
  return { cpu, memory, view };
}

const lanes = (cpu, xmm = 0) => Array.from(cpu.simd.registers[xmm]);

test('MOVD transfers GPR values both ways and clears the high XMM lanes on load', () => {
  const { cpu } = machine([
    0x66,
    0x0f,
    0x6e,
    0xc7, // movd xmm0, edi
    0x66,
    0x0f,
    0x7e,
    0xc0, // movd eax, xmm0
  ]);
  cpu.r[7].value = 0xdeadbeef;
  cpu.simd.registers[0].set([1, 2, 3, 4]);

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu), [0xdeadbeef, 0, 0, 0]);
  assert.equal(cpu.r[0].value >>> 0, 0xdeadbeef);
});

test('MOVD and MOVQ memory transfers use only their scalar widths and zero XMM upper lanes', () => {
  const { cpu, view } = machine([
    0x66,
    0x0f,
    0x6e,
    0x00, // movd xmm0, dword ptr [eax]
    0xf3,
    0x0f,
    0x7e,
    0x09, // movq xmm1, qword ptr [ecx]
    0x66,
    0x0f,
    0xd6,
    0x12, // movq qword ptr [edx], xmm2
    0x66,
    0x0f,
    0x7e,
    0x5a,
    0x08, // movd dword ptr [edx+8], xmm3
  ]);
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 8;
  cpu.r[2].value = DATA + 16;
  view.setUint32(DATA, 0x11223344, true);
  view.setUint32(DATA + 8, 0x55667788, true);
  view.setUint32(DATA + 12, 0x99aabbcc, true);
  cpu.simd.registers[2].set([0x01234567, 0x89abcdef, 0xdeadbeef, 0xfedcba98]);
  cpu.simd.registers[3].set([0xfacecafe, 0, 0, 0]);

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu, 0), [0x11223344, 0, 0, 0]);
  assert.deepEqual(lanes(cpu, 1), [0x55667788, 0x99aabbcc, 0, 0]);
  assert.equal(view.getUint32(DATA + 16, true), 0x01234567);
  assert.equal(view.getUint32(DATA + 20, true), 0x89abcdef);
  assert.equal(view.getUint32(DATA + 24, true), 0xfacecafe);
});

test('MOVDDUP duplicates a memory or XMM low qword into both vector halves', () => {
  const { cpu, view } = machine([
    0xf2,
    0x0f,
    0x12,
    0x00, // movddup xmm0, qword ptr [eax]
    0xf2,
    0x0f,
    0x12,
    0xd1, // movddup xmm2, xmm1
  ]);
  cpu.r[0].value = DATA + 1;
  view.setUint32(DATA + 1, 0x11223344, true);
  view.setUint32(DATA + 5, 0x55667788, true);
  cpu.simd.registers[1].set([0xaabbccdd, 0x12345678, 0, 0]);
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 };

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu), [0x11223344, 0x55667788, 0x11223344, 0x55667788]);
  assert.deepEqual(lanes(cpu, 2), [0xaabbccdd, 0x12345678, 0xaabbccdd, 0x12345678]);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 });
});

test('MOVDQA, MOVDQU, MOVUPS, and MOVAPS move 128-bit XMM values with required alignment', () => {
  const { cpu, view } = machine([
    0x0f,
    0x10,
    0x00, // movups xmm0, xmmword ptr [eax]
    0xf3,
    0x0f,
    0x6f,
    0x49,
    0x10, // movdqu xmm1, xmmword ptr [ecx+10h]
    0x66,
    0x0f,
    0x7f,
    0x12, // movdqa xmmword ptr [edx], xmm2
    0x0f,
    0x29,
    0x1a, // movaps xmmword ptr [edx], xmm3
  ]);
  cpu.r[0].value = DATA + 1; // MOVUPS permits an unaligned address.
  cpu.r[1].value = DATA + 1;
  cpu.r[2].value = DATA + 0x40;
  view.setUint32(DATA + 1, 1, true);
  view.setUint32(DATA + 5, 2, true);
  view.setUint32(DATA + 9, 3, true);
  view.setUint32(DATA + 13, 4, true);
  view.setUint32(DATA + 17, 5, true);
  view.setUint32(DATA + 21, 6, true);
  view.setUint32(DATA + 25, 7, true);
  view.setUint32(DATA + 29, 8, true);
  cpu.simd.registers[2].set([9, 10, 11, 12]);
  cpu.simd.registers[3].set([13, 14, 15, 16]);

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu, 0), [1, 2, 3, 4]);
  assert.deepEqual(lanes(cpu, 1), [5, 6, 7, 8]);
  assert.deepEqual(
    [0, 1, 2, 3].map((n) => view.getUint32(DATA + 0x40 + n * 4, true)),
    [13, 14, 15, 16],
  );
});

test('SSE integer lane operations handle aliasing, shuffles, and leave EFLAGS unchanged', () => {
  const { cpu } = machine([
    0x66,
    0x0f,
    0x6f,
    0xc0, // movdqa xmm0, xmm0
    0x66,
    0x0f,
    0x62,
    0xc1, // punpckldq xmm0, xmm1
    0x66,
    0x0f,
    0x6c,
    0xc2, // punpcklqdq xmm0, xmm2
    0x66,
    0x0f,
    0x70,
    0xc0,
    0x1b, // pshufd xmm0, xmm0, 1bh
    0x66,
    0x0f,
    0xef,
    0xc3, // pxor xmm0, xmm3
  ]);
  cpu.simd.registers[0].set([1, 2, 3, 4]);
  cpu.simd.registers[1].set([10, 20, 30, 40]);
  cpu.simd.registers[2].set([30, 40, 50, 60]);
  cpu.simd.registers[3].set([1, 2, 4, 8]);
  cpu.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu), [41, 28, 14, 9]);
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });
});

test('aligned moves trap on misalignment and stores preflight the full range before writing', () => {
  const misaligned = machine([0x66, 0x0f, 0x7f, 0x08]); // movdqa [eax], xmm1
  misaligned.cpu.r[0].value = DATA + 4;
  assert.throws(() => misaligned.cpu.step(CODE), /16-byte alignment/);

  const restricted = machine([0x0f, 0x11, 0x08], {
    check: (address, size, write) => {
      if (write && (address < DATA || address + size > DATA + 8))
        throw Error('whole store range denied');
      if (address + size > 65536) throw Error('outside memory');
    },
  }); // movups [eax], xmm1
  restricted.cpu.r[0].value = DATA;
  restricted.cpu.simd.registers[1].set([1, 2, 3, 4]);
  new Uint8Array(restricted.memory.buffer).fill(0xaa, DATA, DATA + 16);

  assert.throws(() => restricted.cpu.step(CODE), /whole store range denied/);
  assert.deepEqual(
    [...new Uint8Array(restricted.memory.buffer).slice(DATA, DATA + 16)],
    Array(16).fill(0xaa),
  );
});

test('legacy SSE integer operations require aligned memory operands', () => {
  const punpck = machine([0x66, 0x0f, 0x62, 0x08]); // punpckldq xmm1, xmmword ptr [eax]
  punpck.cpu.r[0].value = DATA + 4;
  assert.throws(() => punpck.cpu.step(CODE), /16-byte alignment/);

  const shuffle = machine([0x66, 0x0f, 0x70, 0x00, 0x00]); // pshufd xmm0, [eax], 0
  shuffle.cpu.r[0].value = DATA + 8;
  assert.throws(() => shuffle.cpu.step(CODE), /16-byte alignment/);
});

test('PUNPCKLDQ with an aliased source reads both old values before writing', () => {
  const { cpu } = machine([0x66, 0x0f, 0x62, 0xc0]); // punpckldq xmm0, xmm0
  cpu.simd.registers[0].set([1, 2, 3, 4]);

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu), [1, 1, 2, 2]);
});

test('XMM snapshots are deep copies and restore all vector state', () => {
  const { cpu } = machine([0x90]);
  cpu.simd.registers[7].set([1, 2, 3, 4]);
  const snapshot = cpu.simd.snapshot();
  cpu.simd.registers[7].fill(0);
  cpu.simd.restore(snapshot);

  assert.deepEqual(lanes(cpu, 7), [1, 2, 3, 4]);
  assert.throws(() => cpu.simd.restore([]), /Invalid SIMD snapshot/);
});

test('unsupported floating-point/SSE and MMX instructions still fail explicitly', () => {
  const float = machine([0x0f, 0x58, 0xc1]); // addps xmm0, xmm1
  assert.throws(() => float.cpu.step(CODE), /Unsupported instruction/);
  const mmx = machine([0x0f, 0x6f, 0xc1]); // movq mm0, mm1
  assert.throws(() => mmx.cpu.step(CODE), /Unsupported instruction/);
});
