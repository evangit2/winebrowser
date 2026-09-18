import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { protectMemory } from '../src/memory-protection.js';
import { ntServices } from '../src/wine-nt.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const createRuntime = () =>
  new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
const IMAGE = 0x01800000;
function dataImage(r) {
  r.regions.push(
    {
      start: IMAGE,
      end: IMAGE + 0x6000,
      module: 'test-data.dll',
      kind: 'image-reservation',
      read: false,
      write: false,
      exec: false,
    },
    {
      start: IMAGE,
      end: IMAGE + 0x1000,
      module: 'test-data.dll',
      read: true,
      write: false,
      exec: true,
    },
    {
      start: IMAGE + 0x1000,
      end: IMAGE + 0x5000,
      module: 'test-data.dll',
      read: true,
      write: false,
      exec: false,
    },
  );
}
function nativeCall(r, base, size, protect, { process = 0xffffffff, old } = {}) {
  const pointers = r.allocate(12);
  const oldPointer = old ?? pointers + 8;
  r.write32(pointers, base);
  r.write32(pointers + 4, size);
  const args = [process, pointers, pointers + 4, protect, oldPointer];
  const status = ntServices.NtProtectVirtualMemory.call(r, (i) => args[i]);
  return {
    status,
    base: r.read32(pointers),
    size: r.read32(pointers + 4),
    oldProtect: r.read32(pointers + 8),
  };
}

test('NT image-data protection rounds pages, preserves neighbors and restores read-only access', () => {
  const r = createRuntime();
  dataImage(r);
  const address = IMAGE + 0x2010;
  assert.throws(() => r.write32(address, 42), /write violation/);
  assert.deepEqual(nativeCall(r, address, 4, 4), {
    status: 0,
    base: IMAGE + 0x2000,
    size: 0x1000,
    oldProtect: 2,
  });
  r.write32(address, 42);
  assert.throws(() => r.write32(IMAGE + 0x1ffc, 0), /write violation/);
  assert.throws(() => r.write32(IMAGE + 0x3000, 0), /write violation/);
  assert.deepEqual(nativeCall(r, address, 4, 2), {
    status: 0,
    base: IMAGE + 0x2000,
    size: 0x1000,
    oldProtect: 4,
  });
  assert.equal(r.read32(address), 42);
  assert.throws(() => r.write32(address, 0), /write violation/);
  assert.equal(nativeCall(r, address, 4, 1).status, 0);
  assert.throws(() => r.read32(address), /read violation/);
  assert.equal(nativeCall(r, address, 4, 2).oldProtect, 1);
  assert.equal(r.read32(address), 42);
});

test('NT private VM protection shares allocator state and never commits reserved pages', () => {
  const r = createRuntime();
  const { base } = r.virtualMemory.allocate(0, 0x3000, 0x2000, 4);
  r.virtualMemory.allocate(base, 0x1000, 0x1000, 4);
  r.write32(base + 4, 77);
  const before = [...r.virtualMemory.reservations.get(base).pages];
  assert.equal(nativeCall(r, base, 0x2000, 2).status, 0xc000002d);
  assert.deepEqual([...r.virtualMemory.reservations.get(base).pages], before);
  r.write32(base + 4, 78);
  assert.equal(nativeCall(r, base + 1, 4, 2).status, 0);
  assert.throws(() => r.write32(base + 4, 0), /write violation/);
  assert.equal(r.read32(base + 4), 78);
  assert.equal(r.virtualMemory.reservations.get(base).pages.get(base), 2);
});

test('image code, gaps, cross-image ranges and immutable section views fail without granting access', () => {
  const r = createRuntime();
  dataImage(r);
  const before = structuredClone(r.regions);
  for (const [base, size, mode, status] of [
    [IMAGE + 10, 4, 4, 0xc00000bb],
    [IMAGE + 0x5000, 4, 4, 0xc000002d],
    [IMAGE + 0x4000, 0x2001, 4, 0xc00000bb],
    [IMAGE + 0x1000, 4, 0x40, 0xc0000045],
    [IMAGE + 0x1000, 0, 4, 0xc000000d],
    [0xffffffff, 2, 4, 0xc000000d],
  ])
    assert.equal(protectMemory(r, base, size, mode).status, status);
  assert.deepEqual(r.regions, before);
  const mapped = r.sectionViews.map(new Uint8Array([1, 2, 3]));
  assert.equal(protectMemory(r, mapped.base, 1, 4).status, 0xc00000bb);
  assert.throws(() => r.write32(mapped.base, 0), /write violation/);
  assert.equal(r.data[mapped.base], 1);
});

test('NT protection validates all output pointers and process handles before changing access', () => {
  const r = createRuntime();
  dataImage(r);
  assert.equal(nativeCall(r, IMAGE + 0x1000, 4, 4, { old: 0 }).status, 0xc0000005);
  assert.equal(nativeCall(r, IMAGE + 0x1000, 4, 4, { process: 0 }).status, 0xc0000008);
  assert.throws(() => r.write32(IMAGE + 0x1000, 0), /write violation/);
  const p = r.allocate(12);
  for (const args of [
    [0xffffffff, 0, p + 4, 4, p + 8],
    [0xffffffff, p, 0, 4, p + 8],
  ])
    assert.equal(
      ntServices.NtProtectVirtualMemory.call(r, (i) => args[i]),
      0xc0000005,
    );
});

test('output parameters on a newly protected page are rejected before mutation', () => {
  const r = createRuntime();
  dataImage(r);
  assert.equal(protectMemory(r, IMAGE + 0x1000, 1, 4).status, 0);
  const pointer = IMAGE + 0x1100;
  r.write32(pointer, IMAGE + 0x1000);
  r.write32(pointer + 4, 1);
  const args = [0xffffffff, pointer, pointer + 4, 2, pointer + 8];
  assert.equal(
    ntServices.NtProtectVirtualMemory.call(r, (i) => args[i]),
    0xc00000bb,
  );
  r.write32(pointer + 12, 9);
  assert.equal(r.read32(pointer), IMAGE + 0x1000);
});
