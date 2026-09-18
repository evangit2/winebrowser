import test from 'node:test';
import assert from 'node:assert/strict';
import { NTSTATUS, VirtualMemory, VirtualMemoryConstants as C } from '../src/virtual-memory.js';
import { GuestMemory } from '../src/memory.js';

function allocator() {
  // 736 Wasm pages cover the arena end at 0x02e00000.
  const memory = new WebAssembly.Memory({ initial: 736, maximum: 736 });
  const regions = [];
  return { memory, regions, vm: new VirtualMemory(memory, regions) };
}

const regionAt = (regions, address) =>
  regions.find(
    (region) => region.kind === 'virtual' && address >= region.start && address < region.end,
  );

test('null commit implicitly reserves; explicit reserve+commit commits the rounded prefix', () => {
  const { memory, regions, vm } = allocator();
  const guest = new GuestMemory(memory, regions);
  const implicit = vm.allocate(0, 1, C.MEM_COMMIT, C.PAGE_READWRITE);
  assert.equal(implicit.status, 0);
  guest.write32(implicit.base, 42);
  const explicit = vm.allocate(C.arenaStart + 0x11234, 8, 0x3000, C.PAGE_READWRITE);
  assert.equal(explicit.base, C.arenaStart + 0x10000);
  assert.equal(explicit.size, 0x2000);
  guest.write32(explicit.base, 17);
  assert.equal(guest.read32(explicit.base), 17);
});

test('reads span adjacent committed protections while writes cannot cross a readonly page', () => {
  const { memory, regions, vm } = allocator();
  const guest = new GuestMemory(memory, regions);
  const { base } = vm.allocate(0, 0x2000, 0x2000, C.PAGE_NOACCESS);
  vm.allocate(base, 0x1000, 0x1000, C.PAGE_READONLY);
  vm.allocate(base + 0x1000, 0x1000, 0x1000, C.PAGE_READWRITE);
  assert.equal(guest.read32(base + 0xffe), 0);
  assert.throws(() => guest.write32(base + 0xffe, 7), /write violation/);
  vm.free(base + 0x1000, 0x1000, 0x4000);
  assert.throws(() => guest.read32(base + 0xffe), /read violation/);
});

test('reserve and commit together returns a zeroed readable/writable bounded region', () => {
  const { memory, regions, vm } = allocator();
  const result = vm.allocate(0, 1, C.MEM_RESERVE | C.MEM_COMMIT, C.PAGE_READWRITE);

  assert.deepEqual(result, { status: NTSTATUS.SUCCESS, base: C.arenaStart, size: C.pageSize });
  assert.deepEqual(regionAt(regions, result.base), {
    start: result.base,
    end: result.base + C.pageSize,
    read: true,
    write: true,
    exec: false,
    kind: 'virtual',
  });
  const view = new DataView(memory.buffer);
  assert.equal(view.getUint32(result.base, true), 0);
  view.setUint32(result.base, 0x12345678, true);
  assert.equal(view.getUint32(result.base, true), 0x12345678);
});

test('reserved pages are inaccessible; committing rounds to 4 KiB and preserves existing data', () => {
  const { memory, regions, vm } = allocator();
  const requested = C.arenaStart + 0x1003;
  const reserved = vm.allocate(requested, 1, C.MEM_RESERVE, C.PAGE_NOACCESS);

  assert.deepEqual(reserved, { status: NTSTATUS.SUCCESS, base: C.arenaStart, size: 0x2000 });
  assert.equal(regionAt(regions, C.arenaStart).read, false);
  assert.equal(regionAt(regions, C.arenaStart).write, false);
  const committed = vm.allocate(requested + 0x100, 1, C.MEM_COMMIT, C.PAGE_READWRITE);
  assert.deepEqual(committed, {
    status: NTSTATUS.SUCCESS,
    base: C.arenaStart + 0x1000,
    size: C.pageSize,
  });
  assert.equal(regionAt(regions, C.arenaStart + 0x1000).write, true);
  assert.equal(regionAt(regions, C.arenaStart + 0x1fff).write, true);
  const view = new DataView(memory.buffer);
  view.setUint32(C.arenaStart + 0x1000, 0xaabbccdd, true);
  assert.equal(vm.allocate(requested, 1, C.MEM_COMMIT, C.PAGE_READWRITE).status, NTSTATUS.SUCCESS);
  assert.equal(view.getUint32(C.arenaStart + 0x1000, true), 0xaabbccdd);
});

