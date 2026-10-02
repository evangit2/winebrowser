import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

function machine(bytes, writable = false) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(bytes, 0x1000);
  const view = new DataView(memory.buffer);
  let ticks = 0;
  const cpu = new CPU(iced, {
    memory,
    read32: (a) => view.getUint32(a, true),
    write32: (a, v) => view.setUint32(a, v, true),
    executableRanges: [[0x1000, 0x1000 + bytes.length, writable]],
    translationClock: () => ticks++ * 7,
  });
  return cpu;
}

test('translation time excludes cache hits and accumulates after invalidation', () => {
  const cpu = machine([0xb8, 42, 0, 0, 0, 0xeb, 0xf9]);
  try {
    cpu.step(0x1000);
    assert.equal(cpu.translationMs, 7);
    assert.equal(cpu.compilations, 1);
    for (let i = 0; i < 20; i++) cpu.step(0x1000);
    assert.equal(cpu.translationMs, 7);
    cpu.invalidateRange(0x1000, 1);
    cpu.step(0x1000);
    assert.equal(cpu.translationMs, 14);
    assert.equal(cpu.compilations, 2);
  } finally {
    cpu.dispose();
  }
});

test('translation time includes failures and counts a writable fallback only once', () => {
  // Store before an unsupported instruction: the writable fallback ends at
  // that store and avoids compiling the still encrypted trailing instruction.
  const cpu = machine([0x89, 0x01, 0x0f, 0x0b], true);
  try {
    const block = cpu.compile(0x1000);
    assert.equal(block.count, 1);
    assert.equal(cpu.translationMs, 7);
    assert.equal(cpu.compilations, 1);
    assert.throws(() => cpu.compile(0x1002), /Unsupported instruction/);
    assert.equal(cpu.translationMs, 14);
    assert.equal(cpu.compilations, 1);
  } finally {
    cpu.dispose();
  }
});
