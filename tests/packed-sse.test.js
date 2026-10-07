import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { Runtime } from '../src/runtime.js';

const CODE = 0x1000,
  DATA = 0x2000;
function machine(code, check) {
  const memory = new WebAssembly.Memory({ initial: 1 }),
    data = new Uint8Array(memory.buffer),
    v = new DataView(memory.buffer);
  data.set(code, CODE);
  const cpu = new CPU(iced, {
    memory,
    read32: (a) => v.getUint32(a, true),
    write32: (a, n) => v.setUint32(a, n, true),
    read: (a, w) =>
      w === 1 ? v.getUint8(a) : w === 2 ? v.getUint16(a, true) : v.getUint32(a, true),
    write: (a, n, w) =>
      w === 1 ? v.setUint8(a, n) : w === 2 ? v.setUint16(a, n, true) : v.setUint32(a, n, true),
    check:
      check ??
      ((a, n) => {
        if (a + n > 65536) throw Error('range denied');
        return a;
      }),
    executableRanges: [[CODE, CODE + code.length]],
  });
  return { cpu, data, v };
}
const words = (cpu) => Array.from(cpu.simd.registers[0]);
test('8,400 native SSE/SSE2 register/memory answers and MXCSR flags match independent native execution', async () => {
  const exe = new Uint8Array(
    await readFile(new URL('./fixtures/packed-sse/packed-sse.exe', import.meta.url)),
  );
  const oracle = await readFile(
    new URL('./fixtures/packed-sse/native-oracle.bin', import.meta.url),
  );
  assert.equal(oracle.length, 8400 * 24);
  const r = new Runtime(iced, {
    files: new Map([['packed-sse.exe', exe]]),
    exe: 'packed-sse.exe',
    maxBlocks: 10000000,
  });
  try {
    const out = await r.run();
    assert.equal(out.exitCode, 0);
    const actual = Buffer.from(out.outputs.find((f) => f.path === 'packed-sse-results.bin').bytes);
    assert.equal(actual.length, oracle.length);
    for (let offset = 0; offset < oracle.length; offset += 24)
      assert.ok(
        actual.subarray(offset, offset + 24).equals(oracle.subarray(offset, offset + 24)),
        `record ${offset / 24}: native ${oracle.subarray(offset, offset + 24).toString('hex')}, browser ${actual.subarray(offset, offset + 24).toString('hex')}`,
      );
  } finally {
    r.cpu.dispose();
  }
});
test('packed exceptions from later lanes preserve the full destination and aggregate pre-computation flags', async () => {
  const { cpu } = machine([0x0f, 0x59, 0xc1]);
  const a = [0x7f7fffff, 0, 0x3f800000, 1];
  cpu.simd.registers[0].set(a);
  cpu.simd.registers[1].set([0x40000000, 0x7f800000, 0x3f000000, 0x3f800000]);
  cpu.simd.mxcsr = 0x1f00;
  const flags = { ...cpu.f };
  await cpu.prepare(CODE);
  assert.throws(() => cpu.step(CODE), /Unmasked SIMD.*invalid/);
  assert.deepEqual(words(cpu), a);
  assert.deepEqual(cpu.f, flags);
  assert.equal(cpu.simd.mxcsr & 63, 3);
  cpu.dispose();
});
test('packed arithmetic rejects misalignment and complete-range faults before any destination/MXCSR mutation', async () => {
  for (const misaligned of [false, true]) {
    const { cpu } = machine([0x0f, 0x58, 0x00], (a, n) => {
      if (!misaligned && a === DATA && n === 16) throw Error('whole vector denied');
      return a;
    });
    cpu.r[0].value = DATA + Number(misaligned);
    cpu.simd.registers[0].set([1, 2, 3, 4]);
    const csr = cpu.simd.mxcsr;
    await cpu.prepare(CODE);
    assert.throws(() => cpu.step(CODE), misaligned ? /alignment/ : /whole vector denied/);
    assert.deepEqual(words(cpu), [1, 2, 3, 4]);
    assert.equal(cpu.simd.mxcsr, csr);
    cpu.dispose();
  }
});
test('64-bit source memory conversions allow unaligned input and zero unused destination lanes', async () => {
  const { cpu, v } = machine([0xf3, 0x0f, 0xe6, 0x00]); // CVTDQ2PD xmm0,[eax]
  cpu.r[0].value = DATA + 1;
  v.setInt32(DATA + 1, -1, true);
  v.setInt32(DATA + 5, 0x7fffffff, true);
  cpu.simd.registers[0].fill(0xffffffff);
  await cpu.prepare(CODE);
  cpu.step(CODE);
  assert.deepEqual(words(cpu), [0, 0xbff00000, 0xffc00000, 0x41dfffff]);
  cpu.dispose();
});
test('packed word/dword shift counts saturate and use the complete low 64-bit source, including aliases', () => {
  for (const width of [16, 32])
    for (const kind of [0, 1, 2])
      for (const count of [0n, 1n, 15n, 16n, 31n, 32n, 255n, 256n, 1n << 32n]) {
        const opcode = (width === 16 ? [0xf1, 0xd1, 0xe1] : [0xf2, 0xd2, 0xe2])[kind];
        const { cpu } = machine([0x66, 0x0f, opcode, 0xc1]);
        const input = [0x80000001, 0xfffe7fff, 0x7fff8000, 0xffffffff];
        cpu.simd.registers[0].set(input);
        cpu.simd.registers[1].set([
          Number(count & 0xffffffffn),
          Number(count >> 32n),
          0xffffffff,
          0xffffffff,
        ]);
        const f = { ...cpu.f },
          csr = cpu.simd.mxcsr;
        const bitwidth = BigInt(width),
          mask = (1n << bitwidth) - 1n;
        let expected = 0n;
        for (let i = 0; i < 128 / width; i++) {
          const raw =
            (BigInt(input[Math.floor((i * width) / 32)]) >> BigInt((i * width) % 32)) & mask;
          const signed = raw & (1n << (bitwidth - 1n)) ? raw - (1n << bitwidth) : raw;
          const result =
            count >= bitwidth
              ? kind === 2 && signed < 0n
                ? mask
                : 0n
              : kind === 0
                ? raw << count
                : kind === 1
                  ? raw >> count
                  : signed >> count;
          expected |= (result & mask) << BigInt(i * width);
        }
        cpu.step(CODE);
        assert.deepEqual(
          words(cpu),
          Array.from({ length: 4 }, (_, i) => Number((expected >> BigInt(32 * i)) & 0xffffffffn)),
        );
        assert.deepEqual(cpu.f, f);
        assert.equal(cpu.simd.mxcsr, csr);
        cpu.dispose();
      }
  const { cpu } = machine([0x66, 0x0f, 0xf2, 0xc0]);
  cpu.simd.registers[0].set([1, 0, 0x80000001, 0xffffffff]);
  cpu.step(CODE);
  assert.deepEqual(words(cpu), [2, 0, 2, 0xfffffffe]);
  cpu.dispose();
});
test('shuffles/unpacks read old aliased operands and MOVMSK extracts raw sign bits into GPRs', () => {
  for (const [code, expected] of [
    [
      [0x0f, 0xc6, 0xc0, 0x1b],
      [4, 3, 2, 1],
    ],
    [
      [0x0f, 0x15, 0xc0],
      [3, 3, 4, 4],
    ],
    [
      [0x66, 0x0f, 0xc6, 0xc0, 1],
      [3, 4, 1, 2],
    ],
  ]) {
    const { cpu } = machine(code);
    cpu.simd.registers[0].set([1, 2, 3, 4]);
    cpu.step(CODE);
    assert.deepEqual(words(cpu), expected);
    cpu.dispose();
  }
  for (const prefix of [[], [0x66]]) {
    const { cpu } = machine([...prefix, 0x0f, 0x50, 0xc0]);
    cpu.simd.registers[0].set([0x80000000, 0x7fc00001, 0, 0xfff80000]);
    cpu.step(CODE);
    assert.equal(cpu.r[0].value, prefix.length ? 2 : 9);
    cpu.dispose();
  }
});