test('decommit rounds across touched pages and recommit zeroes them', () => {
  const { memory, regions, vm } = allocator();
  const allocated = vm.allocate(0, 0x2000, C.MEM_RESERVE, C.PAGE_NOACCESS);
  const base = allocated.base;
  assert.equal(vm.allocate(base, 0x2000, C.MEM_COMMIT, C.PAGE_READONLY).status, NTSTATUS.SUCCESS);
  const view = new DataView(memory.buffer);
  view.setUint32(base, 0xdeadbeef, true);
  view.setUint32(base + 0x1000, 0xcafebabe, true);

  assert.deepEqual(vm.free(base + 0xfff, 2, C.MEM_DECOMMIT), {
    status: NTSTATUS.SUCCESS,
    base,
    size: 0x2000,
  });
  assert.equal(regionAt(regions, base).read, false);
  assert.equal(regionAt(regions, base + 0x1000).read, false);
  assert.equal(vm.allocate(base, 0x1000, C.MEM_COMMIT, C.PAGE_READWRITE).status, NTSTATUS.SUCCESS);
  assert.equal(view.getUint32(base, true), 0);
  assert.equal(view.getUint32(base + 0x1000, true), 0xcafebabe);
});

test('protect rounds touched committed pages, reports the first old protection, and retains data', () => {
  const { memory, regions, vm } = allocator();
  const guest = new GuestMemory(memory, regions);
  const { base } = vm.allocate(0, 0x3000, C.MEM_RESERVE | C.MEM_COMMIT, C.PAGE_READWRITE);
  guest.write32(base + 0xffc, 0x12345678);
  guest.write32(base + 0x1000, 0xdeadbeef);
  guest.write32(base + 0x2000, 0xcafebabe);

  assert.deepEqual(vm.protect(base + 0xfff, 2, C.PAGE_READONLY), {
    status: NTSTATUS.SUCCESS,
    base,
    size: 0x2000,
    oldProtect: C.PAGE_READWRITE,
  });
  assert.equal(guest.read32(base + 0xffc), 0x12345678);
  assert.equal(guest.read32(base + 0x1000), 0xdeadbeef);
  assert.throws(() => guest.write32(base + 0x1000, 1), /write violation/);
  guest.write32(base + 0x2000, 0xfeedface);
  assert.equal(regionAt(regions, base).write, false);
  assert.equal(regionAt(regions, base + 0x2000).write, true);

  assert.deepEqual(vm.protect(base + 0x1001, 1, C.PAGE_NOACCESS), {
    status: NTSTATUS.SUCCESS,
    base: base + 0x1000,
    size: C.pageSize,
    oldProtect: C.PAGE_READONLY,
  });
  assert.throws(() => guest.read32(base + 0x1000), /read violation/);
  assert.equal(vm.protect(base + 0x1000, 1, C.PAGE_READWRITE).oldProtect, C.PAGE_NOACCESS);
  assert.equal(guest.read32(base + 0x1000), 0xdeadbeef);
});

test('protect rejects any uncommitted page atomically and never changes other reservations', () => {
  const { memory, regions, vm } = allocator();
  const guest = new GuestMemory(memory, regions);
  const { base } = vm.allocate(0, 0x3000, C.MEM_RESERVE, C.PAGE_NOACCESS);
  vm.allocate(base, C.pageSize, C.MEM_COMMIT, C.PAGE_READONLY);
  vm.allocate(base + 0x2000, C.pageSize, C.MEM_COMMIT, C.PAGE_READWRITE);
  guest.write32(base + 0x2000, 0xaabbccdd);

  assert.deepEqual(vm.protect(base, 0x3000, C.PAGE_READWRITE), {
    status: NTSTATUS.NOT_COMMITTED,
    base,
    size: 0x3000,
  });
  assert.equal(regionAt(regions, base).write, false);
  assert.equal(regionAt(regions, base + 0x1000).read, false);
  assert.equal(regionAt(regions, base + 0x2000).write, true);
  assert.equal(guest.read32(base + 0x2000), 0xaabbccdd);

  assert.equal(
    vm.protect(base + 0x3000, 1, C.PAGE_READWRITE).status,
    NTSTATUS.MEMORY_NOT_ALLOCATED,
  );
  assert.equal(vm.protect(base, 0, C.PAGE_READWRITE).status, NTSTATUS.INVALID_PARAMETER);
  assert.equal(vm.protect(base, 1, 0x20).status, NTSTATUS.INVALID_PAGE_PROTECTION);
  assert.equal(regionAt(regions, base).write, false);
});

