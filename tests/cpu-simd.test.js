import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { readFile } from 'node:fs/promises';
import { probeScalarSse } from '../scripts/lib/scalar-sse-probe.js';

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

test('native scalar SSE fixture executes register/memory moves and signed conversions', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('./fixtures/sse/scalar.exe', import.meta.url)),
  );
  const result = await probeScalarSse(iced, { files: new Map([['scalar.exe', bytes]]) });
  assert.equal(result.status, 'passed', result.failure);
});

test('legacy scalar SSE register moves preserve upper lanes for both opcode directions', () => {
  for (const prefix of [0xf2, 0xf3])
    for (const opcode of [0x10, 0x11]) {
      const { cpu } = machine([prefix, 0x0f, opcode, opcode === 0x10 ? 0xc1 : 0xc8]); // xmm0 <- xmm1
      cpu.simd.registers[0].set([1, 2, 3, 4]);
      cpu.simd.registers[1].set([0x12345678, 0x7ff80000, 7, 8]);
      cpu.f = { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 };
      cpu.step(CODE);
      assert.deepEqual(lanes(cpu), [0x12345678, prefix === 0xf2 ? 0x7ff80000 : 2, 3, 4]);
      assert.deepEqual(lanes(cpu, 1), [0x12345678, 0x7ff80000, 7, 8]);
      assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 });
    }
});

test('scalar SSE memory loads zero upper lanes; unaligned stores write only the scalar width', () => {
  for (const prefix of [0xf2, 0xf3]) {
    const { cpu, view, memory } = machine([prefix, 0x0f, 0x10, 0x00, prefix, 0x0f, 0x11, 0x01]);
    const bytes = new Uint8Array(memory.buffer),
      width = prefix === 0xf2 ? 8 : 4;
    cpu.r[0].value = DATA + 1;
    cpu.r[1].value = DATA + 17;
    view.setUint32(DATA + 1, 0xabcdef01, true);
    view.setUint32(DATA + 5, 0xfff00000, true);
    bytes.fill(0x5a, DATA + 16, DATA + 32);
    cpu.simd.registers[0].set([1, 2, 3, 4]);
    cpu.step(CODE);
    assert.deepEqual(lanes(cpu), [0xabcdef01, prefix === 0xf2 ? 0xfff00000 : 0, 0, 0]);
    assert.deepEqual(
      bytes.slice(DATA + 17, DATA + 17 + width),
      bytes.slice(DATA + 1, DATA + 1 + width),
    );
    assert.equal(bytes[DATA + 16], 0x5a);
    assert.ok(bytes.slice(DATA + 17 + width, DATA + 32).every((byte) => byte === 0x5a));
  }
});

test('scalar SSE move memory faults preserve the complete destination', () => {
  for (const prefix of [0xf2, 0xf3])
    for (const opcode of [0x10, 0x11]) {
      const width = prefix === 0xf2 ? 8 : 4;
      const { cpu, memory } = machine([prefix, 0x0f, opcode, 0x00], {
        check: (address, size) => {
          assert.equal(address, DATA);
          assert.equal(size, width);
          throw Error('range violation');
        },
      });
      cpu.r[0].value = DATA;
      cpu.simd.registers[0].set([1, 2, 3, 4]);
      const bytes = new Uint8Array(memory.buffer);
      bytes.fill(0x5a, DATA, DATA + 16);
      assert.throws(() => cpu.step(CODE), /range violation/);
      assert.deepEqual(lanes(cpu), [1, 2, 3, 4]);
      assert.ok(bytes.slice(DATA, DATA + 16).every((byte) => byte === 0x5a));
    }
});

