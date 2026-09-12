import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;
const STACK = 0xf000;

function machine(code, { fsBase = 0 } = {}) {
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
    fsBase,
  });
  return { cpu, memory, bytes, view };
}

const reg = (cpu, index) => cpu.r[index].value >>> 0;

test('byte, high-byte, and word register writes preserve the unaffected bits', () => {
  const { cpu } = machine([
    0xb8,
    0x78,
    0x56,
    0x34,
    0x12, // mov eax, 12345678h
    0xb0,
    0xaa, // mov al, aah
    0xb4,
    0xbb, // mov ah, bbh
    0x66,
    0xb8,
    0xdd,
    0xcc, // mov ax, ccddh
    0xb3,
    0xee, // mov bl, eeh
  ]);
  cpu.step(CODE);
  assert.equal(reg(cpu, 0), 0x1234ccdd);
  assert.equal(reg(cpu, 3), 0xee);
});

test('MOVZX and MOVSX extend byte and word values from memory and registers', () => {
  const { cpu, view } = machine([
    0x0f,
    0xb6,
    0x05,
    0x00,
    0x20,
    0x00,
    0x00, // movzx eax, byte ptr [2000h]
    0x0f,
    0xbe,
    0x1d,
    0x01,
    0x20,
    0x00,
    0x00, // movsx ebx, byte ptr [2001h]
    0x0f,
    0xb7,
    0x0d,
    0x02,
    0x20,
    0x00,
    0x00, // movzx ecx, word ptr [2002h]
    0x0f,
    0xbf,
    0x15,
    0x02,
    0x20,
    0x00,
    0x00, // movsx edx, word ptr [2002h]
    0xb8,
    0xff,
    0x80,
    0x00,
    0x00, // mov eax, 80ffh
    0x0f,
    0xb6,
    0xc4, // movzx eax, ah
    0xb8,
    0x80,
    0x00,
    0x00,
    0x00, // mov eax, 80h
    0x0f,
    0xbe,
    0xd0, // movsx edx, al
  ]);
  view.setUint8(0x2000, 0x80);
  view.setUint8(0x2001, 0x80);
  view.setUint8(0x2002, 0x80);
  view.setUint8(0x2003, 0xff);
  cpu.step(CODE);
  assert.equal(reg(cpu, 0), 0x80);
  assert.equal(reg(cpu, 1), 0xff80);
  assert.equal(reg(cpu, 2), 0xffffff80);
  assert.equal(reg(cpu, 3), 0xffffff80);
});

test('byte and word arithmetic reports carry, overflow, sign, and zero at operand width', () => {
  const byteOverflow = machine([0xb0, 0x7f, 0x04, 0x01, 0x70, 0x00]).cpu;
  byteOverflow.step(CODE);
  assert.equal(reg(byteOverflow, 0), 0x80);
  assert.deepEqual(byteOverflow.f, { cf: 0, zf: 0, sf: 1, of: 1, pf: 0 });

  const wordOverflow = machine([
    0x66,
    0xb8,
    0xff,
    0x7f, // mov ax, 7fffh
    0x66,
    0x83,
    0xc0,
    0x01, // add ax, 1
    0x70,
    0x00,
  ]).cpu;
  wordOverflow.step(CODE);
  assert.equal(reg(wordOverflow, 0), 0x8000);
  assert.deepEqual(wordOverflow.f, { cf: 0, zf: 0, sf: 1, of: 1, pf: 1 });

  const zeroCarry = machine([0xb0, 0xff, 0x04, 0x01, 0x74, 0x00]).cpu;
  zeroCarry.step(CODE);
  assert.equal(reg(zeroCarry, 0), 0);
  assert.deepEqual(zeroCarry.f, { cf: 1, zf: 1, sf: 0, of: 0, pf: 1 });

  const wordBorrow = machine([
    0x66,
    0xb8,
    0x00,
    0x00, // mov ax, 0
    0x66,
    0x83,
    0xe8,
    0x01, // sub ax, 1
    0x72,
    0x00,
  ]).cpu;
  wordBorrow.step(CODE);
  assert.equal(reg(wordBorrow, 0), 0xffff);
  assert.deepEqual(wordBorrow.f, { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 });
});