test('release requires exact allocation base and zero size, then permits address reuse', () => {
  const { regions, vm } = allocator();
  const allocated = vm.allocate(0, 0x2001, C.MEM_RESERVE | C.MEM_COMMIT, C.PAGE_READWRITE);
  assert.deepEqual(allocated, {
    status: NTSTATUS.SUCCESS,
    base: C.arenaStart,
    size: 0x3000,
  });

  assert.equal(
    vm.free(allocated.base + C.pageSize, 0, C.MEM_RELEASE).status,
    NTSTATUS.MEMORY_NOT_ALLOCATED,
  );
  assert.equal(vm.free(allocated.base, 1, C.MEM_RELEASE).status, NTSTATUS.MEMORY_NOT_ALLOCATED);
  assert.deepEqual(vm.free(allocated.base, 0, C.MEM_RELEASE), {
    status: NTSTATUS.SUCCESS,
    base: allocated.base,
    size: allocated.size,
  });
  assert.equal(regionAt(regions, allocated.base), undefined);
  assert.equal(vm.allocate(0, 1, C.MEM_RESERVE, C.PAGE_NOACCESS).base, allocated.base);
});

test('rejects unsupported flags, executable protections, overflow, and ranges outside the arena', () => {
  const { vm } = allocator();
  assert.equal(
    vm.allocate(0, 0, C.MEM_RESERVE, C.PAGE_READWRITE).status,
    NTSTATUS.INVALID_PARAMETER,
  );
  assert.equal(
    vm.allocate(0, 1, C.MEM_RESERVE | 0x80000, C.PAGE_READWRITE).status,
    NTSTATUS.INVALID_PARAMETER,
  );
  assert.equal(vm.allocate(0, 1, C.MEM_RESERVE, 0x20).status, NTSTATUS.INVALID_PAGE_PROTECTION);
  assert.equal(
    vm.allocate(C.arenaStart, 0x1000, C.MEM_RESERVE | C.MEM_COMMIT, 0x20).status,
    NTSTATUS.INVALID_PAGE_PROTECTION,
  );
  assert.equal(
    vm.allocate(C.arenaEnd - 1, 2, C.MEM_RESERVE, C.PAGE_READWRITE).status,
    NTSTATUS.NO_MEMORY,
  );
  assert.equal(
    vm.allocate(0xfffffff0, 0x100, C.MEM_RESERVE, C.PAGE_READWRITE).status,
    NTSTATUS.INVALID_PARAMETER,
  );
  assert.equal(
    vm.allocate(C.arenaStart, 1, C.MEM_COMMIT, C.PAGE_READWRITE).status,
    NTSTATUS.MEMORY_NOT_ALLOCATED,
  );
  assert.equal(vm.free(C.arenaStart, 1, C.MEM_DECOMMIT).status, NTSTATUS.MEMORY_NOT_ALLOCATED);
});

test('unavailable external regions and reservations prevent overlapping reservations', () => {
  const memory = new WebAssembly.Memory({ initial: 736, maximum: 736 });
  const regions = [
    { start: C.arenaStart, end: C.arenaStart + C.pageSize, read: true, write: true },
  ];
  const vm = new VirtualMemory(memory, regions);

  assert.equal(
    vm.allocate(C.arenaStart, C.pageSize, C.MEM_RESERVE, C.PAGE_READWRITE).status,
    NTSTATUS.CONFLICTING_ADDRESSES,
  );
  const first = vm.allocate(0, C.pageSize, C.MEM_RESERVE, C.PAGE_NOACCESS);
  assert.equal(first.base, C.arenaStart + C.allocationGranularity);
  assert.equal(
    vm.allocate(first.base, C.pageSize, C.MEM_RESERVE, C.PAGE_NOACCESS).status,
    NTSTATUS.CONFLICTING_ADDRESSES,
  );
});