test('scalar MOVSD and REP MOVSD string copy retain their distinct behavior in one translated block', () => {
  const { cpu, view } = machine([0xf2, 0x0f, 0x10, 0x00, 0xf3, 0xa5]);
  cpu.r[0].value = DATA;
  cpu.r[6].value = DATA;
  cpu.r[7].value = DATA + 16;
  cpu.r[1].value = 2;
  view.setUint32(DATA, 0x12345678, true);
  view.setUint32(DATA + 4, 0x87654321, true);
  cpu.step(CODE);
  assert.deepEqual(lanes(cpu), [0x12345678, 0x87654321, 0, 0]);
  assert.equal(view.getUint32(DATA + 16, true), 0x12345678);
  assert.equal(view.getUint32(DATA + 20, true), 0x87654321);
  assert.equal(cpu.r[1].value, 0);
  assert.equal(cpu.r[6].value, DATA + 8);
  assert.equal(cpu.r[7].value, DATA + 24);
});

test('CVTSI2SD converts signed 32-bit register and memory inputs exactly while preserving high lanes', () => {
  for (const memoryOperand of [false, true])
    for (const integer of [0, 1, -1, 0x7fffffff, -0x80000000, 0x1000001]) {
      const { cpu, view } = machine([0xf2, 0x0f, 0x2a, memoryOperand ? 0x00 : 0xc0]);
      if (memoryOperand) {
        cpu.r[0].value = DATA + 1;
        view.setInt32(DATA + 1, integer, true);
      } else cpu.r[0].value = integer;
      cpu.simd.registers[0].set([1, 2, 0xdeadbeef, 0xcafefeed]);
      cpu.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };
      cpu.step(CODE);
      const actual = new DataView(cpu.simd.registers[0].buffer);
      assert.equal(actual.getFloat64(0, true), integer);
      assert.deepEqual(lanes(cpu).slice(2), [0xdeadbeef, 0xcafefeed]);
      assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });
    }
});

test('CVTSI2SD validates its full memory operand before changing XMM state', () => {
  const { cpu } = machine([0xf2, 0x0f, 0x2a, 0x00], {
    check: (address, size, write) => {
      assert.deepEqual([address, size, write], [DATA, 4, false]);
      throw Error('integer read denied');
    },
  });
  cpu.r[0].value = DATA;
  cpu.simd.registers[0].set([1, 2, 3, 4]);
  assert.throws(() => cpu.step(CODE), /integer read denied/);
  assert.deepEqual(lanes(cpu), [1, 2, 3, 4]);
});

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

test('PEXTRW selects all eight XMM words, masks the immediate, and zero-extends the GPR', () => {
  const words = [0x0001, 0x8002, 0x0003, 0xffff, 0x4444, 0x5555, 0x6666, 0x7777];
  const initialFlags = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
  for (const immediate of [...Array(8).keys(), 8, 0xff]) {
    const { cpu } = machine([0x66, 0x0f, 0xc5, 0xf0, immediate]); // pextrw esi, xmm0, imm8
    const vector = [0x80020001, 0xffff0003, 0x55554444, 0x77776666];
    cpu.simd.registers[0].set(vector);
    cpu.r[6].value = -1;
    cpu.f = { ...initialFlags };

    cpu.step(CODE);

    assert.equal(cpu.r[6].value >>> 0, words[immediate & 7], `lane ${immediate}`);
    assert.deepEqual(lanes(cpu), vector, `source XMM remains unchanged for lane ${immediate}`);
    assert.deepEqual(cpu.f, initialFlags, `flags remain unchanged for lane ${immediate}`);
  }
});

test('PEXTRW decodes a nonzero XMM source and a different destination register', () => {
  const { cpu } = machine([0x66, 0x0f, 0xc5, 0xff, 0x07]); // pextrw edi, xmm7, 7
  cpu.simd.registers[7].set([1, 2, 3, 0xdeadbeef]);
  cpu.r[7].value = 0x12340000;

  cpu.step(CODE);

  assert.equal(cpu.r[7].value >>> 0, 0xdead);
  assert.deepEqual(lanes(cpu, 7), [1, 2, 3, 0xdeadbeef]);
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

test('PADDW adds eight independent words with wraparound and preserves flags', () => {
  const { cpu } = machine([0x66, 0x0f, 0xfd, 0xc1]); // paddw xmm0, xmm1
  cpu.simd.registers[0].set([0xffff0001, 0x7fff8000, 0x0000ffff, 0x1234abcd]);
  cpu.simd.registers[1].set([0x0001ffff, 0x00018000, 0xffff0001, 0xedcc5433]);
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu), [0, 0x80000000, 0xffff0000, 0]);
  assert.deepEqual(lanes(cpu, 1), [0x0001ffff, 0x00018000, 0xffff0001, 0xedcc5433]);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
});