test('ADC and SBB incorporate incoming carry at 32-bit boundaries', () => {
  const adc = machine([0x83, 0xd0, 0x00, 0x70, 0x00]).cpu; // adc eax, 0
  adc.r[0].value = -1;
  adc.f.cf = 1;
  adc.step(CODE);
  assert.equal(reg(adc, 0), 0);
  assert.deepEqual(adc.f, { cf: 1, zf: 1, sf: 0, of: 0, pf: 1 });

  const sbb = machine([0x83, 0xd8, 0x00, 0x70, 0x00]).cpu; // sbb eax, 0
  sbb.r[0].value = 0;
  sbb.f.cf = 1;
  sbb.step(CODE);
  assert.equal(reg(sbb, 0), 0xffffffff);
  assert.deepEqual(sbb.f, { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 });
});

test('shift count zero preserves flags and 16-bit SAR uses the operand sign and carry', () => {
  const noShift = machine([0xd2, 0xe0]).cpu; // shl al, cl
  noShift.r[0].value = 0x12345681;
  noShift.r[1].value = 0;
  noShift.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 1 };
  noShift.step(CODE);
  assert.equal(reg(noShift, 0), 0x12345681);
  assert.deepEqual(noShift.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 1 });

  const sar = machine([0x66, 0xd1, 0xf8]).cpu; // sar ax, 1
  sar.r[0].value = 0x12348001;
  sar.step(CODE);
  assert.equal(reg(sar, 0), 0x1234c000);
  assert.equal(sar.f.sf, 1);
  assert.equal(sar.f.cf, 1);
  assert.equal(sar.f.of, 0);
});

test('16-bit IMUL truncates the result while setting signed overflow', () => {
  const { cpu } = machine([0x66, 0x0f, 0xaf, 0xc3]); // imul ax, bx
  cpu.r[0].value = 0x11117fff;
  cpu.r[3].value = 2;
  cpu.step(CODE);
  assert.equal(reg(cpu, 0), 0x1111fffe);
  assert.equal(cpu.f.cf, 1);
  assert.equal(cpu.f.of, 1);
});

test('FS loads use the segment base while LEA ignores the FS override', () => {
  const { cpu, view } = machine(
    [
      0x64,
      0x8b,
      0x1d,
      0x20,
      0x00,
      0x00,
      0x00, // mov ebx, fs:[20h]
      0x64,
      0x8d,
      0x05,
      0x20,
      0x00,
      0x00,
      0x00, // lea eax, fs:[20h]
    ],
    { fsBase: 0x2000 },
  );
  view.setUint32(0x2020, 0xdecafbad, true);
  cpu.step(CODE);
  assert.equal(reg(cpu, 3), 0xdecafbad);
  assert.equal(reg(cpu, 0), 0x20);
});

test('LOOP decrements ECX and preserves arithmetic flags on taken and fallthrough paths', () => {
  const { cpu } = machine([0xe2, 0x02, 0x90, 0x90, 0x90]);
  const expectedFlags = { cf: 1, zf: 0, sf: 1, of: 1, pf: 1 };
  cpu.f = { ...expectedFlags };
  cpu.r[1].value = 2;
  assert.equal(cpu.step(CODE), CODE + 4);
  assert.equal(reg(cpu, 1), 1);
  assert.deepEqual(cpu.f, expectedFlags);
  cpu.r[1].value = 1;
  assert.equal(cpu.step(CODE), CODE + 2);
  assert.equal(reg(cpu, 1), 0);
  assert.deepEqual(cpu.f, expectedFlags);
});

test('memory-destination arithmetic evaluates base, scaled index, and displacement', () => {
  const { cpu, view } = machine([
    0x01,
    0x44,
    0x73,
    0x08, // add dword ptr [ebx + esi*2 + 8], eax
    0x70,
    0x00,
  ]);
  cpu.r[0].value = 1;
  cpu.r[3].value = 0x3000;
  cpu.r[6].value = 4;
  view.setUint32(0x3010, 0xffffffff, true);
  cpu.step(CODE);
  assert.equal(view.getUint32(0x3010, true), 0);
  assert.equal(cpu.f.cf, 1);
  assert.equal(cpu.f.zf, 1);
});
