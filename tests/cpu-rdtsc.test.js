import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import {
  GUEST_PERFORMANCE_FREQUENCY,
  GuestPerformanceClock,
  splitGuestCounter,
} from '../src/guest-clock.js';
import { guestCpuid, guestProcessorFeaturePresent } from '../src/processor-features.js';

const CODE = 0x1000;

function machine(performanceCounter) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set([0x0f, 0x31], CODE);
  const view = new DataView(memory.buffer);
  return new CPU(iced, {
    memory,
    read32: (address) => view.getUint32(address, true),
    write32: (address, value) => view.setUint32(address, value, true),
    executableRanges: [[CODE, CODE + 2]],
    performanceCounter,
  });
}

test('RDTSC returns unsigned virtual nanosecond ticks in EDX:EAX', () => {
  const samples = [0x00000001ffffffffn, 0x0000000200000001n];
  const cpu = machine(() => samples.shift());
  cpu.step(CODE);
  assert.equal(cpu.r[2].value >>> 0, 1);
  assert.equal(cpu.r[0].value >>> 0, 0xffffffff);
  cpu.step(CODE);
  assert.equal(cpu.r[2].value >>> 0, 2);
  assert.equal(cpu.r[0].value >>> 0, 1);
  assert.equal(GUEST_PERFORMANCE_FREQUENCY, 1_000_000_000n);
});

test('RDTSC wraps its architectural 64-bit output without changing flags or other registers', () => {
  const samples = [0xffffffffffffffffn, 0x10000000000000000n];
  const cpu = machine(() => samples.shift());
  const preserved = [0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00, 0x13579bdf, 0x2468ace0];
  cpu.r[1].value = preserved[0];
  preserved.slice(1).forEach((value, index) => {
    cpu.r[index + 3].value = value;
  });
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
  cpu.af = 1;
  cpu.step(CODE);
  assert.deepEqual([cpu.r[2].value >>> 0, cpu.r[0].value >>> 0], [0xffffffff, 0xffffffff]);
  cpu.step(CODE);
  assert.deepEqual([cpu.r[2].value >>> 0, cpu.r[0].value >>> 0], [0, 0]);
  assert.equal(cpu.r[1].value >>> 0, preserved[0]);
  preserved.slice(1).forEach((value, index) => assert.equal(cpu.r[index + 3].value >>> 0, value));
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
  assert.equal(cpu.af, 1);
});

test('guest clock clamps a regressing source and counter splitting is unsigned', () => {
  const samples = [2n, 1n, 3n];
  const clock = new GuestPerformanceClock(() => samples.shift());
  assert.deepEqual([clock.read(), clock.read(), clock.read()], [2n, 2n, 3n]);
  assert.deepEqual(splitGuestCounter(-1n), { low: 0xffffffff, high: 0xffffffff });
});

test('CPUID and Windows feature reporting advertise the implemented virtual timestamp counter', () => {
  assert.equal(guestProcessorFeaturePresent(8), 1);
  assert.notEqual(guestCpuid(1).edx & (1 << 4), 0);
});
