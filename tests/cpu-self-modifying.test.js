import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { GuestMemory } from '../src/memory.js';

function machine(writable = true, { pages = 1, codeEnd = 0x8000 } = {}) {
  const memory = new WebAssembly.Memory({ initial: pages });
  const memoryEnd = pages * 0x10000;
  let cpu;
  const guest = new GuestMemory(
    memory,
    [
      { start: 0x1000, end: codeEnd, exec: true, write: writable },
      { start: codeEnd, end: memoryEnd, write: true },
    ],
    {
      onCodeWrite: (address, size) => cpu.invalidateRange(address, size),
    },
  );
  cpu = new CPU(iced, {
    memory,
    executableRanges: [[0x1000, codeEnd, writable]],
    stackTop: memoryEnd - 0x1000,
    read32: (a) => guest.read32(a),
    write32: (a, v) => guest.write32(a, v),
    read: (a, w) => guest.read(a, w),
    write: (a, v, w) => guest.write(a, v, w),
    check: (a, n, write) => guest.check(a, n, write),
  });
  return { cpu, guest };
}

test('writable x86 code is decoded after a store replaces the following instruction', () => {
  const { cpu, guest } = machine();
  // mov byte [0x1007],0xb8; <invalid old instruction>; immediate 42; jmp next
  guest.data.set([0xc6, 0x05, 7, 0x10, 0, 0, 0xb8, 0x0f, 42, 0, 0, 0, 0xeb, 0], 0x1000);
  assert.equal(cpu.step(0x1000), 0x1007);
  assert.equal(cpu.step(0x1007), 0x100e);
  assert.equal(cpu.r[0].value, 42);
});

test('code writes invalidate overlapping cached blocks but preserve unrelated blocks', () => {
  const { cpu, guest } = machine();
  guest.data.set([0xb8, 1, 0, 0, 0, 0xeb, 0], 0x1100);
  guest.data.set([0xb8, 2, 0, 0, 0, 0xeb, 0], 0x1200);
  cpu.step(0x1100);
  cpu.step(0x1200);
  const kept = cpu.cache.get(0x1200);
  guest.write32(0x1101, 42);
  assert.equal(cpu.cache.has(0x1100), false);
  assert.equal(cpu.cache.get(0x1200), kept);
  cpu.step(0x1100);
  assert.equal(cpu.r[0].value, 42);
  guest.write32(0x8000, 13);
  assert.equal(cpu.cache.size, 2);
});

test('writes to a trailing page evict a block that started on the preceding page', () => {
  const { cpu, guest } = machine();
  guest.data.set([0xb8, 1, 0, 0, 0, 0xeb, 0], 0x1ffd);
  cpu.step(0x1ffd);
  guest.write(0x2000, 1, 1);
  assert.equal(cpu.cache.has(0x1ffd), false);
  assert.equal(cpu.cachePages.size, 0);
  cpu.step(0x1ffd);
  assert.equal(cpu.r[0].value, 0x10001);
});

test('read-only code still rejects writes and retains its compiled block', () => {
  const { cpu, guest } = machine(false);
  guest.data.set([0xb8, 1, 0, 0, 0, 0xeb, 0], 0x1000);
  cpu.step(0x1000);
  const block = cpu.cache.get(0x1000);
  assert.throws(() => guest.write32(0x1001, 2), /write violation/);
  assert.equal(cpu.cache.get(0x1000), block);
  cpu.step(0x1000);
  assert.equal(cpu.r[0].value, 1);
});

test('the bounded block cache evicts old translations and can recompile them', (t) => {
  const { cpu, guest } = machine(false, { pages: 8, codeEnd: 0x78000 });
  const limit = cpu.cacheLimit;
  assert.ok(limit > 4096, 'the translation cache must exceed the packed-image working set');
  for (let i = 0; i < limit + 1; i++) {
    const address = 0x1000 + i * 4;
    guest.data.set([0xb0, i & 255, 0xeb, 0], address);
    cpu.step(address);
  }
  assert.equal(cpu.cache.size, limit);
  assert.equal(cpu.cache.has(0x1000), false);
  assert.equal(cpu.step(0x1000), 0x1004);
  assert.equal(cpu.r[0].value, 0);
  assert.equal(cpu.cache.size, limit);
  cpu.clearCache();
  assert.equal(cpu.cachePages.size, 0);
});