test('PADDW handles an aliased XMM source using each old word', () => {
  const { cpu } = machine([0x66, 0x0f, 0xfd, 0xc0]); // paddw xmm0, xmm0
  cpu.simd.registers[0].set([0xffff8000, 0x7fff0001, 0x80018001, 0xffffffff]);

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu), [0xfffe0000, 0xfffe0002, 0x00020002, 0xfffefffe]);
});

test('PADDW reads a full aligned memory operand before updating the destination', () => {
  const { cpu, view } = machine([0x66, 0x0f, 0xfd, 0x08]); // paddw xmm1, [eax]
  cpu.r[0].value = DATA;
  cpu.simd.registers[1].set([0x0001ffff, 0xffffffff, 0x1234abcd, 0]);
  for (const [lane, value] of [0xffff0001, 0x00010001, 0xedcc5433, 0x80008000].entries())
    view.setUint32(DATA + lane * 4, value, true);

  cpu.step(CODE);

  assert.deepEqual(lanes(cpu, 1), [0, 0, 0, 0x80008000]);
});

test('PADDW memory access enforces alignment and read permission before mutation', () => {
  const misaligned = machine([0x66, 0x0f, 0xfd, 0x08]); // paddw xmm1, [eax]
  misaligned.cpu.r[0].value = DATA + 4;
  misaligned.cpu.simd.registers[1].set([1, 2, 3, 4]);
  assert.throws(() => misaligned.cpu.step(CODE), /16-byte alignment/);
  assert.deepEqual(lanes(misaligned.cpu, 1), [1, 2, 3, 4]);

  const denied = machine([0x66, 0x0f, 0xfd, 0x08], {
    check: (address, size, write) => {
      if (address === DATA && size === 16 && !write) throw Error('whole PADDW read denied');
    },
  });
  denied.cpu.r[0].value = DATA;
  denied.cpu.simd.registers[1].set([1, 2, 3, 4]);
  assert.throws(() => denied.cpu.step(CODE), /whole PADDW read denied/);
  assert.deepEqual(lanes(denied.cpu, 1), [1, 2, 3, 4]);
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
  const mmxExtract = machine([0x0f, 0xc5, 0xf0, 0x01]); // pextrw esi, mm0, 1
  assert.throws(() => mmxExtract.cpu.step(CODE), /Unsupported instruction/);
  const memoryCapableExtract = machine([0x66, 0x0f, 0x3a, 0x15, 0xc0, 0x01]); // SSE4.1 pextrw eax, xmm0, 1
  assert.throws(() => memoryCapableExtract.cpu.step(CODE), /Unsupported instruction/);
  const mmxPaddw = machine([0x0f, 0xfd, 0xc1]); // paddw mm0, mm1
  assert.throws(() => mmxPaddw.cpu.step(CODE), /Unsupported instruction/);
  const vexPaddw = machine([0xc5, 0xf1, 0xfd, 0xc2]); // vpaddw xmm0, xmm1, xmm2
  assert.throws(() => vexPaddw.cpu.step(CODE), /Unsupported instruction/);
});

const setScalar = (cpu, xmm, double, bits) => {
  const view = new DataView(cpu.simd.registers[xmm].buffer);
  if (double) view.setBigUint64(0, BigInt(bits), true);
  else view.setUint32(0, Number(bits), true);
};
const scalarBits = (cpu, xmm, double) => {
  const view = new DataView(cpu.simd.registers[xmm].buffer);
  return double ? view.getBigUint64(0, true) : BigInt(view.getUint32(0, true));
};
const floatBits = (value, double) => {
  const view = new DataView(new ArrayBuffer(8));
  if (double) {
    view.setFloat64(0, value, true);
    return view.getBigUint64(0, true);
  }
  view.setFloat32(0, value, true);
  return BigInt(view.getUint32(0, true));
};

