import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { GUEST_CPUID, guestCpuid } from '../src/processor-features.js';

const CODE = 0x1000;

function machine() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set([0x0f, 0xa2], CODE);
  const view = new DataView(memory.buffer);
  return new CPU(iced, {
    memory,
    read32: (address) => view.getUint32(address, true),
    write32: (address, value) => view.setUint32(address, value, true),
    executableRanges: [[CODE, CODE + 2]],
  });
}

function execute(cpu, leaf, subleaf = 0) {
  cpu.r[0].value = leaf;
  cpu.r[1].value = subleaf;
  cpu.step(CODE);
  return {
    eax: cpu.r[0].value >>> 0,
    ebx: cpu.r[3].value >>> 0,
    ecx: cpu.r[1].value >>> 0,
    edx: cpu.r[2].value >>> 0,
  };
}

function vendor(registers) {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, registers.ebx, true);
  view.setUint32(4, registers.edx, true);
  view.setUint32(8, registers.ecx, true);
  return new TextDecoder().decode(bytes);
}

test('CPUID leaf zero exposes only the stable guest vendor and supported leaf ceiling', () => {
  const cpu = machine();
  const registers = execute(cpu, 0, 0xdeadbeef);
  assert.equal(registers.eax, 1);
  assert.equal(vendor(registers), GUEST_CPUID.vendor);
  assert.deepEqual(registers, guestCpuid(0));
});

test('CPUID leaf one reports one conservative i386 processor without optional families', () => {
  const cpu = machine();
  const registers = execute(cpu, 1);
  assert.deepEqual(registers, {
    eax: 0x543,
    ebx: 0x00010000,
    ecx: 0,
    edx: 1 << 4,
  });
  const forbiddenEdx = (1 << 23) | (1 << 25) | (1 << 26) | (1 << 28); // MMX/SSE/SSE2/HTT
  assert.equal(registers.edx & forbiddenEdx, 0);
});

test('CPUID extended ceiling and unsupported leaves return deterministic zero data', () => {
  const cpu = machine();
  assert.deepEqual(execute(cpu, 0x80000000), {
    eax: 0x80000000,
    ebx: 0,
    ecx: 0,
    edx: 0,
  });
  for (const leaf of [2, 7, 0x80000001, 0xffffffff])
    assert.deepEqual(execute(cpu, leaf, 9), { eax: 0, ebx: 0, ecx: 0, edx: 0 });
});

test('CPUID changes only EAX/EBX/ECX/EDX and preserves flags', () => {
  const cpu = machine();
  const preserved = [0x44556677, 0x8899aabb, 0xccddeeff, 0x10203040];
  preserved.forEach((value, index) => {
    cpu.r[index + 4].value = value;
  });
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
  cpu.af = 1;
  execute(cpu, 1);
  preserved.forEach((value, index) => assert.equal(cpu.r[index + 4].value >>> 0, value));
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
  assert.equal(cpu.af, 1);
});