test('a repeatedly used block is never recompiled by cache churn', () => {
  const { cpu, guest } = machine(false, { pages: 8, codeEnd: 0x78000 });
  const limit = cpu.cacheLimit;
  const address = (i) => 0x1000 + i * 4;
  const put = (i) => {
    guest.data.set([0xb0, i & 255, 0xeb, 0], address(i));
    cpu.step(address(i));
  };
  // Two hot blocks alternate with heavy churn. Second-chance eviction must
  // keep the referenced hot blocks resident while clearing the reference bit
  // of everything else, so their compilation count stays at exactly one.
  put(0);
  put(1);
  const hotCompilations = () => {
    // Recompile counters are global; compare against a baseline captured after
    // the hot blocks were first compiled.
    return cpu.compilations;
  };
  const baseline = hotCompilations();
  for (let round = 0; round < limit * 3; round++) {
    cpu.step(address(round % 2));
    put(2 + round);
  }
  assert.equal(cpu.cache.has(address(0)), true, 'first hot block survives');
  assert.equal(cpu.cache.has(address(1)), true, 'second hot block survives');
  // Hot hits never compile, so the churn compiles about one block per round.
  // At most one extra compile can come from a page-boundary invalidation; any
  // more would mean eviction pressure is recompiling resident hot blocks.
  const churnCompilations = cpu.compilations - baseline;
  assert.ok(
    churnCompilations >= limit * 3 && churnCompilations <= limit * 3 + 2,
    `hot blocks recompiled by eviction: ${churnCompilations} compilations`,
  );
  assert.equal(cpu.cache.size, limit);
});

test('the block cache gives a second chance to recently referenced blocks', () => {
  const { cpu, guest } = machine(false, { pages: 8, codeEnd: 0x78000 });
  const limit = cpu.cacheLimit;
  const address = (i) => 0x1000 + i * 4;
  const put = (i) => {
    guest.data.set([0xb0, i & 255, 0xeb, 0], address(i));
    cpu.step(address(i));
  };
  // Fill the cache, then keep re-touching block 0 so it stays hot while the
  // remaining capacity churns. A FIFO cache would evict it; second-chance
  // eviction must retain it because its reference bit is refreshed on access.
  for (let i = 0; i < limit; i++) put(i);
  const rounds = limit * 2;
  for (let round = 0; round < rounds; round++) {
    cpu.step(address(0));
    put(limit + round);
  }
  assert.equal(cpu.cache.has(address(0)), true, 'hot block survives churn');
  // A block that was not touched after insertion is the eviction victim.
  assert.equal(cpu.cache.has(address(1)), false);
  assert.equal(cpu.cache.size, limit);
  // One compilation per distinct block plus the reload after the in-place
  // rewrite of each new block: nothing is recompiled because it was evicted.
  assert.ok(
    cpu.compilations <= limit + rounds + 2,
    `unexpected recompilation: ${cpu.compilations} for ${limit + rounds} blocks`,
  );
});

test('writable code keeps a block across memory reads but stops at a memory write', () => {
  const { cpu, guest } = machine();
  // mov eax,[0x9000] ; add eax,1 ; mov [0x9004],eax ; mov ebx,7
  // A read cannot alter following code, so the block may include it; the store
  // can, so the block must end there and the following instruction is decoded
  // after the store completes.
  guest.data.set(
    [0x8b, 0x05, 0x00, 0x90, 0x00, 0x00, 0x83, 0xc0, 0x01, 0xa3, 0x04, 0x90, 0x00, 0x00, 0xbb],
    0x1300,
  );
  guest.data.set([0xbb, 7, 0, 0, 0, 0xeb, 0], 0x130e);
  // The block starting at 0x1300 must stop at the store, not run past it.
  const next = cpu.step(0x1300);
  assert.equal(next, 0x130e, 'block ends at the memory write');
  assert.equal(cpu.r[0].value, 1);
  assert.equal(cpu.r[3].value, 0, 'following instruction is not part of the block');
  assert.equal(cpu.step(0x130e), 0x1315);
  assert.equal(cpu.r[3].value, 7);
});

test('a bulk memory write invalidates the translated blocks it overwrites', () => {
  const { cpu, guest } = machine();
  // A block that a packed image decrypts in place: memcpy/memmove/memset reach
  // the destination through the linear buffer, so they must apply the same
  // code-write rule a single store does or the stale translation keeps running.
  guest.data.set([0xb8, 1, 0, 0, 0, 0xeb, 0], 0x1100);
  cpu.step(0x1100);
  assert.equal(cpu.r[0].value, 1);
  assert.equal(cpu.cache.has(0x1100), true);

  guest.noteCodeWrite(0x1100, 6);
  assert.equal(cpu.cache.has(0x1100), false, 'bulk write invalidates the block');

  // The same rule is independent of the destination: a bulk write outside
  // executable memory must not disturb cached blocks.
  guest.data.set([0xb8, 2, 0, 0, 0, 0xeb, 0], 0x1100);
  cpu.step(0x1100);
  const kept = cpu.cache.get(0x1100);
  const before = cpu.compilations;
  guest.noteCodeWrite(0x8000, 16);
  assert.equal(cpu.cache.get(0x1100), kept);
  assert.equal(cpu.compilations, before);
});