test('scalar SSE arithmetic decodes register and unaligned memory operands, preserving upper lanes/flags', async () => {
  for (const double of [false, true])
    for (const memory of [false, true])
      for (const [opcode, left, right, expected] of [
        [0x58, 6, 2, 8],
        [0x5c, 6, 2, 4],
        [0x59, 6, 2, 12],
        [0x5e, 6, 2, 3],
        [0x51, -1, 4, 2],
      ]) {
        const { cpu, view } = machine([double ? 0xf2 : 0xf3, 0x0f, opcode, memory ? 0x00 : 0xc1]);
        cpu.r[0].value = DATA + 1;
        cpu.simd.registers[0].set([0, 0xfeedface, 0xdeadbeef, 0xcafefeed]);
        setScalar(cpu, 0, double, floatBits(left, double));
        setScalar(cpu, 1, double, floatBits(right, double));
        if (double) view.setFloat64(DATA + 1, right, true);
        else view.setFloat32(DATA + 1, right, true);
        cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
        cpu.af = 1;
        await cpu.prepare(CODE);
        cpu.step(CODE);
        assert.equal(scalarBits(cpu, 0, double), floatBits(expected, double));
        assert.deepEqual(
          lanes(cpu).slice(double ? 2 : 1),
          double ? [0xdeadbeef, 0xcafefeed] : [0xfeedface, 0xdeadbeef, 0xcafefeed],
        );
        assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
        assert.equal(cpu.af, 1);
        assert.equal(cpu.simd.mxcsr, 0x1f80);
        cpu.dispose();
      }
});

test('MXCSR rounding controls arithmetic and conversions independently from x87', async () => {
  for (const double of [false, true])
    for (let rounding = 0; rounding < 4; rounding++) {
      const { cpu } = machine([double ? 0xf2 : 0xf3, 0x0f, 0x58, 0xc1]);
      cpu.simd.mxcsr = 0x1f80 | (rounding << 13);
      const one = floatBits(1, double);
      setScalar(cpu, 0, double, one);
      setScalar(cpu, 1, double, floatBits(2 ** (double ? -53 : -24), double));
      await cpu.prepare(CODE);
      cpu.step(CODE);
      assert.equal(scalarBits(cpu, 0, double), one + (rounding === 2 ? 1n : 0n));
      assert.equal(cpu.simd.mxcsr & 63, 32);
      assert.equal(cpu.x87.control, 0x37f);
      cpu.dispose();
    }
  for (const double of [false, true])
    for (const memory of [false, true])
      for (const opcode of [0x2c, 0x2d])
        for (let rounding = 0; rounding < 4; rounding++) {
          const { cpu, view } = machine([double ? 0xf2 : 0xf3, 0x0f, opcode, memory ? 0x08 : 0xc8]); // ecx <- xmm0/[eax]
          cpu.r[0].value = DATA;
          cpu.simd.mxcsr = 0x1f80 | (rounding << 13);
          setScalar(cpu, 0, double, floatBits(-1.5, double));
          if (double) view.setFloat64(DATA, -1.5, true);
          else view.setFloat32(DATA, -1.5, true);
          await cpu.prepare(CODE);
          cpu.step(CODE);
          assert.equal(cpu.r[1].value, opcode === 0x2c || rounding >= 2 ? -1 : -2);
          assert.equal(cpu.simd.mxcsr & 63, 32);
          cpu.dispose();
        }
  for (const memory of [false, true]) {
    const { cpu, view } = machine([0xf3, 0x0f, 0x2a, memory ? 0x00 : 0xc0]);
    cpu.r[0].value = memory ? DATA : 0x1000001;
    view.setUint32(DATA, 0x1000001, true);
    cpu.simd.mxcsr = 0x5f80;
    await cpu.prepare(CODE);
    cpu.step(CODE);
    assert.equal(scalarBits(cpu, 0, false), 0x4b800001n);
    assert.equal(cpu.simd.mxcsr & 63, 32);
    cpu.dispose();
  }
  for (const double of [false, true])
    for (const memory of [false, true]) {
      const { cpu, view } = machine([double ? 0xf3 : 0xf2, 0x0f, 0x5a, memory ? 0x00 : 0xc1]);
      cpu.r[0].value = DATA;
      cpu.simd.registers[0].set([0, 0x1234, 0x5678, 0x9abc]);
      setScalar(cpu, 1, !double, floatBits(1.5, !double));
      if (double) view.setFloat32(DATA, 1.5, true);
      else view.setFloat64(DATA, 1.5, true);
      await cpu.prepare(CODE);
      cpu.step(CODE);
      assert.equal(scalarBits(cpu, 0, double), floatBits(1.5, double));
      assert.deepEqual(
        lanes(cpu).slice(double ? 2 : 1),
        double ? [0x5678, 0x9abc] : [0x1234, 0x5678, 0x9abc],
      );
      cpu.dispose();
    }
});

