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

test('NtQueryVirtualMemory reports commit, reserve, free and image regions', async () => {
  const { ntServices } = await import('../src/wine-nt.js');
  const query = ntServices.NtQueryVirtualMemory;
  assert.ok(query, 'NtQueryVirtualMemory is not implemented');
  const writes = [];
  const regions = [
    { start: 0x1000, end: 0x3000, read: true, write: true, exec: false, kind: 'image' },
  ];
  const reservations = new Map([
    [
      0x5000000,
      {
        base: 0x5000000,
        end: 0x5003000,
        // First page reserved only, later pages committed read-only.
        pages: new Map([
          [0x5000000, null],
          [0x5001000, 2],
          [0x5002000, 2],
        ]),
      },
    ],
  ]);
  const runtime = {
    regions,
    virtualMemory: { reservations },
    check: (p, n) => p + n <= 0x10000000,
    read32: (p) => 0,
    write32: (p, value) => writes.push([p, value >>> 0]),
    data: { fill: () => {} },
  };
  const call = (args) => query.call(runtime, (i) => args[i] ?? 0);
  const buffer = 0x100000;
  const sizeOut = 0x100100;
  // A reserved-but-uncommitted page.
  writes.length = 0;
  assert.equal(call([0xffffffff, 0x5000000, 0, buffer, 28, sizeOut]), 0);
  const reserved = new Map(writes);
  assert.equal(reserved.get(buffer), 0x5000000);
  assert.equal(reserved.get(buffer + 12), 0x1000, 'region size is one page');
  assert.equal(reserved.get(buffer + 16), 0x2000, 'MEM_RESERVE');
  assert.equal(reserved.get(buffer + 20), 1, 'PAGE_NOACCESS');
  assert.equal(reserved.get(buffer + 24), 0x20000, 'MEM_PRIVATE');
  // A committed page, whose run covers both committed pages.
  writes.length = 0;
  assert.equal(call([0xffffffff, 0x5001000, 0, buffer, 28, sizeOut]), 0);
  const committed = new Map(writes);
  assert.equal(committed.get(buffer + 12), 0x2000, 'two identical pages form one run');
  assert.equal(committed.get(buffer + 16), 0x1000, 'MEM_COMMIT');
  assert.equal(committed.get(buffer + 20), 2, 'the recorded protection');
  assert.equal(committed.get(buffer + 4), 0x5000000, 'allocation base');
  assert.equal(new Map(writes).get(sizeOut), 28);
  // A mapped image region.
  writes.length = 0;
  assert.equal(call([0xffffffff, 0x1000, 0, buffer, 28, sizeOut]), 0);
  const image = new Map(writes);
  assert.equal(image.get(buffer + 16), 0x1000);
  assert.equal(image.get(buffer + 24), 0x1000000, 'MEM_IMAGE');
  // Free space, an unknown information class, a short buffer and a bad handle.
  writes.length = 0;
  assert.equal(call([0xffffffff, 0x9000000, 0, buffer, 28, sizeOut]), 0);
  assert.equal(new Map(writes).get(buffer + 16), 0x10000, 'MEM_FREE');
  assert.equal(call([0xffffffff, 0x1000, 1, buffer, 28, sizeOut]), 0xc0000003);
  assert.equal(call([0xffffffff, 0x1000, 0, buffer, 4, sizeOut]), 0xc0000004);
  assert.equal(call([0x1234, 0x1000, 0, buffer, 28, sizeOut]), 0xc0000008);
  assert.equal(call([0xffffffff, 0x1000, 0, 0, 28, 0]), 0xc0000005);
});