test('scalar SSE honors DAZ, FTZ, sticky exceptions and pre-computation exception priority', async () => {
  for (const double of [false, true])
    for (const [opcode, left, right, control, expected, flags] of [
      [0x58, 1n, 1n, 0x1f80, 2n, 2],
      [0x58, 1n, 1n, 0x1fc0, 0n, 0],
      [0x59, double ? 0x10000000000000n : 0x800000n, floatBits(0.5, double), 0x9f80, 0n, 48],
      [
        0x59,
        double ? 0x8010000000000000n : 0x80800000n,
        floatBits(0.5, double),
        0x9f80,
        double ? 0x8000000000000000n : 0x80000000n,
        48,
      ],
      [0x5e, 1n, 0n, 0x1f80, floatBits(Infinity, double), 4],
      [
        0x58,
        double ? 0x7ff8000000000001n : 0x7fc00001n,
        1n,
        0x1f80,
        double ? 0x7ff8000000000001n : 0x7fc00001n,
        0,
      ],
      [
        0x58,
        double ? 0x7ff0000000000001n : 0x7f800001n,
        1n,
        0x1f80,
        double ? 0x7ff8000000000001n : 0x7fc00001n,
        1,
      ],
    ]) {
      const { cpu } = machine([double ? 0xf2 : 0xf3, 0x0f, opcode, 0xc1]);
      setScalar(cpu, 0, double, left);
      setScalar(cpu, 1, double, right);
      cpu.simd.mxcsr = control;
      await cpu.prepare(CODE);
      cpu.step(CODE);
      assert.equal(scalarBits(cpu, 0, double), expected);
      assert.equal(cpu.simd.mxcsr & 63, flags);
      cpu.dispose();
    }
  for (const [opcode, left, right, control, flags] of [
    [0x5e, 1, 0, 0x1d80, 4],
    [0x51, 0, -1, 0x1f00, 1],
    [0x58, 1, 2 ** -24, 0x0f80, 32],
    [0x59, 2 ** -126, 0.5, 0x9780, 16], // FTZ is ignored when UM is clear.
    [0x5e, 2 ** -149, 3, 0x1e80, 2], // Unmasked DE prevents UE/PE.
  ]) {
    const { cpu } = machine([0xf3, 0x0f, opcode, 0xc1]);
    setScalar(cpu, 0, false, floatBits(left, false));
    setScalar(cpu, 1, false, floatBits(right, false));
    const before = lanes(cpu);
    cpu.simd.mxcsr = control;
    await cpu.prepare(CODE);
    assert.throws(() => cpu.step(CODE), /Unmasked SIMD floating-point exception/);
    assert.deepEqual(lanes(cpu), before);
    assert.equal(cpu.simd.mxcsr & 63, flags);
    cpu.dispose();
  }
});

test('COMI/UCOMI set integer condition flags and distinguish signaling/quiet NaNs', async () => {
  for (const double of [false, true])
    for (const opcode of [0x2e, 0x2f])
      for (const [left, right, cf, zf, pf] of [
        [1, 2, 1, 0, 0],
        [2, 1, 0, 0, 0],
        [-0, 0, 0, 1, 0],
        [NaN, 1, 1, 1, 1],
      ]) {
        const { cpu } = machine([...(double ? [0x66] : []), 0x0f, opcode, 0xc1]);
        setScalar(cpu, 0, double, floatBits(left, double));
        setScalar(cpu, 1, double, floatBits(right, double));
        cpu.f = { cf: 0, zf: 0, pf: 0, sf: 1, of: 1 };
        cpu.af = 1;
        const before = lanes(cpu);
        await cpu.prepare(CODE);
        cpu.step(CODE);
        assert.deepEqual(cpu.f, { cf, zf, pf, sf: 0, of: 0 });
        assert.equal(cpu.af, 0);
        assert.deepEqual(lanes(cpu), before);
        assert.equal(cpu.simd.mxcsr & 63, Number(Number.isNaN(left) && opcode === 0x2f));
        cpu.dispose();
      }
  const { cpu } = machine([0x0f, 0x2f, 0xc1]);
  setScalar(cpu, 0, false, 0x7fc00000n);
  cpu.simd.mxcsr = 0x1f00;
  cpu.f = { cf: 1, zf: 0, pf: 0, sf: 1, of: 1 };
  cpu.af = 1;
  await cpu.prepare(CODE);
  assert.throws(() => cpu.step(CODE), /Unmasked SIMD/);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, pf: 0, sf: 1, of: 1 });
  assert.equal(cpu.af, 1);
  cpu.dispose();
});

test('MXCSR loads/stores validate reserved bits and memory faults leave scalar state untouched', async () => {
  const { cpu, view } = machine([0x0f, 0xae, 0x10, 0x0f, 0xae, 0x19]); // ldmxcsr [eax]; stmxcsr [ecx]
  cpu.r[0].value = DATA + 1;
  cpu.r[1].value = DATA + 9;
  view.setUint32(DATA + 1, 0xffc1, true);
  cpu.step(CODE);
  assert.equal(view.getUint32(DATA + 9, true), 0xffc1);
  view.setUint32(DATA + 1, 0x10000, true);
  assert.throws(() => cpu.step(CODE), /reserved bits/);
  assert.equal(cpu.simd.mxcsr, 0xffc1);
  for (const code of [
    [0x0f, 0xae, 0x10],
    [0x0f, 0xae, 0x18],
    [0xf2, 0x0f, 0x5c, 0x00],
  ]) {
    const m = machine(code, {
      check: () => {
        throw Error('denied read/write');
      },
    });
    m.cpu.simd.registers[0].set([1, 2, 3, 4]);
    const before = m.cpu.simd.snapshot();
    await m.cpu.prepare(CODE);
    assert.throws(() => m.cpu.step(CODE), /denied read\/write/);
    assert.deepEqual(m.cpu.simd.snapshot(), before);
    m.cpu.dispose();
  }
});

test('MOVAPD/MOVUPD move all 128 bits with the architectural alignment requirement', () => {
  const expected = [0x01234567, 0x7ff00000, 0x89abcdef, 0xfff80000];
  for (const aligned of [false, true]) {
    const load = aligned ? 0x28 : 0x10,
      store = aligned ? 0x29 : 0x11;
    for (const opcode of [load, store]) {
      const { cpu } = machine([0x66, 0x0f, opcode, opcode === load ? 0xc1 : 0xc8]);
      cpu.simd.registers[1].set(expected);
      cpu.step(CODE);
      assert.deepEqual(lanes(cpu), expected);
    }
    const { cpu, view } = machine([0x66, 0x0f, load, 0x00, 0x66, 0x0f, store, 0x01]);
    const address = DATA + Number(!aligned);
    cpu.r[0].value = address;
    cpu.r[1].value = address + 32;
    expected.forEach((v, n) => view.setUint32(address + n * 4, v, true));
    cpu.step(CODE);
    assert.deepEqual(lanes(cpu), expected);
    assert.deepEqual(
      expected.map((_, n) => view.getUint32(address + 32 + n * 4, true)),
      expected,
    );
    if (aligned) {
      cpu.r[0].value = DATA + 1;
      assert.throws(() => cpu.step(CODE), /16-byte alignment/);
    }
  }
});
